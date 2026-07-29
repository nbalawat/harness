"""input-sanitizer module: request-text hardening. See agent-guide."""
import html
import re


class InputTooLong(Exception):
    pass


def clean(text, max_len=10000):
    out = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", str(text))
    out = re.sub(r"[ \t]+", " ", out).strip()
    if len(out) > max_len:
        raise InputTooLong(f"input exceeds {max_len} chars")
    return out


def escape_html(text):
    return html.escape(str(text), quote=True)
