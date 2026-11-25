import { aesDecrypt, aesEncrypt, deriveAesKey, toHex } from './crypto.js';

export const STORES = ['meta', 'plugs', 'blocks', 'sales', 'outbox', 'creds', 'simplugs'] as const;
export type StoreName = typeof STORES[number];
type Row = { id: string; iv: string; ct: string };

/** Local database: IndexedDB, every row AES-GCM encrypted under a PIN-derived key.
 *  Falls back to memory when the browser blocks storage. */
export class Store {
  private idb: IDBDatabase | null = null;
  private mem = new Map<StoreName, Map<string, Row>>();
  private key: CryptoKey | null = null;
  usingMemory = false;

  async open(): Promise<void> {
    try {
      this.idb = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('wattcredit-field-app', 1);
        r.onupgradeneeded = () => STORES.forEach(s => r.result.createObjectStore(s, { keyPath: 'id' }));
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked'));
      });
    } catch { this.usingMemory = true; STORES.forEach(s => this.mem.set(s, new Map())); }
  }
  private tx<T>(s: StoreName, mode: IDBTransactionMode, f: (o: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((res, rej) => {
      const t = this.idb!.transaction(s, mode); const rq = f(t.objectStore(s));
      t.oncomplete = () => res(rq.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  private rawGet = (s: StoreName, id: string): Promise<Row | undefined> =>
    this.usingMemory ? Promise.resolve(this.mem.get(s)!.get(id)) : this.tx(s, 'readonly', o => o.get(id));
  private rawPut = async (s: StoreName, r: Row) => { if (this.usingMemory) this.mem.get(s)!.set(r.id, r); else await this.tx(s, 'readwrite', o => o.put(r)); };
  private rawAll = (s: StoreName): Promise<Row[]> =>
    this.usingMemory ? Promise.resolve([...this.mem.get(s)!.values()]) : this.tx(s, 'readonly', o => o.getAll());

  async isFirstRun() { return !(await this.rawGet('meta', 'kdf')); }
  async unlock(pin: string): Promise<boolean> {
    const rec = (await this.rawGet('meta', 'kdf')) as (Row & { salt?: string; check?: { iv: string; ct: string } }) | undefined;
    if (!rec) {
      const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
      this.key = await deriveAesKey(pin, salt);
      await this.rawPut('meta', { id: 'kdf', salt, check: await aesEncrypt(this.key, { ok: 'wattcredit' }) } as unknown as Row);
      return true;
    }
    this.key = await deriveAesKey(pin, rec.salt!);
    try { return (await aesDecrypt<{ ok: string }>(this.key, rec.check!)).ok === 'wattcredit'; }
    catch { this.key = null; return false; }
  }
  lock() { this.key = null; }
  async put<T extends { id: string }>(s: StoreName, o: T) { await this.rawPut(s, { id: o.id, ...(await aesEncrypt(this.key!, o)) }); }
  async get<T>(s: StoreName, id: string): Promise<T | null> { const r = await this.rawGet(s, id); return r ? aesDecrypt<T>(this.key!, r) : null; }
  async all<T>(s: StoreName): Promise<T[]> { return Promise.all((await this.rawAll(s)).map(r => aesDecrypt<T>(this.key!, r))); }
  async wipe() {
    for (const s of STORES) { if (this.usingMemory) this.mem.get(s)!.clear(); else await this.tx(s, 'readwrite', o => o.clear()); }
    this.key = null;
  }
}
