import { ackMessage, challengeMessage, checkBlock, signText } from './crypto.js';
import type { PlugTransport } from './transport.js';
import type { ShiftBlock } from './types.js';

export type StepKey = 'connect' | 'challenge' | 'response' | 'burst' | 'verify' | 'store' | 'ack';
export interface StepEvent { key: StepKey; state: 'run' | 'ok' | 'bad' | 'skip'; ms: number; detail?: string }
export interface BurstDeps {
  transport: PlugTransport; plugId: string; officerId: string; officerPriv: JsonWebKey;
  plugPub: JsonWebKey; lastHash: string;
  /** Must commit verified blocks AND their outbox rows (and a tamper alert) in the local DB before returning. */
  save(good: ShiftBlock[], tamper: { seq: number; reason: string } | null): Promise<void>;
  onStep?(e: StepEvent): void; onTrace?(line: string, ms: number): void;
  now?(): number;
}
export interface BurstResult { ok: boolean; count: number; totalMs: number; within2s: boolean; tamperSeq?: number; reason?: string }

export async function runBurstSync(d: BurstDeps): Promise<BurstResult> {
  const now = d.now ?? (() => performance.now());
  const t0 = now(); const T = () => Math.round(now() - t0);
  const step = (key: StepKey, state: StepEvent['state'], detail?: string) => d.onStep?.({ key, state, ms: T(), detail });
  const trace = (s: string) => d.onTrace?.(s, T());
  const fail = (key: StepKey, reason: string): BurstResult => { step(key, 'bad', reason); trace('ABORT: ' + reason); d.transport.disconnect(); const ms = T(); return { ok: false, count: 0, totalMs: ms, within2s: ms <= 2000, reason }; };
  try {
    step('connect', 'run'); await d.transport.connect(); step('connect', 'ok'); trace('connected, services 0xFF01 / 0xFF02 found');
    step('challenge', 'run'); const ch = await d.transport.readChallenge(); step('challenge', 'ok'); trace('READ 0xFF02 challenge ' + ch.slice(0, 8) + '…');
    step('response', 'run');
    const sig = await signText(d.officerPriv, challengeMessage(ch, d.plugId, d.officerId));
    trace('WRITE 0xFF02 signed response');
    if (!(await d.transport.writeAuth(d.officerId, sig))) return fail('response', 'plug refused the credential');
    step('response', 'ok'); trace('plug accepted ' + d.officerId);
    step('burst', 'run');
    const blocks = await d.transport.readBurst(b => trace('NOTIFY 0xFF01 block ' + b.seq));
    step('burst', 'ok', blocks.length + ' block(s)');
    if (!blocks.length) { (['verify', 'store', 'ack'] as StepKey[]).forEach(k => step(k, 'skip')); d.transport.disconnect(); const ms = T(); return { ok: true, count: 0, totalMs: ms, within2s: ms <= 2000 }; }
    step('verify', 'run');
    const good: ShiftBlock[] = []; let tamper: { seq: number; reason: string } | null = null; let prev = d.lastHash;
    for (const b of blocks) {
      const c = await checkBlock(b, prev, d.plugPub);
      if (!c.ok) { tamper = { seq: b.seq, reason: c.reason }; break; }
      good.push(b); prev = b.hash;
    }
    step('verify', tamper ? 'bad' : 'ok', tamper ? `block ${tamper.seq}: ${tamper.reason}` : `${good.length} verified`);
    step('store', 'run'); await d.save(good, tamper); step('store', 'ok', `${good.length} block(s) queued`);
    if (good.length) {
      step('ack', 'run'); const last = good[good.length - 1]!;
      const asig = await signText(d.officerPriv, ackMessage(d.plugId, last.seq, last.hash));
      if (!(await d.transport.writeAck(last.seq, last.hash, asig))) return fail('ack', 'plug rejected the ACK');
      step('ack', 'ok'); trace(`WRITE 0xFF01 ACK up to block ${last.seq}`);
    } else step('ack', 'skip');
    d.transport.disconnect();
    const ms = T();
    return { ok: !tamper, count: good.length, totalMs: ms, within2s: ms <= 2000, tamperSeq: tamper?.seq, reason: tamper?.reason };
  } catch (e) { return fail('connect', 'unexpected error: ' + (e as Error).message); }
}
