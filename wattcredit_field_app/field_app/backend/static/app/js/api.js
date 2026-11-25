import { requestMessage, signText } from './crypto.js';
/** Every request carries the officer credential's signature over (id | timestamp | sha256(body)). */
export async function signedRequest(a, method, path, body = '', ts = String(Math.floor(Date.now() / 1000))) {
    const sig = await signText(a.priv, await requestMessage(a.officerId, ts, body));
    return { url: path, init: { method, body: method === 'POST' ? body : undefined,
            headers: { 'Content-Type': 'application/json', 'X-Officer-Id': a.officerId, 'X-Timestamp': ts, 'X-Signature': sig } } };
}
export async function call(a, f, method, path, body = '') {
    const r = await signedRequest(a, method, path, body);
    return f(r.url, r.init);
}
export const WORKER = { batchMax: 5, batchBytes: 400_000, backoffMs: 0, nextAt: 0, busy: false };
/** WorkManager-style flush: oldest first, bounded batch (count and bytes), exponential back-off on failure. */
export async function flushOutbox(store, a, f, now = Date.now(), force = false) {
    const none = { sent: 0, waiting: 0, rejected: 0 };
    if (WORKER.busy || (!force && now < WORKER.nextAt))
        return none;
    const pend = (await store.all('outbox')).filter(r => r.state === 'pending').sort((x, y) => x.n - y.n);
    if (!pend.length)
        return none;
    const batch = [];
    let bytes = 0;
    for (const r of pend) {
        if (batch.length >= WORKER.batchMax || (batch.length && bytes + r.bytes > WORKER.batchBytes))
            break;
        batch.push(r);
        bytes += r.bytes;
    }
    WORKER.busy = true;
    try {
        const res = await call(a, f, 'POST', '/api/sync/', JSON.stringify({ records: batch.map(r => ({ id: r.id, type: r.type, payload: r.payload })) }));
        if (!res.ok)
            throw new Error('server said ' + res.status);
        const out = (await res.json()).results;
        const sum = { ...none };
        for (const x of out) {
            const row = batch.find(r => r.id === x.id);
            if (!row)
                continue;
            if (x.status === 'accepted' || x.status === 'duplicate') {
                row.state = 'sent';
                row.sentAt = Date.now();
                row.lastError = '';
                sum.sent++;
            }
            else if (x.status === 'gap') {
                row.attempts++;
                row.lastError = x.why ?? 'gap';
                sum.waiting++;
            }
            else {
                row.state = 'rejected';
                row.lastError = x.why ?? x.status;
                sum.rejected++;
            }
            await store.put('outbox', row);
            if (row.type === 'daily_sale' && row.state === 'sent') {
                const s = await store.get('sales', row.id);
                if (s && s.status === 'local') {
                    s.status = s.source === 'voice' ? 'pending_transcription' : 'confirmed';
                    await store.put('sales', s);
                }
            }
        }
        if (sum.sent || sum.rejected) {
            WORKER.backoffMs = 0;
            WORKER.nextAt = 0;
        }
        else {
            WORKER.backoffMs = Math.min(30_000, (WORKER.backoffMs || 1000) * 2);
            WORKER.nextAt = now + WORKER.backoffMs;
        }
        return sum;
    }
    catch (e) {
        for (const r of batch) {
            r.attempts++;
            r.lastError = e.message;
            await store.put('outbox', r);
        }
        WORKER.backoffMs = Math.min(30_000, (WORKER.backoffMs || 1000) * 2);
        WORKER.nextAt = now + WORKER.backoffMs;
        return { ...none, error: e.message };
    }
    finally {
        WORKER.busy = false;
    }
}
/** Pull transcription results for voice sales back into the local database. */
export async function pullSaleResults(store, a, f) {
    const res = await call(a, f, 'GET', '/api/ledger/');
    if (!res.ok)
        return 0;
    const server = (await res.json()).sales;
    let n = 0;
    for (const s of server) {
        const loc = await store.get('sales', s.id);
        if (loc && loc.source === 'voice' && (loc.status !== s.status || loc.amountPaise !== s.amountPaise)) {
            loc.status = s.status;
            loc.amountPaise = s.amountPaise;
            loc.transcript = s.transcript;
            await store.put('sales', loc);
            n++;
        }
    }
    return n;
}
