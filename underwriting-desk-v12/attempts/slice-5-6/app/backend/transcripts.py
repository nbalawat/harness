"""transcript-store module: redacted agent transcripts. See agent-guide."""
import pii
from db import store


def append(conversation_id, role, text):
    return store.insert("_transcripts", {"conversation_id": conversation_id, "role": role, "text": pii.redact(str(text))})


def get(conversation_id):
    return [t for t in store.list("_transcripts") if t["conversation_id"] == conversation_id]
