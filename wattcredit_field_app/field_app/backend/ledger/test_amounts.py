import unittest

from ledger.amounts import extract_rupees


class Amounts(unittest.TestCase):
    CASES = [
        ("இன்று ஐநூறு ரூபாய் விற்பனை", 500, "high"),
        ("ஆயிரத்து ஐநூறு ரூபாய்", 1500, "high"),
        ("இரண்டாயிரம் ரூபாய்", 2000, "high"),
        ("இரண்டாயிரத்து ஐநூறு ரூபாய்", 2500, "high"),
        ("நூற்று ஐம்பது ரூபாய்", 150, "high"),
        ("இன்று 1,200 ரூபாய்க்கு விற்றேன்", 1200, "high"),
        ("௧௫௦ ரூபாய்", 150, "high"),
        ("₹800", 800, "high"),
        ("five hundred rupees", 500, "high"),
        ("ஆயிரம் ரூபாய்", 1000, "high"),
        ("இரண்டு ஆயிரம் ரூபாய்", 2000, "high"),
        ("ஐநூறுக்கு விற்றேன்", 500, "low"),
    ]

    def test_cases(self):
        for text, amount, conf in self.CASES:
            r = extract_rupees(text)
            self.assertEqual((r["amount"], r["confidence"]), (amount, conf), text)

    def test_nothing_and_ambiguous(self):
        self.assertIsNone(extract_rupees("இன்று நன்றாக இருந்தது")["amount"])
        r = extract_rupees("ஐநூறு ரூபாய் மற்றும் ஆயிரம் ரூபாய்")
        self.assertIsNone(r["amount"])  # two different amounts: needs review


if __name__ == "__main__":
    unittest.main()
