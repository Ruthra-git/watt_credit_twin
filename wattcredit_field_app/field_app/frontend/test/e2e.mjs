// Runs the REAL compiled TypeScript modules in Node (WebCrypto is built in): plug <-> burst engine <-> signed sync request.
// Writes test/out.json for the Python side to verify with the backend's evidence.py.
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { genKeyPair, ZERO_HASH, sha256Hex } from '../../backend/static/app/js/crypto.js';
import { makeSimPlug, SimTransport } from '../../backend/static/app/js/transport.js';
import { runBurstSync } from '../../backend/static/app/js/burst.js';
import { signedRequest } from '../../backend/static/app/js/api.js';

const officer = { id: 'BS-0142', ...(await genKeyPair()) };
const stranger = await genKeyPair();
const instant = () => Promise.resolve();
const plug = await makeSimPlug('WC-TEST', officer, 6);

async function run(p, who = officer, last = ZERO_HASH) {
  const saved = { good: [], tamper: null };
  const res = await runBurstSync({
    transport: new SimTransport(p, 15, instant), plugId: p.id, officerId: officer.id, officerPriv: who.priv, plugPub: p.pub, lastHash: last,
    save: async (good, tamper) => { saved.good = good; saved.tamper = tamper; } });
  return { res, saved };
}

// 1. happy path
let { res, saved } = await run(plug);
assert.equal(res.ok, true); assert.equal(res.count, 6); assert.equal(plug.ackSeq, 6);
// 2. nothing new
({ res } = await run(plug, officer, saved.good[5].hash)); assert.equal(res.count, 0); assert.equal(res.ok, true);
// 3. wrong credential is refused by the plug
const p2 = await makeSimPlug('WC-T2', officer, 3);
({ res } = await run(p2, stranger)); assert.equal(res.ok, false); assert.match(res.reason, /refused/);
// 4. altered block: good blocks before it are kept, alert raised, ACK stops before it
const p3 = await makeSimPlug('WC-T3', officer, 5);
p3.blocks[2].creditedMwh += 25000;
({ res, saved } = await run(p3));
assert.equal(res.ok, false); assert.equal(res.tamperSeq, 3); assert.equal(saved.good.length, 2); assert.equal(p3.ackSeq, 2);
// 5. missing block in the middle = chain break
const p4 = await makeSimPlug('WC-T4', officer, 5);
p4.blocks.splice(2, 1);
({ res } = await run(p4)); assert.equal(res.tamperSeq, 4 - 1 + 0 === 3 ? 4 : 4); assert.match(res.reason, /chain break/);

// export vectors for the Python backend
const vec = { officer: { id: officer.id, pub: officer.pub }, plug: { id: 'WC-TEST', pub: plug.pub, blocks: plug.blocks },
  tampered: { id: p3.id, pub: p3.pub, blocks: p3.blocks }, cut: { id: p4.id, pub: p4.pub, blocks: p4.blocks } };
const body = JSON.stringify({ records: plug.blocks.map(b => ({ id: `blk:WC-TEST:${b.seq}`, type: 'telemetry_block', payload: b })) });
const ts = String(Math.floor(Date.now() / 1000));
const r = await signedRequest({ officerId: officer.id, priv: officer.priv }, 'POST', '/api/sync/', body, ts);
vec.request = { body, ts, sig: r.init.headers['X-Signature'], officerId: officer.id };
const bad = await signedRequest({ officerId: officer.id, priv: stranger.priv }, 'POST', '/api/sync/', body, ts);
vec.forged = { sig: bad.init.headers['X-Signature'] };
writeFileSync(new URL('./out.json', import.meta.url), JSON.stringify(vec));
console.log('node e2e: all assertions passed;', plug.blocks.length, 'blocks exported');
