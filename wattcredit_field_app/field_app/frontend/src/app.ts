import { call, flushOutbox, pullSaleResults, WORKER, type Auth } from './api.js';
import { runBurstSync, type BurstResult, type StepEvent, type StepKey } from './burst.js';
import { ZERO_HASH, genKeyPair, sha256Hex } from './crypto.js';
import { Store } from './db.js';
import { t, type Key, type Lang } from './i18n.js';
import { SimTransport, WebBluetoothTransport, makeSimPlug, simRunShifts, type SimPlug } from './transport.js';
import type { Cred, Entrepreneur, OutboxRow, PlugRec, SaleRec, ShiftBlock } from './types.js';
import { VoiceRecorder, type Recording } from './voice.js';

const OFFICER = { id: 'BS-0142', name: 'Anita Sharma' };
const ENTS: Entrepreneur[] = [
  { id: 'E-01', name: 'Meena Devi', village: 'Kolar', plugId: 'WC-7A21', trade: 'Flour mill' },
  { id: 'E-02', name: 'Lakshmi Bai', village: 'Mulbagal', plugId: 'WC-3C90', trade: 'Tailoring' },
  { id: 'E-03', name: 'Radha Kumari', village: 'Bangarpet', plugId: 'WC-B54E', trade: 'Spice grinder' }];
const entOf = (id: string) => ENTS.find(e => e.id === id)!;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const short = (h: string) => h ? h.slice(0, 8) + '…' + h.slice(-4) : '-';
const rupees = (p: number | null) => p === null ? '?' : '₹' + (p / 100).toLocaleString('en-IN');

const store = new Store();
let cred: Cred; let auth: Auth;
const S = {
  user: null as null | { role: 'officer' | 'entrepreneur'; id: string; name: string }, tab: 'sync', online: true, lang: 'en' as Lang,
  loginRole: 'officer' as 'officer' | 'entrepreneur', loginEnt: 'E-01', pending: 0, worker: 'Idle', wlog: [] as string[],
  scanned: null as null | { id: string; rssi: number; real?: any }[], selected: null as string | null, link: 15, real: false,
  steps: [] as (StepEvent & { label: string })[], trace: [] as string[], result: null as BurstResult | null, syncing: false,
  keypad: 0, voice: null as Recording | null, recording: false, msg: '',
};
const rec = new VoiceRecorder();
const fetcher = (url: string, init: RequestInit) => S.online ? fetch(url, init) : Promise.reject(new Error('no signal'));
const toast = (m: string) => { const el = $('#toast'); el.textContent = m; el.hidden = false; setTimeout(() => el.hidden = true, 2600); };
const wlog = (s: string) => { S.wlog.unshift(new Date().toLocaleTimeString() + '  ' + s); S.wlog.length = Math.min(S.wlog.length, 40); };
let order = 0; const nextN = () => Date.now() * 1000 + (order++ % 1000);
const newId = () => crypto.randomUUID();

