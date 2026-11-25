import { aesDecrypt, aesEncrypt, deriveAesKey, toHex } from './crypto.js';
export const STORES = ['meta', 'plugs', 'blocks', 'sales', 'outbox', 'creds', 'simplugs'];
/** Local database: IndexedDB, every row AES-GCM encrypted under a PIN-derived key.
 *  Falls back to memory when the browser blocks storage. */
export class Store {
    idb = null;
    mem = new Map();
    key = null;
    usingMemory = false;
    async open() {
        try {
            this.idb = await new Promise((res, rej) => {
                const r = indexedDB.open('wattcredit-field-app', 1);
                r.onupgradeneeded = () => STORES.forEach(s => r.result.createObjectStore(s, { keyPath: 'id' }));
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
                r.onblocked = () => rej(new Error('blocked'));
            });
        }
        catch {
            this.usingMemory = true;
            STORES.forEach(s => this.mem.set(s, new Map()));
        }
    }
    tx(s, mode, f) {
        return new Promise((res, rej) => {
            const t = this.idb.transaction(s, mode);
            const rq = f(t.objectStore(s));
            t.oncomplete = () => res(rq.result);
            t.onerror = () => rej(t.error);
            t.onabort = () => rej(t.error);
        });
    }
    rawGet = (s, id) => this.usingMemory ? Promise.resolve(this.mem.get(s).get(id)) : this.tx(s, 'readonly', o => o.get(id));
    rawPut = async (s, r) => { if (this.usingMemory)
        this.mem.get(s).set(r.id, r);
    else
        await this.tx(s, 'readwrite', o => o.put(r)); };
    rawAll = (s) => this.usingMemory ? Promise.resolve([...this.mem.get(s).values()]) : this.tx(s, 'readonly', o => o.getAll());
    async isFirstRun() { return !(await this.rawGet('meta', 'kdf')); }
    async unlock(pin) {
        const rec = (await this.rawGet('meta', 'kdf'));
        if (!rec) {
            const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
            this.key = await deriveAesKey(pin, salt);
            await this.rawPut('meta', { id: 'kdf', salt, check: await aesEncrypt(this.key, { ok: 'wattcredit' }) });
            return true;
        }
        this.key = await deriveAesKey(pin, rec.salt);
        try {
            return (await aesDecrypt(this.key, rec.check)).ok === 'wattcredit';
        }
        catch {
            this.key = null;
            return false;
        }
    }
    lock() { this.key = null; }
    async put(s, o) { await this.rawPut(s, { id: o.id, ...(await aesEncrypt(this.key, o)) }); }
    async get(s, id) { const r = await this.rawGet(s, id); return r ? aesDecrypt(this.key, r) : null; }
    async all(s) { return Promise.all((await this.rawAll(s)).map(r => aesDecrypt(this.key, r))); }
    async wipe() {
        for (const s of STORES) {
            if (this.usingMemory)
                this.mem.get(s).clear();
            else
                await this.tx(s, 'readwrite', o => o.clear());
        }
        this.key = null;
    }
}
