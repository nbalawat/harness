"""search-index module: deterministic text search. See agent-guide."""
import re
from collections import defaultdict

from db import store


def _tokens(text):
    return [t for t in re.split(r"[^a-z0-9]+", str(text).lower()) if len(t) > 1]


class Index:
    def __init__(self):
        self._postings = defaultdict(lambda: defaultdict(int))
        self._docs = {}

    def add(self, doc_id, text):
        self._docs[doc_id] = str(text)
        for t in _tokens(text):
            self._postings[t][doc_id] += 1

    def search(self, query, limit=20):
        scores = defaultdict(int)
        for t in _tokens(query):
            for doc_id, n in self._postings.get(t, {}).items():
                scores[doc_id] += n
        ranked = sorted(scores.items(), key=lambda kv: (-kv[1], str(kv[0])))
        return [{"id": d, "score": s, "text": self._docs[d][:200]} for d, s in ranked[:limit]]


index = Index()


def index_table(table, text_fields):
    for row in store.list(table):
        text = " ".join(str(row.get(f, "")) for f in text_fields)
        index.add(f"{table}:{row['id']}", text)