/* ---------------- setup: keys, simulated plugs, register with the server (dev) */
async function seed() {
  const k = await genKeyPair(); await store.put('creds', { id: 'officer', ...k });
  for (const [i, e] of ENTS.entries()) {
    const sp = await makeSimPlug(e.plugId, i < 2 ? { id: OFFICER.id, ...k } : null, [8, 5, 4][i]!, [-52, -67, -74][i]);
    await store.put('simplugs', sp);
    await store.put('plugs', { id: e.plugId, pub: sp.pub, entrepreneurId: e.id, lastSeq: 0, lastHash: ZERO_HASH, lastSync: null } as PlugRec);
  }
}
async function ensureRegistered() {
  if (await store.get('meta' as any, 'registered')) return;
  const plugs = await store.all<PlugRec>('plugs');
  try {
    const r = await fetcher('/api/dev/register/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ officer: { id: OFFICER.id, name: OFFICER.name, pub: cred.pub }, plugs: plugs.map(p => ({ id: p.id, pub: p.pub, entrepreneurId: p.entrepreneurId })) }) });
    if (r.ok) { registered = true; await store.put('meta' as any, { id: 'registered' }); wlog('keys registered with the server'); }
  } catch { /* offline: try again later */ }
}
let registered = false;

/* ---------------- outbox helpers */
async function enqueue(type: OutboxRow['type'], id: string, payload: unknown) {
  const body = JSON.stringify(payload);
  await store.put('outbox', { id, n: nextN(), type, payload, state: 'pending', attempts: 0, lastError: '', createdAt: Date.now(), bytes: body.length } as OutboxRow);
  await refreshCounts();
}
async function refreshCounts() { S.pending = (await store.all<OutboxRow>('outbox')).filter(r => r.state === 'pending').length; paintStatus(); }
async function workerTick(force = false) {
  if (!S.user) return;
  if (!S.online) { S.worker = 'Waiting for network'; paintStatus(); return; }
  if (!registered) await ensureRegistered();
  S.worker = 'Pushing…'; paintStatus();
  const r = await flushOutbox(store, auth, fetcher, Date.now(), force);
  if (r.sent || r.rejected || r.waiting) wlog(`batch: ${r.sent} accepted, ${r.waiting} waiting, ${r.rejected} rejected`);
  if (r.error) wlog('batch failed: ' + r.error + ' (retry in ' + Math.round(WORKER.backoffMs / 1000) + ' s)');
  if (r.sent) { try { if (await pullSaleResults(store, auth, fetcher)) renderView(); } catch { /* retry next tick */ } }
  await refreshCounts(); S.worker = S.pending ? `Pending ${S.pending}` : 'Idle'; paintStatus();
  if (r.sent) renderView();
}
setInterval(() => { workerTick(false); }, 4000);
window.addEventListener('online', () => workerTick(true));
navigator.serviceWorker?.addEventListener('message', e => { if (e.data === 'flush-outbox') workerTick(true); });

/* ---------------- BLE burst sync */
const STEP_LABELS: Record<StepKey, string> = { connect: 'Connect, discover 0xFF01 / 0xFF02', challenge: 'Read 0xFF02: plug challenge', response: 'Write 0xFF02: signed response',
  burst: 'Notify 0xFF01: shift-block burst', verify: 'Verify hash chain and plug signatures', store: 'Save blocks and outbox rows locally', ack: 'Write 0xFF01: signed ACK' };
async function syncPlug(id: string) {
  if (S.syncing) return;
  S.syncing = true; S.result = null; S.trace = [];
  S.steps = (Object.keys(STEP_LABELS) as StepKey[]).map(k => ({ key: k, state: 'skip' as const, ms: 0, label: STEP_LABELS[k] })); paintSync();
  const prec = (await store.get<PlugRec>('plugs', id))!;
  let transport; const picked = S.scanned?.find(p => p.id === id);
  if (picked?.real) transport = new WebBluetoothTransport(picked.real);
  else { const sp = (await store.get<SimPlug>('simplugs', id))!; transport = new SimTransport(sp, S.link); }
  const res = await runBurstSync({
    transport, plugId: id, officerId: OFFICER.id, officerPriv: cred.priv, plugPub: prec.pub, lastHash: prec.lastHash,
    onStep: e => { const s = S.steps.find(x => x.key === e.key)!; Object.assign(s, e); paintSync(); },
    onTrace: (l, ms) => { S.trace.push(`+${ms} ms  ${l}`); paintSync(); },
    async save(good: ShiftBlock[], tamper) {
      for (const b of good) { await store.put('blocks', { id: `blk:${id}:${b.seq}`, ...b }); await enqueue('telemetry_block', `blk:${id}:${b.seq}`, b); }
      if (tamper) await enqueue('tamper_alert', `alert:${id}:${tamper.seq}:${Date.now()}`, { plugId: id, seq: tamper.seq, reason: tamper.reason });
      if (good.length) { const l = good[good.length - 1]!; await store.put('plugs', { ...prec, lastSeq: l.seq, lastHash: l.hash, lastSync: Date.now() }); }
    } });
  S.result = res; S.syncing = false; paintSync(); workerTick(false);
}

/* ---------------- paint */
function paintStatus() {
  const el = document.getElementById('status'); if (!el || !S.user) return;
  el.innerHTML = `<span class="chip">${S.user.role === 'officer' ? 'Officer' : 'Entrepreneur'}: <b>${esc(S.user.name)}</b></span>
    <label class="toggle"><input type="checkbox" id="net" ${S.online ? 'checked' : ''}> ${S.online ? '4G / Wi-Fi zone' : 'No signal'}</label>
    <span class="chip">Outbox <b>${S.pending}</b></span><span class="chip">Worker <b>${esc(S.worker)}</b></span>
    <button class="quiet" data-act="lang">${S.lang === 'ta' ? 'English' : 'தமிழ்'}</button><button class="quiet" data-act="lock">Lock</button>`;
}
function paintSync() {
  const el = document.getElementById('syncPanel'); if (!el) return;
  const mark = { run: '…', ok: '✓', bad: '✗', skip: '·' };
  let h = S.steps.length ? '<ol class="steps">' + S.steps.map(s => `<li><span class="mark ${s.state}">${mark[s.state]}</span><span>${esc(s.label)}${s.detail ? `<small>${esc(s.detail)}</small>` : ''}</span><span class="ms">${s.state === 'ok' || s.state === 'bad' ? s.ms + ' ms' : ''}</span></li>`).join('') + '</ol>'
    : '<p class="note">Pick a plug and press Sync now.</p>';
  const r = S.result;
  if (r) h += `<h3 style="margin-top:12px">Two-second budget</h3><div class="budget"><i class="${r.totalMs > 2000 ? 'over' : ''}" style="width:${Math.min(100, r.totalMs / 20)}%"></i><span>${r.totalMs} ms</span></div>
    <p><span class="pill ${r.ok ? 'ok' : 'bad'}">${r.ok ? (r.count ? 'SYNCED' : 'NOTHING NEW') : r.tamperSeq ? 'TAMPER' : 'FAILED'}</span> ${r.ok ? r.count + ' block(s) acknowledged' : esc(r.reason)} <span class="pill ${r.within2s ? 'ok' : 'bad'}">${r.within2s ? 'within 2 s' : 'over 2 s'}</span></p>`;
  if (S.trace.length) h += '<h3 style="margin-top:12px">Trace</h3><div class="trace">' + S.trace.map(x => `<div>${esc(x)}</div>`).join('') + '</div>';
  el.innerHTML = h; const b = document.getElementById('syncBtn') as HTMLButtonElement | null; if (b) b.disabled = S.syncing || !S.selected;
}
const pill = (s?: string) => `<span class="pill ${s === 'sent' ? 'ok' : s === 'rejected' ? 'bad' : ''}">${s === 'sent' ? 'SYNCED' : s === 'rejected' ? 'REJECTED' : s ? 'PENDING' : 'LOCAL'}</span>`;
const TABS = { officer: [['sync', 'Scan and sync'], ['sales', 'Sales'], ['outbox', 'Outbox'], ['cloud', 'Cloud ledger'], ['bench', 'Demo bench']],
  entrepreneur: [['shifts', 'My shifts'], ['sales', 'Sales'], ['outbox', 'My outbox']] } as const;
function paintTabs() { $('#tabs').innerHTML = TABS[S.user!.role].map(([k, l]) => `<button role="tab" data-act="tab" data-k="${k}" aria-selected="${S.tab === k}">${l}</button>`).join(''); }
async function renderView() {
  const fn = { sync: vSync, sales: vSales, outbox: vOutbox, cloud: vCloud, bench: vBench, shifts: vShifts }[S.tab]!;
  const focus = document.activeElement?.id; $('#view').innerHTML = await fn();
  if (S.tab === 'sync') paintSync(); if (focus) document.getElementById(focus)?.focus();
}
function vSync() {
  const list = S.scanned === null ? '<p class="note">Press Scan.</p>' : !S.scanned.length ? '<p class="note">No plugs in range.</p>' :
    S.scanned.map(p => { const e = ENTS.find(x => x.plugId === p.id); return `<div class="plug" role="button" tabindex="0" data-act="pick" data-id="${p.id}" aria-pressed="${S.selected === p.id}"><span class="sig">${p.rssi} dBm</span><span><b>WattCredit-${p.id.slice(3)}</b><br><span class="note">${esc(e ? e.name + ', ' + e.village : 'not in registry')}</span></span><span class="pill">${p.id}</span></div>`; }).join('');
  return `<div class="cols"><section class="box"><h2>Nearby plugs</h2><div class="stack">
    <label class="f">Radio<select id="radio"><option value="sim" ${S.real ? '' : 'selected'}>Simulated plugs</option><option value="real" ${S.real ? 'selected' : ''}>Real Bluetooth (Chrome, HTTPS or localhost)</option></select></label>
    <div class="row"><button data-act="scan">Scan</button><button id="syncBtn" data-act="sync" ${S.syncing || !S.selected ? 'disabled' : ''}>Sync now</button></div>${list}
    <label class="f">Simulated link<select id="link"><option value="15" ${S.link === 15 ? 'selected' : ''}>15 ms per packet</option><option value="150" ${S.link === 150 ? 'selected' : ''}>150 ms per packet</option></select></label></div></section>
    <section class="box"><h2>Burst-sync engine</h2><div id="syncPanel"></div></section></div>`;
}
async function vSales() {
  const L = S.lang, ent = S.user!.role === 'entrepreneur' ? entOf(S.user!.id) : entOf(S.loginEnt);
  const ob = new Map((await store.all<OutboxRow>('outbox')).map(r => [r.id, r.state]));
  const rows = (await store.all<SaleRec>('sales')).filter(s => S.user!.role === 'officer' || s.entrepreneurId === S.user!.id).sort((a, b) => b.at - a.at).slice(0, 8);
  const label = (s: SaleRec) => s.status === 'local' ? t('local', L) : s.status === 'pending_transcription' ? t('pendingTx', L) : s.status === 'needs_review' ? t('review', L) : s.status === 'transcription_failed' ? t('failed', L) : t('done', L);
  return `<div class="cols"><section class="box" lang="${L}"><h2>${esc(ent.name)}</h2><div class="stack">
    ${S.user!.role === 'officer' ? `<label class="f">Entrepreneur<select id="f_ent">${ENTS.map(e => `<option value="${e.id}" ${e.id === ent.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>` : ''}
    <button class="bigbtn" data-act="rec">${S.recording ? '■ ' + t('stop', L) : '● ' + t('recordToday', L)}</button>
    ${S.recording ? `<p class="rec"><span class="dot"></span>${t('speakNow', L)}</p>` : ''}
    ${S.voice ? `<p><b>🎙 ${(S.voice.ms / 1000).toFixed(1)} s</b> <button class="quiet" data-act="saveVoice">${t('save', L)}</button> <button class="quiet" data-act="dropVoice">${t('clear', L)}</button></p>` : ''}
    <p class="note">${t('orTap', L)}</p>
    <div class="keys"><button data-act="key" data-v="500">₹500</button><button data-act="key" data-v="1000">₹1,000</button><button data-act="key" data-v="2000">₹2,000</button></div>
    <p><b>${t('total', L)}: ₹${S.keypad.toLocaleString('en-IN')}</b> <button data-act="saveKeys" ${S.keypad ? '' : 'disabled'}>${t('save', L)}</button> <button class="quiet" data-act="clearKeys">${t('clear', L)}</button></p>
    <p class="note">${esc(S.msg)}</p></div></section>
    <section class="box plain"><h2>${t('recent', L)}</h2>${rows.length ? `<div class="scroll"><table><tr><th>When</th><th>Who</th><th>Source</th><th>Amount</th><th>Status</th></tr>${rows.map(s => `<tr><td>${new Date(s.at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(entOf(s.entrepreneurId).name.split(' ')[0])}</td><td>${s.source}</td><td>${rupees(s.amountPaise)}</td><td>${esc(label(s))} ${pill(ob.get(s.id))}${s.transcript ? `<br><small lang="ta">${esc(s.transcript)}</small>` : ''}</td></tr>`).join('')}</table></div>` : '<p class="note">-</p>'}</section></div>`;
}
async function vShifts() {
  const e = entOf(S.user!.id); const st = new Map((await store.all<OutboxRow>('outbox')).map(r => [r.id, r.state]));
  const bs = (await store.all<ShiftBlock & { id: string }>('blocks')).filter(b => b.plugId === e.plugId).sort((a, b) => b.seq - a.seq);
  const wh = bs.reduce((a, b) => a + b.creditedMwh, 0) / 1000, wm = bs.reduce((a, b) => a + b.workMin, 0);
  return `<section class="box"><h2>${esc(e.name)}: plug ${e.plugId}</h2><div class="stats"><div><b>${bs.length}</b><span>shifts on this phone</span></div><div><b>${(wm / 60).toFixed(1)} h</b><span>machine at work</span></div><div><b>${wh.toFixed(0)} Wh</b><span>credited energy</span></div></div></section>
  <section class="box plain"><h2>Shift blocks</h2>${bs.length ? `<div class="scroll"><table><tr><th>#</th><th>Start</th><th>Work min</th><th>Credited Wh</th><th>Hash</th><th>Cloud</th></tr>${bs.map(b => `<tr><td>${b.seq}</td><td>${new Date(b.tStart * 1000).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td>${b.workMin}</td><td>${(b.creditedMwh / 1000).toFixed(1)}</td><td>${short(b.hash)}</td><td>${pill(st.get(b.id))}</td></tr>`).join('')}</table></div>` : '<p class="note">No shifts pulled yet. Ask your officer to sync your plug.</p>'}</section>`;
}
async function vOutbox() {
  let rows = (await store.all<OutboxRow>('outbox')).sort((a, b) => b.n - a.n); const c = (k: string) => rows.filter(r => r.state === k).length;
  return `<section class="box"><h2>Sync outbox</h2><div class="stats"><div><b>${c('pending')}</b><span>pending</span></div><div><b>${c('sent')}</b><span>synced</span></div><div><b>${c('rejected')}</b><span>rejected</span></div></div>
    <div class="row" style="margin-top:12px"><button data-act="runWorker">Run worker now</button></div></section>
    <div class="cols"><section class="box plain"><h2>Records</h2><div class="scroll"><table><tr><th>Type</th><th>Id</th><th>State</th><th>Tries</th><th>Error</th></tr>${rows.slice(0, 50).map(r => `<tr><td>${r.type}</td><td>${esc(r.id.slice(0, 22))}</td><td>${pill(r.state)}</td><td>${r.attempts}</td><td>${esc(r.lastError)}</td></tr>`).join('')}</table></div></section>
    <section class="box plain"><h2>Worker log</h2><div class="trace">${S.wlog.map(x => `<div>${esc(x)}</div>`).join('')}</div></section></div>`;
}
async function vCloud() {
  let d: any; try { d = await (await call(auth, fetcher, 'GET', '/api/ledger/')).json(); } catch (e) { return `<section class="box"><p class="err">Cannot reach the server: ${esc((e as Error).message)}</p></section>`; }
  if (!d.plugs) return `<section class="box"><p class="err">Server refused the credential. Keys are registered on first online sign-in.</p></section>`;
  return `<section class="box plain"><h2>Evidence chain per plug</h2><div class="scroll"><table><tr><th>Plug</th><th>Blocks</th><th>Work h</th><th>Credited Wh</th><th>Chain head</th></tr>${d.plugs.map((p: any) => `<tr><td>${p.plugId}</td><td>${p.blocks}</td><td>${(p.workMin / 60).toFixed(1)}</td><td>${(p.creditedMwh / 1000).toFixed(0)}</td><td>${short(p.chainHead)}</td></tr>`).join('')}</table></div></section>
    <section class="box plain"><h2>Daily sales and Tamil voice notes</h2><div class="scroll"><table><tr><th>Who</th><th>Source</th><th>Status</th><th>Amount</th><th>Transcript</th><th></th></tr>${d.sales.map((s: any) => `<tr><td>${esc(entOf(s.entrepreneurId)?.name)}</td><td>${s.source}</td><td>${s.status}${s.error ? '<br><small>' + esc(s.error) + '</small>' : ''}</td><td>${rupees(s.amountPaise)}</td><td lang="ta">${esc(s.transcript)}</td><td>${s.source === 'voice' && s.status !== 'confirmed' ? `<button class="quiet" data-act="tx" data-id="${s.id}">Transcribe</button> <button class="quiet" data-act="confirm" data-id="${s.id}">Set amount</button>` : ''}</td></tr>`).join('')}</table></div></section>
    <section class="box plain"><h2>Tamper alerts</h2>${d.alerts.length ? d.alerts.map((a: any) => `<p><span class="pill bad">ALERT</span> ${a.plug_id} block ${a.seq}: ${esc(a.reason)}</p>`).join('') : '<p class="note">None.</p>'}</section>`;
}
async function vBench() {
  const ps = (await store.all<SimPlug>('simplugs')).sort((a, b) => a.id.localeCompare(b.id));
  return `<section class="box yellow"><h2>Demo bench: the plug side</h2><p class="note">Stand-in for hardware: test failure paths.</p></section>` + ps.map(p => { const un = p.blocks.filter(b => b.seq > p.ackSeq).length; return `<section class="box"><h3>${p.id}</h3><div class="stats"><div><b>${p.blocks.length}</b><span>blocks</span></div><div><b>${un}</b><span>unacknowledged</span></div><div><b>${p.enrolled[OFFICER.id] ? 'yes' : 'no'}</b><span>credential enrolled</span></div></div>
    <div class="row" style="margin-top:10px"><button data-act="more" data-id="${p.id}">Run 3 more shifts</button><button class="quiet" data-act="enrol" data-id="${p.id}">${p.enrolled[OFFICER.id] ? 'Revoke credential' : 'Enrol credential'}</button><button class="quiet" data-act="range" data-id="${p.id}">${p.inRange ? 'Move out of range' : 'Move into range'}</button><button class="danger" data-act="corrupt" data-id="${p.id}" ${un ? '' : 'disabled'}>Alter first unsent block</button></div></section>`; }).join('') +
    `<section class="box plain"><p class="note">Storage: ${store.usingMemory ? 'memory only' : 'IndexedDB, AES-GCM per row'}.</p><button class="danger" data-act="wipe">Wipe device</button></section>`;
}
function vLogin() {
  return `<div class="login box"><h2>Sign in</h2><div class="stack"><div class="roles">
    <div class="role" role="button" tabindex="0" data-act="role" data-r="officer" aria-pressed="${S.loginRole === 'officer'}"><b>Bank Sakhi / NGO officer</b><span class="note">${OFFICER.id}, ${OFFICER.name}</span></div>
    <div class="role" role="button" tabindex="0" data-act="role" data-r="entrepreneur" aria-pressed="${S.loginRole === 'entrepreneur'}"><b>Micro-entrepreneur</b><span class="note">Own shifts, voice or keypad sales.</span></div></div>
    ${S.loginRole === 'entrepreneur' ? `<label class="f">Who are you?<select id="l_ent">${ENTS.map(e => `<option value="${e.id}" ${S.loginEnt === e.id ? 'selected' : ''}>${esc(e.name)}, ${esc(e.village)}</option>`).join('')}</select></label>` : ''}
    <label class="f">Device PIN<input type="password" id="l_pin" inputmode="numeric" autocomplete="off" placeholder="4 to 8 digits"></label>
    <p class="note" id="firstNote"></p><p class="err" id="loginErr"></p><div class="row"><button id="loginBtn" data-act="login">Unlock</button></div></div></div>`;
}
const shell = () => `<div class="top"><div class="wrap"><div class="brand"><h1>WattCredit Field Desk</h1><p>Offline-first · Django + TypeScript</p></div><div class="stat" id="status"></div></div></div><div class="wrap"><nav class="tabs" id="tabs" role="tablist"></nav><main id="view"></main></div>`;

/* ---------------- actions */
async function doLogin() {
  const pin = (document.getElementById('l_pin') as HTMLInputElement).value, err = $('#loginErr');
  if (!/^\d{4,8}$/.test(pin)) { err.textContent = 'The PIN is 4 to 8 digits.'; return; }
  try {
    if (!(await store.unlock(pin))) { err.textContent = 'Wrong PIN.'; return; }
    if (!(await store.get('creds', 'officer'))) await seed();
    cred = (await store.get<Cred & { id: string }>('creds', 'officer'))!; auth = { officerId: OFFICER.id, priv: cred.priv };
    registered = !!(await store.get('meta' as any, 'registered'));
    S.user = S.loginRole === 'officer' ? { role: 'officer', id: OFFICER.id, name: OFFICER.name } : { role: 'entrepreneur', id: S.loginEnt, name: entOf(S.loginEnt).name };
    S.lang = S.user.role === 'entrepreneur' ? 'ta' : 'en'; S.tab = S.user.role === 'officer' ? 'sync' : 'shifts';
    $('#root').innerHTML = shell(); paintStatus(); paintTabs(); await refreshCounts(); await renderView(); ensureRegistered();
  } catch (e) { err.textContent = 'Could not unlock: ' + (e as Error).message; }
}
async function saveSale(source: 'keypad' | 'voice') {
  const entId = S.user!.role === 'entrepreneur' ? S.user!.id : ((document.getElementById('f_ent') as HTMLSelectElement | null)?.value ?? S.loginEnt);
  const sale: SaleRec = { id: newId(), entrepreneurId: entId, plugId: entOf(entId).plugId, at: Date.now(), source, status: 'local',
    amountPaise: source === 'keypad' ? S.keypad * 100 : null, ...(source === 'voice' ? { audio: S.voice! } : {}) };
  await store.put('sales', sale);
  await enqueue('daily_sale', sale.id, { entrepreneurId: sale.entrepreneurId, plugId: sale.plugId, at: sale.at, source,
    ...(source === 'keypad' ? { amountPaise: sale.amountPaise } : { audio: sale.audio }) });
  S.keypad = 0; S.voice = null; S.msg = t('saved', S.lang); await renderView(); workerTick(false);
}
document.addEventListener('click', async ev => {
  const el = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null; if (!el) return; const a = el.dataset.act!, id = el.dataset.id!;
  try {
    if (a === 'role') { S.loginRole = el.dataset.r as any; $('#root').innerHTML = vLogin(); paintLoginNote(); }
    else if (a === 'login') await doLogin();
    else if (a === 'lock') { store.lock(); S.user = null; $('#root').innerHTML = vLogin(); paintLoginNote(); }
    else if (a === 'lang') { S.lang = S.lang === 'ta' ? 'en' : 'ta'; paintStatus(); await renderView(); }
    else if (a === 'tab') { S.tab = el.dataset.k!; paintTabs(); await renderView(); }
    else if (a === 'pick') { S.selected = id; await renderView(); }
    else if (a === 'scan') {
      if (S.real) { const c = await WebBluetoothTransport.choose(); S.scanned = [{ id: c.id, rssi: 0, real: c.device }]; S.selected = c.id; }
      else { const all = (await store.all<SimPlug>('simplugs')).filter(p => p.inRange); S.scanned = all.map(p => ({ id: p.id, rssi: p.rssi })).sort((x, y) => y.rssi - x.rssi); S.selected = S.scanned[0]?.id ?? null; }
      await renderView();
    }
    else if (a === 'sync') await syncPlug(S.selected!);
    else if (a === 'runWorker') { WORKER.nextAt = 0; await workerTick(true); await renderView(); }
    else if (a === 'key') { S.keypad += Number(el.dataset.v); await renderView(); }
    else if (a === 'clearKeys') { S.keypad = 0; await renderView(); }
    else if (a === 'saveKeys') await saveSale('keypad');
    else if (a === 'saveVoice') await saveSale('voice');
    else if (a === 'dropVoice') { S.voice = null; await renderView(); }
    else if (a === 'rec') {
      if (S.recording) { rec.stop(); return; }
      if (!VoiceRecorder.supported()) { S.msg = t('noMic', S.lang); await renderView(); return; }
      try { await rec.start(r => { S.recording = false; S.voice = r; renderView(); }); S.recording = true; S.msg = ''; }
      catch { S.msg = t('micDenied', S.lang); }
      await renderView();
    }
    else if (a === 'more') { const p = (await store.get<SimPlug>('simplugs', id))!; await simRunShifts(p, 3); await store.put('simplugs', p); await renderView(); }
    else if (a === 'enrol') { const p = (await store.get<SimPlug>('simplugs', id))!; if (p.enrolled[OFFICER.id]) delete p.enrolled[OFFICER.id]; else p.enrolled[OFFICER.id] = cred.pub; await store.put('simplugs', p); await renderView(); }
    else if (a === 'range') { const p = (await store.get<SimPlug>('simplugs', id))!; p.inRange = !p.inRange; await store.put('simplugs', p); S.scanned = null; await renderView(); }
    else if (a === 'corrupt') { const p = (await store.get<SimPlug>('simplugs', id))!; const b = p.blocks.find(x => x.seq > p.ackSeq)!; b.creditedMwh += 25_000; await store.put('simplugs', p); toast(`Block ${b.seq} altered without re-signing`); await renderView(); }
    else if (a === 'tx') { const r = await call(auth, fetcher, 'POST', `/api/sales/${id}/transcribe/`, '{}'); toast('Transcription: ' + (await r.json()).status); await pullSaleResults(store, auth, fetcher); await renderView(); }
    else if (a === 'confirm') { const v = Number(prompt_('Amount in rupees')); if (v >= 0) { await call(auth, fetcher, 'POST', `/api/sales/${id}/confirm/`, JSON.stringify({ amountPaise: Math.round(v * 100) })); await pullSaleResults(store, auth, fetcher); await renderView(); } }
    else if (a === 'wipe') { await store.wipe(); S.user = null; $('#root').innerHTML = vLogin(); paintLoginNote(); }
  } catch (e) { toast('Error: ' + (e as Error).message); }
});
// window.prompt is unavailable in some embedded contexts, so use a tiny inline fallback
const prompt_ = (q: string) => (typeof window.prompt === 'function' ? window.prompt(q) : null) ?? '';
document.addEventListener('keydown', ev => { const t0 = ev.target as HTMLElement; if ((ev.key === 'Enter' || ev.key === ' ') && t0.matches('.plug,.role')) { ev.preventDefault(); t0.click(); } if (ev.key === 'Enter' && t0.id === 'l_pin') doLogin(); });
document.addEventListener('change', ev => {
  const t0 = ev.target as HTMLInputElement;
  if (t0.id === 'net') { S.online = t0.checked; wlog(S.online ? 'network connected' : 'network lost'); paintStatus(); if (S.online) workerTick(true); }
  else if (t0.id === 'link') S.link = Number(t0.value); else if (t0.id === 'radio') { S.real = t0.value === 'real'; S.scanned = null; S.selected = null; renderView(); }
  else if (t0.id === 'l_ent') S.loginEnt = t0.value; else if (t0.id === 'f_ent') S.loginEnt = t0.value;
});
async function paintLoginNote() { const n = document.getElementById('firstNote'); if (n) n.textContent = (await store.isFirstRun()) ? 'First run on this device: the PIN you enter now locks the local database. Demo: 1234.' : 'Enter this device\'s PIN.'; }
(async () => {
  await store.open(); $('#root').innerHTML = vLogin(); await paintLoginNote();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/static/app/sw.js', { scope: '/static/app/' }).catch(() => 0);
})();
