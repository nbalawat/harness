"""corpus-refresh module: atomic knowledge re-index. See agent-guide."""
import os

import doc_extract
import rag

index = rag.Index()


def rebuild(corpus_dir):
    fresh = rag.Index()
    report = {"indexed": [], "skipped": []}
    for fname in sorted(os.listdir(corpus_dir)) if os.path.isdir(corpus_dir) else []:
        path = os.path.join(corpus_dir, fname)
        if not os.path.isfile(path):
            continue
        result = doc_extract.extract(path)
        if result["text"]:
            fresh.add(fname, result["text"])
            report["indexed"].append(fname)
        else:
            report["skipped"].append({"file": fname, "warnings": result["warnings"]})
    global index
    index = fresh
    return report
