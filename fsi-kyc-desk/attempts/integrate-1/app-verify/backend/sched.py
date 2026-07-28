"""scheduling module: tick-driven jobs. See agent-guide."""
import time as _time

_jobs = {}


def register(name, every_seconds, fn):
    _jobs[name] = {"every": every_seconds, "fn": fn, "last_run": None, "failures": 0}


def run_due(now=None):
    now = now if now is not None else _time.monotonic()
    ran = []
    for name, job in sorted(_jobs.items()):
        if job["last_run"] is None or now - job["last_run"] >= job["every"]:
            try:
                job["fn"]()
            except Exception:
                job["failures"] += 1
            job["last_run"] = now
            ran.append(name)
    return ran


def jobs():
    return {name: {"every": j["every"], "failures": j["failures"]} for name, j in _jobs.items()}
