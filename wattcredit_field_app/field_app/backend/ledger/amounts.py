"""Extract a rupee amount from a Tamil (or Tamil/English mixed) transcript.

Covers: Western digits ("1,500"), Tamil digits (௧௫௦), common Tamil number words
(hundreds, thousands, 1-19, round tens, oblique forms such as "ஆயிரத்து ஐநூறு"),
and basic English number words. Compound tens such as 21-99 ("இருபத்தைந்து") are NOT
covered: those come back as needs-review. Always keep a human confirmation path.
"""
import re

TAMIL_DIGITS = {ord(c): str(i) for i, c in enumerate("௦௧௨௩௪௫௬௭௮௯")}

UNITS = {"ஒன்று": 1, "ஒரு": 1, "இரண்டு": 2, "மூன்று": 3, "நான்கு": 4, "ஐந்து": 5, "ஆறு": 6, "ஏழு": 7, "எட்டு": 8,
         "ஒன்பது": 9, "பத்து": 10, "பதினொன்று": 11, "பன்னிரண்டு": 12, "பதிமூன்று": 13, "பதினான்கு": 14,
         "பதினைந்து": 15, "பதினாறு": 16, "பதினேழு": 17, "பதினெட்டு": 18, "பத்தொன்பது": 19,
         "இருபது": 20, "முப்பது": 30, "நாற்பது": 40, "ஐம்பது": 50, "அறுபது": 60, "எழுபது": 70, "எண்பது": 80,
         "தொண்ணூறு": 90}
HUNDREDS = {"நூறு": 100, "இருநூறு": 200, "முந்நூறு": 300, "நானூறு": 400, "ஐநூறு": 500, "அறுநூறு": 600,
            "எழுநூறு": 700, "எண்ணூறு": 800, "தொள்ளாயிரம்": 900,
            # oblique forms used before another number: நூற்று ஐம்பது = 150
            "நூற்று": 100, "இருநூற்று": 200, "முந்நூற்று": 300, "நானூற்று": 400, "ஐநூற்று": 500,
            "அறுநூற்று": 600, "எழுநூற்று": 700, "எண்ணூற்று": 800, "தொள்ளாயிரத்து": 900}
THOUSANDS = {"ஆயிரம்": 1000, "ஆயிரத்து": 1000, "இரண்டாயிரம்": 2000, "மூவாயிரம்": 3000, "நாலாயிரம்": 4000,
             "ஐயாயிரம்": 5000, "ஆறாயிரம்": 6000, "ஏழாயிரம்": 7000, "எட்டாயிரம்": 8000, "ஒன்பதாயிரம்": 9000,
             "பத்தாயிரம்": 10000, "இருபதாயிரம்": 20000, "இரண்டாயிரத்து": 2000, "மூவாயிரத்து": 3000,
             "நாலாயிரத்து": 4000, "ஐயாயிரத்து": 5000, "பத்தாயிரத்து": 10000}
EN = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
      "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
EN_MULT = {"hundred": 100, "thousand": 1000}
CASE_SUFFIX = ("", "க்கு", "க்கும்", "ஐ", "ஆக", "ல்", "ாக")
RUPEE_MARK = re.compile(r"^(ரூபா|ரூ$|ரூ\.|₹|rs\.?$|rupee|inr)", re.I)


def _lookup(tok, table):
    for key, val in table.items():
        for suf in CASE_SUFFIX:
            if tok == key + suf:
                return val
    return None


def _classify(tok):
    """-> ('num', n) | ('add', n) | ('mul', n) | ('rupee', 0) | ('other', 0)"""
    t = tok.translate(TAMIL_DIGITS).lower()
    if RUPEE_MARK.match(t):
        return "rupee", 0
    if re.fullmatch(r"\d{1,3}(,\d{2,3})+(\.\d+)?|\d+(\.\d+)?", t):
        return "num", int(round(float(t.replace(",", ""))))
    if t in EN:
        return "add", EN[t]
    if t in EN_MULT:
        return "mul", EN_MULT[t]
    for table, kind in ((THOUSANDS, "thou"), (HUNDREDS, "add"), (UNITS, "add")):
        v = _lookup(t, table)
        if v is not None:
            return kind, v
    return "other", 0


def extract_rupees(text: str):
    """Return dict(amount, confidence, candidates). amount is whole rupees or None.

    confidence: 'high' (exactly one distinct amount next to a rupee word),
                'low'  (a number was found but is ambiguous or has no rupee word),
                None   (nothing found).
    """
    text = text.replace("₹", " ₹ ")
    toks = [t for t in re.split(r"[\s​]+", text.strip()) if t]
    toks = [t.strip(".,;:!?()\"'") if not re.fullmatch(r"[\d,.]+", t) else t.strip(".;:!?") for t in toks]
    toks = [t for t in toks if t]
    cands, i = [], 0
    kinds = [_classify(t) for t in toks]
    while i < len(toks):
        k, v = kinds[i]
        if k in ("num", "add", "mul", "thou"):
            total = cur = 0
            j = i
            while j < len(toks) and kinds[j][0] in ("num", "add", "mul", "thou"):
                kk, vv = kinds[j]
                if kk == "num":
                    cur += vv
                elif kk == "add":
                    cur += vv
                elif kk == "mul" and vv == 100:
                    cur = (cur or 1) * 100
                elif kk == "mul":
                    total += (cur or 1) * vv
                    cur = 0
                elif kk == "thou":
                    if vv == 1000 and cur:
                        total += cur * 1000
                    else:
                        total += vv
                    cur = 0
                j += 1
            near = (i > 0 and kinds[i - 1][0] == "rupee") or (j < len(toks) and kinds[j][0] == "rupee")
            if total + cur > 0:
                cands.append({"amount": total + cur, "near_rupee": near})
            i = j
        else:
            i += 1
    near = sorted({c["amount"] for c in cands if c["near_rupee"]})
    if len(near) == 1:
        return {"amount": near[0], "confidence": "high", "candidates": cands}
    allv = sorted({c["amount"] for c in cands})
    if len(allv) == 1:
        return {"amount": allv[0], "confidence": "low", "candidates": cands}
    if allv:
        return {"amount": None, "confidence": "low", "candidates": cands}
    return {"amount": None, "confidence": None, "candidates": []}
