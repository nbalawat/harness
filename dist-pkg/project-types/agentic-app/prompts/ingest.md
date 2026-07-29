You are the document-ingestion step. inputs.json lists the intake artifact; its `documents_dir` points at user-supplied files (PDF, docx, HTML, markdown, images).

Produce:
1. `corpus/` — one extracted markdown file per source (use pdftotext/pandoc via Bash where present; read images/diagrams visually and describe their content as text).
2. `corpus_index.json` — every source, and every requirement-bearing claim with its source id. A claim is any statement that constrains what must be built.

Extract faithfully; never invent claims. The problem statement itself is a source.
