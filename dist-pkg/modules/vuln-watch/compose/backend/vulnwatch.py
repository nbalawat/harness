"""vuln-watch module: local advisory scan. See agent-guide."""
import json
import os
import re


def _parse_requirements(path):
    pins = {}
    if not os.path.exists(path):
        return pins
    for line in open(path, encoding="utf-8"):
        m = re.match(r"\s*([A-Za-z0-9_.-]+)\s*==\s*([0-9][\w.]*)", line)
        if m:
            pins[m.group(1).lower()] = m.group(2)
    return pins


def scan(requirements_path, advisories):
    pins = _parse_requirements(requirements_path)
    findings = []
    for adv in advisories:
        pkg = adv["package"].lower()
        if pkg in pins and pins[pkg] in adv.get("affected_versions", []):
            findings.append({"package": pkg, "version": pins[pkg], "severity": adv.get("severity", "unknown"), "advisory": adv.get("id")})
    return findings
