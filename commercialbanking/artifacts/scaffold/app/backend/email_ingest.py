"""email-ingest module: .eml drop-dir intake. See agent-guide."""
import email
import email.policy
import os


def parse_eml(path):
    with open(path, "rb") as f:
        msg = email.message_from_binary_file(f, policy=email.policy.default)
    body_part = msg.get_body(preferencelist=("plain", "html"))
    body = body_part.get_content() if body_part else ""
    if body_part and body_part.get_content_type() == "text/html":
        import re

        body = re.sub(r"<[^>]+>", " ", body)
    return {"from": str(msg["From"] or ""), "subject": str(msg["Subject"] or ""), "body": " ".join(str(body).split())}


def scan_dropdir(dropdir, store):
    seen = {r["filename"] for r in store.list("_ingested_mail")}
    ingested = []
    for fname in sorted(os.listdir(dropdir)) if os.path.isdir(dropdir) else []:
        if not fname.endswith(".eml") or fname in seen:
            continue
        parsed = parse_eml(os.path.join(dropdir, fname))
        store.insert("_ingested_mail", {"filename": fname, **parsed})
        ingested.append(fname)
    return ingested
