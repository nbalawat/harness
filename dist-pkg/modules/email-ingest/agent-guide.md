# email-ingest — agent guide

Mail arrives as .eml files in a drop directory (the relay writes
them). scan_dropdir ingests new files into the store (deduped by filename) —
schedule it, don't inotify. HTML-only mail falls back to stripped text; body
PII policy is transcript-store's redaction if the app stores bodies long-term.
