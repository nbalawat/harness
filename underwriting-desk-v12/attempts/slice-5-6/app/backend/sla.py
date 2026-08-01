"""sla-timers module: deterministic clock math. See agent-guide."""
import datetime


def _parse(iso):
    return datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))


def due_at(start_iso, hours):
    return (_parse(start_iso) + datetime.timedelta(hours=hours)).isoformat()


def status(start_iso, hours, now=None):
    start = _parse(start_iso)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    consumed = (now - start).total_seconds() / (hours * 3600)
    if consumed >= 1:
        return "breached"
    if consumed >= 0.8:
        return "at_risk"
    return "ok"
