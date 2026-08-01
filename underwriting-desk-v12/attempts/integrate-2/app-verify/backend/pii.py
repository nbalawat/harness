"""pii-redaction module: detect + mask. See agent-guide."""
import re

_PATTERNS = {
    "email": re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
    "phone": re.compile(r"\b(?:\+?1[-. ]?)?(?:\(?\d{3}\)?[-. ]?)\d{3}[-. ]?\d{4}\b"),
    "ssn": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
}
_CARDISH = re.compile(r"\b(?:\d[ -]?){13,19}\b")


def _luhn_ok(digits):
    total, alt = 0, False
    for d in reversed(digits):
        n = int(d)
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alt = not alt
    return total % 10 == 0


def detect(text):
    text = str(text)
    findings = [(kind, m.group(0)) for kind, pattern in _PATTERNS.items() for m in pattern.finditer(text)]
    for m in _CARDISH.finditer(text):
        digits = re.sub(r"\D", "", m.group(0))
        if 13 <= len(digits) <= 19 and _luhn_ok(digits):
            findings.append(("card", m.group(0)))
    return findings


def redact(text):
    out = str(text)
    for kind, match in detect(out):
        out = out.replace(match, f"[{kind}]")
    return out
