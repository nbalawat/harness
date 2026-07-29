"""tool-registry module: roster-enforced tool invocation. See agent-guide."""

_tools: dict = {}


class ToolDenied(Exception):
    pass


def register(name, fn):
    _tools[name] = fn


def invoke(agent, name, **kwargs):
    allowed = set(agent.get("tools", []))
    denied = set(agent.get("denied_tools", []))
    if name in denied:
        raise ToolDenied(f"agent '{agent['name']}' is explicitly denied tool '{name}'")
    if name not in allowed:
        raise ToolDenied(f"agent '{agent['name']}' is not allowed tool '{name}'")
    if name not in _tools:
        raise KeyError(f"tool '{name}' not registered")
    return _tools[name](**kwargs)
