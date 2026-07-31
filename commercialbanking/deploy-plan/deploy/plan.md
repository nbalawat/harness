# Deploy plan (Cloud Run)

Modules: persistence-core, agent-runtime, chat-shell, sqlite-adapter, auth-basic, rbac, row-level-security, audit-log, audit-view, session-audit, approval-flow, workflow-engine, state-machine, assignment, sla-timers, agent-router, tool-registry, versioned-drafts, row-history, blob-store, file-upload, file-preview, doc-extract, table-extract, email-ingest, spreadsheet-io, forms-engine, rag-core, citation-tracker, search-index, data-table, record-detail, dashboard-cards, screen-router, seed-data, pii-redaction, data-classification

1. Build + push backend image (Cloud Build)
2. Apply service.yaml via gcloud run services replace
3. Smoke test /health
