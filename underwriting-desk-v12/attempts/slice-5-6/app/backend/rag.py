"""rag-core module: chunking + tf-idf retrieval. See agent-guide."""
import math
import re
from collections import Counter, defaultdict


def chunk(text, size=400):
    sentences = re.split(r"(?<=[.!?])\s+", str(text).strip())
    chunks, current = [], ""
    for s in sentences:
        if current and len(current) + len(s) > size:
            chunks.append(current.strip())
            current = ""
        current += " " + s
    if current.strip():
        chunks.append(current.strip())
    return chunks


def _tokens(text):
    return [t for t in re.split(r"[^a-z0-9]+", str(text).lower()) if len(t) > 1]


class Index:
    def __init__(self):
        self._chunks = []
        self._df = Counter()

    def add(self, doc_id, text):
        for piece in chunk(text):
            tokens = Counter(_tokens(piece))
            self._chunks.append({"doc_id": doc_id, "text": piece, "tokens": tokens})
            for t in tokens:
                self._df[t] += 1

    def retrieve(self, query, k=3):
        n = max(len(self._chunks), 1)
        scores = []
        for i, c in enumerate(self._chunks):
            score = 0.0
            for t in _tokens(query):
                if t in c["tokens"]:
                    score += c["tokens"][t] * math.log(1 + n / self._df[t])
            if score > 0:
                scores.append((score, i))
        scores.sort(key=lambda si: (-si[0], si[1]))
        return [{"doc_id": self._chunks[i]["doc_id"], "text": self._chunks[i]["text"], "score": round(s, 4)} for s, i in scores[:k]]
