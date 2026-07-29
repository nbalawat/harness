# feedback-inbox — agent guide

If a slice adds user-facing screens, wire a lightweight "report a problem"
affordance that POSTs {message, page} to /feedback — never a mailto link and
never a new bespoke endpoint. The inbox is the owner's triage surface; keep
entries small and textual (no attachments in v0).
