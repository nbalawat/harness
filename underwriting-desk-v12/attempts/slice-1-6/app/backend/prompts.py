"""prompt-registry module: prompts as versioned data. See agent-guide."""
import string

_registry: dict[str, list] = {}


def register(name, text, version=1):
    _registry.setdefault(name, []).append({"version": version, "text": text})
    _registry[name].sort(key=lambda p: p["version"])


def get(name):
    if name not in _registry:
        raise KeyError(f"unknown prompt '{name}'")
    return _registry[name][-1]


def render(name, **vars):
    template = get(name)["text"]
    try:
        return string.Template(template).substitute(**vars)
    except KeyError as e:
        raise KeyError(f"prompt '{name}' missing variable {e}")


def catalog():
    return {name: [p["version"] for p in versions] for name, versions in _registry.items()}
