# Deploy plan (Cloud Run)

Modules: persistence-core, agent-runtime, chat-shell, postgres-adapter, migrations, seed-data, auth-basic, rbac, row-level-security, permissions-ui, audit-log, audit-view, row-history, approval-flow, state-machine, workflow-engine, assignment, sla-timers, agent-router, tool-registry, eval-harness, prompt-registry, transcript-store, pii-redaction, rag-core, citation-tracker, search-index, versioned-drafts, blob-store, file-upload, forms-engine, data-table, record-detail, dashboard-cards, notifications-ui, screen-router, env-config, structured-logging, secrets-manager, health-plus

1. Build + push backend image (Cloud Build)
2. Apply service.yaml via gcloud run services replace
3. Smoke test /health
