"""citation-tracker module: says-who structure. See agent-guide."""


def attach(answer, sources):
    return {
        "answer": str(answer),
        "grounded": bool(sources),
        "sources": [{"n": i + 1, "doc_id": s["doc_id"], "excerpt": s["text"][:120]} for i, s in enumerate(sources)],
    }


def render(cited):
    if not cited["grounded"]:
        return cited["answer"] + "\n\n(No sources — this answer is not grounded in the corpus.)"
    marks = " ".join(f"[{s['n']}]" for s in cited["sources"])
    lines = [f"[{s['n']}] {s['doc_id']}: {s['excerpt']}" for s in cited["sources"]]
    return f"{cited['answer']} {marks}\n\nSources:\n" + "\n".join(lines)
