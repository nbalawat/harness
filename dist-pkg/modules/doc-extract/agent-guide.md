# doc-extract — agent guide

All document text enters through extract() — never parse files inline
in endpoints. Unsupported/failed extractions return warnings, they don't crash
ingestion. PDFs use pdftotext when installed; otherwise the warning says so
explicitly (no silent empty text).
