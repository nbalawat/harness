"""env-config module: typed configuration. See agent-guide."""
import os


class ConfigError(Exception):
    pass


_CASTS = {
    "str": str,
    "int": int,
    "float": float,
    "bool": lambda v: str(v).lower() in ("1", "true", "yes", "on"),
}


def load(spec, env=None):
    env = env if env is not None else os.environ
    config, problems = {}, []
    for name, rules in spec.items():
        raw = env.get(name)
        if raw is None or raw == "":
            if rules.get("required"):
                problems.append(f"{name} is required")
                continue
            config[name] = rules.get("default")
            continue
        try:
            config[name] = _CASTS[rules.get("type", "str")](raw)
        except (ValueError, KeyError):
            problems.append(f"{name} must be {rules.get('type', 'str')} (got '{raw}')")
    if problems:
        raise ConfigError("; ".join(problems))
    return config
