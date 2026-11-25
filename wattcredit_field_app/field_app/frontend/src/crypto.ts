import type { Cred, ShiftBlock } from './types.js';

const te = new TextEncoder();
const td = new TextDecoder();
export const ZERO_HASH = '0'.repeat(64);

export const toHex = (b: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(b instanceof Uint8Array ? b : b)].map(x => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (h: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
};
export const toB64 = (b: ArrayBuffer): string => {
  let s = ''; const u = new Uint8Array(b);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s); const u = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};

export const sha256Hex = async (s: string | Uint8Array<ArrayBuffer>): Promise<string> =>
  toHex(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? te.encode(s) : s));

const ECDSA_KEY = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SIG = { name: 'ECDSA', hash: 'SHA-256' } as const;

export async function genKeyPair(): Promise<Cred> {
  const kp = await crypto.subtle.generateKey(ECDSA_KEY, true, ['sign', 'verify']);
  return { pub: await crypto.subtle.exportKey('jwk', kp.publicKey), priv: await crypto.subtle.exportKey('jwk', kp.privateKey) };
}
/** Raw r||s, 64 bytes, hex: the same encoding the plug firmware and the Django backend use. */
export async function signText(priv: JsonWebKey, text: string): Promise<string> {
  const k = await crypto.subtle.importKey('jwk', priv, ECDSA_KEY, false, ['sign']);
  return toHex(await crypto.subtle.sign(ECDSA_SIG, k, te.encode(text)));
}
export async function verifyText(pub: JsonWebKey, text: string, sigHex: string): Promise<boolean> {
  try {
    const k = await crypto.subtle.importKey('jwk', pub, ECDSA_KEY, false, ['verify']);
    return await crypto.subtle.verify(ECDSA_SIG, k, fromHex(sigHex), te.encode(text));
  } catch { return false; }
}

/* ---- shift blocks: field order is a wire contract shared with firmware and backend/ledger/evidence.py */
export const blockHashInput = (b: Omit<ShiftBlock, 'hash' | 'sig'>): string =>
  [b.plugId, b.seq, b.tStart, b.tEnd, b.workMin, b.idleMin, b.otherMin, b.creditedMwh, b.vrmsDv, b.irmsCa, b.trips, b.prevHash].join('|');

export async function checkBlock(b: ShiftBlock, expectPrev: string, plugPub: JsonWebKey): Promise<{ ok: boolean; reason: string }> {
  if (b.prevHash !== expectPrev) return { ok: false, reason: 'chain break: prevHash does not match the last accepted hash' };
  if (await sha256Hex(blockHashInput(b)) !== b.hash) return { ok: false, reason: 'hash mismatch: block content was altered' };
  if (!(await verifyText(plugPub, b.hash, b.sig))) return { ok: false, reason: 'plug signature invalid' };
  return { ok: true, reason: '' };
}

export const challengeMessage = (challenge: string, plugId: string, officerId: string) => `${challenge}|${plugId}|${officerId}`;
export const ackMessage = (plugId: string, seq: number, hash: string) => `ACK|${plugId}|${seq}|${hash}`;
export const requestMessage = async (officerId: string, ts: string, body: string) => `${officerId}|${ts}|${await sha256Hex(te.encode(body))}`;

/* ---- encryption at rest (stand-in for SQLCipher in the browser) */
export async function deriveAesKey(pin: string, saltHex: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', te.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromHex(saltHex), iterations: 200_000, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function aesEncrypt(key: CryptoKey, obj: unknown): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv: toHex(iv), ct: toHex(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)))) };
}
export async function aesDecrypt<T>(key: CryptoKey, r: { iv: string; ct: string }): Promise<T> {
  return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(r.iv) }, key, fromHex(r.ct))));
}
