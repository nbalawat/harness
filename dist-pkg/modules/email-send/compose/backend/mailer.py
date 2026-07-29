"""email-send module: templated, suppressible mail. See agent-guide."""
import string

from db import store

_templates = {}


def register_template(name, subject, body):
    _templates[name] = {"subject": subject, "body": body}


def suppress(address, reason="unsubscribed"):
    store.insert("_mail_suppressions", {"address": address.lower(), "reason": reason})


def is_suppressed(address):
    return any(s["address"] == address.lower() for s in store.list("_mail_suppressions"))


def send(to, template, vars=None):
    if template not in _templates:
        raise KeyError(f"unknown mail template '{template}'")
    if is_suppressed(to):
        return store.insert("_mail_outbox", {"to": to, "template": template, "status": "suppressed"})
    t = _templates[template]
    rendered = {
        "subject": string.Template(t["subject"]).substitute(**(vars or {})),
        "body": string.Template(t["body"]).substitute(**(vars or {})),
    }
    return store.insert("_mail_outbox", {"to": to, "template": template, "status": "queued", **rendered})
