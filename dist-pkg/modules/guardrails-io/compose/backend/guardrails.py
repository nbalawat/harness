"""guardrails-io module: I/O policy filters. See agent-guide."""
import re

import pii

_INJECTION = [
    r"ignore (all|previous|prior) instructions",
    r"system prompt",
    r"you are now",
]


def check_input(text, fences=None):
    flags = []
    lower = str(text).lower()
    for pattern in _INJECTION:
        if re.search(pattern, lower):
            flags.append(f"injection:{pattern}")
    for fence in fences or []:
        if fence.lower() in lower:
            flags.append(f"topic-fence:{fence}")
    return {"ok": not flags, "flags": flags}


def check_output(text):
    findings = pii.detect(text)
    flags = [f"pii:{kind}" for kind, _ in findings]
    return {"ok": not flags, "flags": flags}
