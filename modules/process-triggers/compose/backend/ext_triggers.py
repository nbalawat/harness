"""process-triggers module: the ways a business process starts in an enterprise.

A process instance can be triggered by:
  - human.internal   — an employee action (a form, a button)
  - human.external    — an external client action (a portal submission, a request)
  - event             — an event from another system (a webhook / message)
  - schedule          — a time-based trigger (cron-style; stubbed clock here)
  - system            — an internal system event

Every trigger creates a work item and starts the process via the engine, so the
same process runs no matter how it was kicked off. Real enterprises wire these
to identity, message buses, and schedulers; here they are real endpoints + a
stub scheduler, so the architecture is faithful and runs locally.
"""
from fastapi import APIRouter, Header
from pydantic import BaseModel

import workflow_engine
from ext_audit import record as audit

router = APIRouter(prefix="/api/triggers")

# The process each trigger starts (single-process apps use the first defined).
def _process_name():
    defs = workflow_engine.definitions()
    return defs[0]["name"] if defs else None


class TriggerInput(BaseModel):
    inputs: dict = {}
    source: str | None = None


def _fire(kind, req, actor):
    name = _process_name()
    run_id = workflow_engine.start(name, {**req.inputs, "_trigger": kind, "_source": req.source or actor})
    audit("process.triggered", {"trigger": kind, "run": run_id, "source": req.source or actor}, actor=actor)
    st = workflow_engine.state(run_id)
    return {"run_id": run_id, "trigger": kind, "status": st["status"]}


@router.get("")
def trigger_catalog():
    """What can start this process — the enterprise trigger surface."""
    return {"triggers": [
        {"kind": "human.internal", "label": "Internal user action", "how": "POST /api/triggers/human/internal"},
        {"kind": "human.external", "label": "External client submission", "how": "POST /api/triggers/human/external"},
        {"kind": "event", "label": "System event / webhook", "how": "POST /api/triggers/event"},
        {"kind": "schedule", "label": "Scheduled run", "how": "POST /api/triggers/schedule/tick (stub clock)"},
        {"kind": "system", "label": "Internal system event", "how": "POST /api/triggers/system"},
    ]}


@router.post("/human/internal")
def human_internal(req: TriggerInput, x_user_email: str | None = Header(default=None)):
    return _fire("human.internal", req, x_user_email or "internal-user")


@router.post("/human/external")
def human_external(req: TriggerInput):
    # external clients are unauthenticated by nature; the process itself gates decisions
    return _fire("human.external", req, req.source or "external-client")


@router.post("/event")
def event(req: TriggerInput):
    return _fire("event", req, req.source or "event-bus")


@router.post("/system")
def system_event(req: TriggerInput):
    return _fire("system", req, req.source or "system")


# Stub scheduler: in production a cron/scheduler fires this; locally you POST a
# tick (optionally with a batch of items) to simulate the scheduled run.
class ScheduleTick(BaseModel):
    batch: list[dict] = []


@router.post("/schedule/tick")
def schedule_tick(req: ScheduleTick):
    started = [_fire("schedule", TriggerInput(inputs=item, source="scheduler"), "scheduler") for item in (req.batch or [{}])]
    return {"fired": len(started), "runs": started}
