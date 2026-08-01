"""secrets-manager module: env-backed secrets + source scanner. See agent-guide."""
import os
import re


class MissingSecret(Exception):
    pass


def get(name, required=True, default=None):
    value = os.environ.get(name, default)
    if required and not value:
        raise MissingSecret(f"secret '{name}' is not set")
    return value


_LITERAL = re.compile(r"(api[_-]?key|secret|password|token)\s*=\s*[\"'][A-Za-z0-9+/_-]{12,}[\"']", re.IGNORECASE)


def scan_source(root):
    findings = []
    for dirpath, _dirs, files in os.walk(root):
        if "__pycache__" in dirpath or "module_tests" in dirpath:
            continue
        for fname in files:
            if not fname.endswith((".py", ".js")):
                continue
            path = os.path.join(dirpath, fname)
            with open(path, encoding="utf-8", errors="ignore") as f:
                for i, line in enumerate(f, 1):
                    if _LITERAL.search(line):
                        findings.append({"file": path, "line": i})
    return findings
