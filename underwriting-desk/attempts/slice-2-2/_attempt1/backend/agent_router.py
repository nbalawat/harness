"""agent-router module: declarative message routing. See agent-guide."""
import re


def route(message, rules, default):
    text = str(message).lower()
    for rule in rules:
        for kw in rule.get("keywords", []):
            if kw.lower() in text:
                return rule["agent"]
        pattern = rule.get("pattern")
        if pattern and re.search(pattern, message, re.IGNORECASE):
            return rule["agent"]
    return default
