"""FSI hardening guard over the scaffold's generic /api/{table} surface.

The deal of record is governed: a deal may only be created through POST /deals,
which resolves a named actor, derives the exposure tier deterministically, runs
the approved workflow and appends an audit row. The scaffold's generic
/api/{table} catch-all would otherwise be an unauthenticated side door around
every one of those controls, so writes to the governed tables are refused here
and the refusal itself is audited.

Reads of the governed tables are also scrubbed of credential material — the
generic reader has no column policy of its own.

Implemented as ASGI middleware rather than a route so it cannot be shadowed by
main.py's trailing /api/{table} catch-all.
"""
import json
import re

from fastapi.responses import JSONResponse

import ext_audit

#: Shape of a blob the app wrote for a deal: "<deal_reference>-NN-<file>.txt".
_DOCUMENT_BLOB_RE = re.compile(r"^[A-Za-z0-9._-]+?-\d{2}-.*\.txt$")

#: Tables that make up the deal of record. Every one of them has a guarded
#: endpoint that owns its writes (POST /deals, /deals/{ref}/triage, the draft
#: review gate, the audit appender). None of them may be written generically.
GOVERNED_TABLES = frozenset(
    {
        "deals",
        "documents",
        "document_locations",
        "spread_line_items",
        "citations",
        "ratios",
        "risk_grades",
        "policy_rules",
        "policy_exceptions",
        "memos",
        "agent_runs",
        "agent_drafts",
        "approvals",
        "declines",
        "stage_transitions",
        "audit_log",
        "users",
        "analyst_queues",
    }
)

WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

#: Credential / secret material never leaves the app through a generic reader.
SENSITIVE_FIELDS = frozenset(
    {"password_hash", "password", "borrower_tin", "api_key", "secret", "token", "mfa_secret"}
)


#: Borrower document bodies. Confidential to the borrower and only ever needed
#: through a deal-scoped endpoint — a generic table reader or a whole-table CSV
#: dump has no business emitting them.
DOCUMENT_CONTENT_FIELDS = frozenset({"extracted_text"})


def scrub(value):
    """Recursively drop sensitive keys from a JSON-shaped value."""
    if isinstance(value, dict):
        return {
            k: scrub(v)
            for k, v in value.items()
            if k not in SENSITIVE_FIELDS and k not in DOCUMENT_CONTENT_FIELDS
        }
    if isinstance(value, list):
        return [scrub(item) for item in value]
    return value


def _table_of(path: str) -> str | None:
    if path.startswith("/api/"):
        rest = path[len("/api/") :].strip("/")
        return rest if rest and "/" not in rest else None
    # The generic CSV exporter reaches the same rows by another door, so it is
    # governed by the same rule — otherwise /export/agent_drafts.csv is a
    # whole-portfolio dump of every spread and its citations.
    if path.startswith("/export/") and path.endswith(".csv"):
        rest = path[len("/export/") : -len(".csv")].strip("/")
        return rest if rest and "/" not in rest else None
    return None


def _reader_is_entitled(request) -> bool:
    """A generic read of the deal of record needs the same named, active,
    internal seat the guarded endpoints demand.

    Imported lazily: this middleware installs before the domain module is
    fully wired, and a module-level import would be a cycle.
    """
    try:
        import underwriting as uw
        from ext_auth import current_user
    except Exception:
        # FAIL CLOSED. Returning True here would silently reopen the whole
        # deal of record to anonymous callers on any import hiccup — and
        # because the refusal branch is skipped, nothing would even record
        # that the control was off. A control that disables itself quietly is
        # worse than no control.
        return False
    named = request.query_params.get("acting_user")
    try:
        # The generic reader hands back the WHOLE table — it has no way to
        # apply the row scoping /deals and /drafts apply (a relationship
        # manager sees only the deals they submitted). So it is limited to the
        # seats that are entitled to the whole book anyway; a row-scoped seat
        # reads through the endpoints that scope it, not around them.
        uw.resolve_actor(current_user(request.headers.get("authorization")), named, uw.PORTFOLIO_WIDE_ROLES)
    except Exception:
        return False
    return True


def install(app):
    @app.middleware("http")
    async def govern_generic_table_api(request, call_next):
        path = request.url.path

        # The audit trail is the examiner's record. The app appends to it in
        # process on every state change; an HTTP caller appending arbitrary
        # events would let a forged entry sit beside the genuine ones.
        if path == "/audit" and request.method in WRITE_METHODS:
            return JSONResponse(
                status_code=403,
                content={
                    "detail": (
                        "the audit trail is append-only and written by the app itself; "
                        "it cannot be posted to directly"
                    )
                },
            )

        # Stored borrower document text is reachable by blob name, and blob
        # names are disclosed as `storage_path` on the deal record. Reading one
        # through the generic file endpoint would route around deal scoping.
        if path.startswith("/files/") and _DOCUMENT_BLOB_RE.match(path[len("/files/"):]):
            return JSONResponse(
                status_code=403,
                content={
                    "detail": (
                        "this blob is borrower document text belonging to a deal; "
                        "read it through the deal endpoint that scopes it"
                    )
                },
            )

        table = _table_of(request.url.path)
        if table is None or table not in GOVERNED_TABLES:
            return await call_next(request)

        if request.method in WRITE_METHODS:
            ext_audit.record(
                "api.generic_write_refused",
                {
                    "table": table,
                    "method": request.method,
                    "reason": "the deal of record is written only through its guarded endpoints",
                },
            )
            return JSONResponse(
                status_code=403,
                content={
                    "detail": (
                        f"'{table}' is part of the deal of record and cannot be written through the "
                        "generic table API; use the guarded endpoint that owns it so identity, "
                        "role, deterministic derivation and the audit row are applied"
                    )
                },
            )

        # Sealing only the WRITE side left the whole gate walkable from the
        # other direction: GET /api/agent_drafts hands back draft_content —
        # every deal's spread and its citations — and /api/spread_line_items
        # the promoted figures themselves. A generic read of the deal of
        # record is deny-by-default, exactly like the Draft Review queue.
        if request.method == "GET" and not _reader_is_entitled(request):
            ext_audit.record(
                "api.generic_read_refused",
                {
                    "table": table,
                    "method": request.method,
                    "reason": "the deal of record is read only by a named, active internal seat",
                },
            )
            return JSONResponse(
                status_code=403,
                content={
                    "detail": (
                        f"'{table}' is part of the deal of record; name yourself (sign in or send "
                        "acting_user) and read it through the endpoint that scopes it to your role"
                    )
                },
            )

        response = await call_next(request)
        if request.method != "GET" or response.status_code != 200:
            return response

        # The scrub below is a JSON transform. /export/{table}.csv is now
        # governed by the same rule, and running its CSV through json.loads
        # would replace the examiner's export with {"detail": "unreadable"} —
        # so hand non-JSON responses straight back. The exporter already drops
        # credential and document-content columns at the source.
        if not str(response.headers.get("content-type", "")).startswith("application/json"):
            return response

        body = b"".join([chunk async for chunk in response.body_iterator])
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return JSONResponse(status_code=response.status_code, content={"detail": "unreadable"})
        return JSONResponse(status_code=200, content=scrub(payload))
