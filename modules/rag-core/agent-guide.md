# rag-core — agent guide

All grounding retrieval goes through rag.Index — never ad-hoc keyword
scans. Chunk documents before indexing (chunk() preserves sentence boundaries).
retrieve() returns (chunk, score, doc_id) tuples ranked deterministically;
always pass sources through to citation-tracker so answers say where they came
from.
