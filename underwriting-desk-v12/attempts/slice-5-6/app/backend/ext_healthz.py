"""health-plus module: readiness with components. See agent-guide."""
from fastapi import APIRouter

import agent_runtime
from db import store

router = APIRouter()
_checks = {}


def register(name, fn):
    _checks[name] = fn


def _store_check():
    row = store.insert("_healthz", {"probe": True})
    ok = any(r["id"] == row["id"] for r in store.list("_healthz"))
    return ok, f"write+read ok (row {row['id']})"


def _engine_check():
    mode = agent_runtime.mode()
    return True, f"mode={mode['mode']}"


@router.get("/healthz")
def healthz():
    components = {}
    for name, fn in {"store": _store_check, "agent_engine": _engine_check, **_checks}.items():
        try:
            ok, detail = fn()
        except Exception as e:
            ok, detail = False, str(e)[:120]
        components[name] = {"ok": ok, "detail": detail}
    return {"ok": all(c["ok"] for c in components.values()), "components": components}
