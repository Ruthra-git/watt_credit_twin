"""Evidence checks shared by the API and the tests. Pure Python, no Django imports.

Formats match frontend/src/crypto.ts exactly:
  * ECDSA P-256 / SHA-256, signature = raw r||s (64 bytes, hex), public key = JWK
    (this is what WebCrypto produces; `cryptography` wants DER, so we convert).
  * Block hash = SHA-256 over the '|'-joined integer/text fields in BLOCK_FIELDS.
"""
import base64
import hashlib
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils

ZERO_HASH = "0" * 64
BLOCK_FIELDS = ("plugId", "seq", "tStart", "tEnd", "workMin", "idleMin", "otherMin",
                "creditedMwh", "vrmsDv", "irmsCa", "trips", "prevHash")
INT_FIELDS = BLOCK_FIELDS[1:11]


def _b64u(s: str) -> int:
    return int.from_bytes(base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)), "big")


def public_key_from_jwk(jwk: dict):
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256":
        raise ValueError("not a P-256 JWK")
    return ec.EllipticCurvePublicNumbers(_b64u(jwk["x"]), _b64u(jwk["y"]), ec.SECP256R1()).public_key()


def verify_text(jwk: dict, text: str, sig_hex: str) -> bool:
    try:
        raw = bytes.fromhex(sig_hex)
        if len(raw) != 64:
            return False
        der = utils.encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
        public_key_from_jwk(jwk).verify(der, text.encode(), ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, ValueError, KeyError, TypeError):
        return False


def block_hash(b: dict) -> str:
    return hashlib.sha256("|".join(str(b[f]) for f in BLOCK_FIELDS).encode()).hexdigest()


def check_block(b: dict, expect_prev: str, plug_jwk: dict):
    """Return (ok, reason)."""
    try:
        for f in INT_FIELDS:
            if not isinstance(b[f], int) or isinstance(b[f], bool):
                return False, f"malformed block: {f} must be an integer"
        for f in ("plugId", "prevHash", "hash", "sig"):
            if not isinstance(b[f], str):
                return False, f"malformed block: {f} missing"
    except KeyError as e:
        return False, f"malformed block: missing {e.args[0]}"
    if b["prevHash"] != expect_prev:
        return False, "chain break: prevHash does not match the last accepted hash"
    if block_hash(b) != b["hash"]:
        return False, "hash mismatch: block content was altered"
    if not verify_text(plug_jwk, b["hash"], b["sig"]):
        return False, "plug signature invalid"
    return True, ""


def request_message(officer_id: str, ts: str, body: bytes) -> str:
    return f"{officer_id}|{ts}|{hashlib.sha256(body).hexdigest()}"


def verify_request(officer_jwk: dict, officer_id: str, ts: str, body: bytes, sig_hex: str,
                   now: float = None, skew: int = 300) -> bool:
    try:
        if abs((now if now is not None else time.time()) - int(ts)) > skew:
            return False
    except ValueError:
        return False
    return verify_text(officer_jwk, request_message(officer_id, ts, body), sig_hex)
