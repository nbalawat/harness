# citation-tracker — agent guide

Wrap every grounded answer with citations.attach(text, sources) where
sources come from rag retrieval results. render() produces the user-facing
form with [1][2] markers. An answer with no sources must say so explicitly —
attach() with empty sources marks it ungrounded rather than hiding it.
