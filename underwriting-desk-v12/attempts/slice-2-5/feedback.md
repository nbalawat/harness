The user reviewed this step's previous output and requested changes:

SECURITY REMEDIATION (audit highs/mediums in YOUR files) — rebase on the revised foundation first, then fix:
1. HIGH default-deny: backend/ext_spread_ratios_and_risk_grade.py _readable_deal (~line 679) uses OPT-OUT authorization ("if acting_user_email:") — anonymous callers skip scoping entirely. Replace with the foundation's fail-closed identity.require_actor(acting_user_email) (raises 401 when identity is absent), then scope. Sweep this whole file for EVERY "if acting_user_email:" and every scoped read/mutation and make them fail-closed.
2. HIGH read-route mutation: GET /api/deals/{deal_code}/ratios (~1021) computes AND persists when no rows exist — a GET must never write. Move computation to spread acceptance; the GET returns 404/empty if not yet computed.
3. HIGH validation: run_financial_spreading (~752) rejects only zero-document deals; enforce verify_required_documents' completeness before spreading. FigureIn.value/line_item_key and DocumentAttachRequest.document_type must be constrained (enums/bounds), not free.
4. HIGH merge-seam DOM ids: your deal-detail screen shares element ids (decision-approve-btn, decision-decline-btn, etc.) with slice-4's screen — double-binds after merge. Prefix every id your screen-deal-detail section adds with "dd-" (dd-decision-approve-btn …) and update your app.js append + demo/slice-2.json selectors to match.
NEGATIVE ACCEPTANCE: add checks proving an ANONYMOUS request (no acting_user_email) to your scoped reads returns 401. Every recorded acceptance check must keep passing; app.js stays a pure append.


The previously committed output is at: /Users/nbalawat/development/harness/underwriting-desk-v12/artifacts/slice-2
Start from it and apply ONLY the requested changes — keep everything else stable.