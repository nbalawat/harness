"""chat-shell support: register the conversation-history table.

The chat shell's history panel (frontend/app.js -> GET /api/conversations) and
the seed-data fixtures (ext_seed.SEEDS) both address a `conversations` table.
It belongs to the chat-shell module, not to the approved KYC data model, so it
is registered here instead of by hand-editing the generated models.py.
"""
from models import TABLES

TABLES.setdefault("conversations", ["id", "user", "created_at", "message", "reply"])
