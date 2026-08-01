"""structured-logging module: JSON lines with bound context. See agent-guide."""
import contextvars
import json
import sys
import time

_context = contextvars.ContextVar("slog_context", default={})


def bind(**fields):
    _context.set({**_context.get(), **fields})


def clear():
    _context.set({})


def _emit(level, event, fields, stream=None):
    line = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "level": level, "event": event, **_context.get(), **fields}
    (stream or sys.stdout).write(json.dumps(line) + "\n")
    return line


def info(event, stream=None, **fields):
    return _emit("info", event, fields, stream)


def warn(event, stream=None, **fields):
    return _emit("warn", event, fields, stream)


def error(event, stream=None, **fields):
    return _emit("error", event, fields, stream)
