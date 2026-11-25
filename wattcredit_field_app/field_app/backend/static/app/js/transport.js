import { ZERO_HASH, ackMessage, blockHashInput, challengeMessage, fromHex, genKeyPair, sha256Hex, signText, toHex, verifyText } from './crypto.js';
/* ============ GATT layout (ours: the plug firmware must follow it) ============
 * Service  0000ff00-0000-1000-8000-00805f9b34fb
 *  0xFF02 auth   read   -> 32-byte random challenge
 *                write  -> UTF-8 JSON {"o": officerId, "s": sigHex}; after the write, read -> 1 byte (1 = authorised)
 *  0xFF01 blocks notify -> UTF-8 JSON, one ShiftBlock per notification (<= MTU, else split with a 1-byte
 *                          continuation flag); an empty notification ends the burst
 *                write  -> UTF-8 JSON {"seq","hash","sig"}: signed ACK, plug may then free blocks <= seq
 * The Web Bluetooth transport below follows this; it has NOT been run against hardware. */
export const SERVICE = '0000ff00-0000-1000-8000-00805f9b34fb';
export const CHAR_BLOCKS = '0000ff01-0000-1000-8000-00805f9b34fb';
export const CHAR_AUTH = '0000ff02-0000-1000-8000-00805f9b34fb';
export class WebBluetoothTransport {
    device;
    auth;
    blocks;
    server;
    constructor(device) {
        this.device = device;
    }
    static async choose() {
        const nav = navigator;
        if (!nav.bluetooth)
            throw new Error('Web Bluetooth is not available. Use Chrome on Android or desktop over HTTPS or localhost.');
        const device = await nav.bluetooth.requestDevice({ filters: [{ namePrefix: 'WattCredit-' }], optionalServices: [SERVICE] });
        return { device, id: 'WC-' + String(device.name).replace('WattCredit-', '') };
    }
    async connect() {
        this.server = await this.device.gatt.connect();
        const svc = await this.server.getPrimaryService(SERVICE);
        this.auth = await svc.getCharacteristic(CHAR_AUTH);
        this.blocks = await svc.getCharacteristic(CHAR_BLOCKS);
    }
    async readChallenge() { return toHex(new Uint8Array((await this.auth.readValue()).buffer)); }
    async writeAuth(officerId, sigHex) {
        await this.auth.writeValueWithResponse(new TextEncoder().encode(JSON.stringify({ o: officerId, s: sigHex })));
        return new Uint8Array((await this.auth.readValue()).buffer)[0] === 1;
    }
    async readBurst(onBlock) {
        const out = [];
        const dec = new TextDecoder();
        return new Promise(async (res, rej) => {
            const timer = setTimeout(() => rej(new Error('burst timed out')), 4000);
            const h = (ev) => {
                const dv = ev.target.value;
                if (dv.byteLength === 0) {
                    clearTimeout(timer);
                    this.blocks.removeEventListener('characteristicvaluechanged', h);
                    res(out);
                    return;
                }
                const b = JSON.parse(dec.decode(dv));
                out.push(b);
                onBlock(b);
            };
            this.blocks.addEventListener('characteristicvaluechanged', h);
            try {
                await this.blocks.startNotifications();
            }
            catch (e) {
                clearTimeout(timer);
                rej(e);
            }
        });
    }
    async writeAck(seq, hash, sig) {
        await this.blocks.writeValueWithResponse(new TextEncoder().encode(JSON.stringify({ seq, hash, sig })));
        return true;
    }
    disconnect() { try {
        this.server?.disconnect();
    }
    catch { /* already gone */ } }
}
const rnd = (a, b) => a + Math.random() * (b - a);
export async function makeSimPlug(id, officer, nBlocks, rssi = -60) {
    const k = await genKeyPair();
    const p = { id, pub: k.pub, priv: k.priv, blocks: [], ackSeq: 0, enrolled: {}, inRange: true, rssi };
    if (officer)
        p.enrolled[officer.id] = officer.pub;
    await simRunShifts(p, nBlocks);
    return p;
}
export async function simRunShifts(p, n) {
    const NET_MW = 196_700; // 234.7 W working minus 38 W idle, from the validated model, in mW
    for (let i = 0; i < n; i++) {
        const prev = p.blocks[p.blocks.length - 1];
        const tStart = prev ? prev.tEnd + Math.round(rnd(9, 15) * 3600) : Math.floor(Date.now() / 1000) - 8 * 86400;
        const dur = Math.round(rnd(240, 480)), work = Math.round(dur * rnd(0.35, 0.75)), idle = Math.round((dur - work) * rnd(0.3, 0.6));
        const b = {
            plugId: p.id, seq: p.blocks.length + 1, tStart, tEnd: tStart + dur * 60, workMin: work, idleMin: idle, otherMin: dur - work - idle,
            creditedMwh: Math.round(work / 60 * NET_MW / 1000 * rnd(0.97, 1.03)), vrmsDv: Math.round(rnd(2260, 2360)), irmsCa: Math.round(rnd(60, 130)),
            trips: Math.random() < 0.88 ? 0 : 1, prevHash: prev ? prev.hash : ZERO_HASH
        };
        const hash = await sha256Hex(blockHashInput(b));
        p.blocks.push({ ...b, hash, sig: await signText(p.priv, hash) });
    }
}
export class SimTransport {
    p;
    linkMs;
    wait;
    challenge = '';
    session = null;
    constructor(p, linkMs = 15, wait = ms => new Promise(r => setTimeout(r, ms))) {
        this.p = p;
        this.linkMs = linkMs;
        this.wait = wait;
    }
    async connect() { await this.wait(60); }
    async readChallenge() { await this.wait(this.linkMs); this.challenge = toHex(crypto.getRandomValues(new Uint8Array(32))); this.session = null; return this.challenge; }
    async writeAuth(officerId, sig) {
        await this.wait(this.linkMs);
        const pub = this.p.enrolled[officerId];
        this.session = pub && await verifyText(pub, challengeMessage(this.challenge, this.p.id, officerId), sig) ? officerId : null;
        this.challenge = '';
        return this.session !== null;
    }
    async readBurst(onBlock) {
        if (!this.session)
            throw new Error('not authorised');
        const out = [];
        for (const b of this.p.blocks.filter(x => x.seq > this.p.ackSeq).slice(0, 64)) {
            await this.wait(this.linkMs);
            const c = { ...b };
            out.push(c);
            onBlock(c);
        }
        await this.wait(this.linkMs);
        return out;
    }
    async writeAck(seq, hash, sig) {
        await this.wait(this.linkMs);
        if (!this.session)
            return false;
        const blk = this.p.blocks.find(b => b.seq === seq);
        if (!blk || blk.hash !== hash || !(await verifyText(this.p.enrolled[this.session], ackMessage(this.p.id, seq, hash), sig)))
            return false;
        this.p.ackSeq = Math.max(this.p.ackSeq, seq);
        return true;
    }
    disconnect() { this.session = null; }
}
export { fromHex };
