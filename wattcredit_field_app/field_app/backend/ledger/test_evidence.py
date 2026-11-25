"""Interop: blocks and requests produced by the TypeScript client (frontend/test/e2e.mjs -> out.json)
must verify with the backend's evidence.py. Run:  cd frontend && npm test ; cd ../backend && python -m unittest ledger.test_evidence"""
import json
import os
import time
import unittest

from ledger import evidence as ev

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "test", "out.json")


@unittest.skipUnless(os.path.exists(OUT), "run `npm test` in frontend first")
class Interop(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.v = json.load(open(OUT))

    def chain(self, d):
        prev, results = ev.ZERO_HASH, []
        for b in d["blocks"]:
            ok, why = ev.check_block(b, prev, d["pub"])
            results.append((b["seq"], ok, why))
            if not ok:
                break
            prev = b["hash"]
        return results

    def test_good_chain_verifies(self):
        r = self.chain(self.v["plug"])
        self.assertEqual(len(r), 6)
        self.assertTrue(all(ok for _, ok, _ in r), r)

    def test_tampered_block_detected(self):
        r = self.chain(self.v["tampered"])
        self.assertEqual(r[-1][:2], (3, False))
        self.assertIn("hash mismatch", r[-1][2])

    def test_removed_block_detected(self):
        r = self.chain(self.v["cut"])
        self.assertFalse(r[-1][1])
        self.assertIn("chain break", r[-1][2])

    def test_wrong_plug_key_rejected(self):
        b = self.v["plug"]["blocks"][0]
        ok, why = ev.check_block(b, ev.ZERO_HASH, self.v["tampered"]["pub"])
        self.assertFalse(ok)
        self.assertIn("signature", why)

    def test_signed_request(self):
        q, o = self.v["request"], self.v["officer"]
        body = q["body"].encode()
        self.assertTrue(ev.verify_request(o["pub"], o["id"], q["ts"], body, q["sig"]))
        self.assertFalse(ev.verify_request(o["pub"], o["id"], q["ts"], body + b" ", q["sig"]))      # body altered
        self.assertFalse(ev.verify_request(o["pub"], o["id"], q["ts"], body, self.v["forged"]["sig"]))  # wrong key
        self.assertFalse(ev.verify_request(o["pub"], o["id"], q["ts"], body, q["sig"], now=time.time() + 3600))  # replay


if __name__ == "__main__":
    unittest.main()
