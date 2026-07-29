"""data-classification module: sensitivity as data-model policy. See agent-guide."""

LEVELS = ["public", "internal", "confidential", "restricted"]
_levels: dict = {}


def set_level(table, column, level):
    if level not in LEVELS:
        raise ValueError(f"unknown level '{level}'")
    _levels[(table, column)] = level


def level_of(table, column):
    return _levels.get((table, column), "internal")


def restrict(table, rows):
    out = []
    for row in rows:
        masked = dict(row)
        for column in row:
            if level_of(table, column) == "restricted":
                masked[column] = "[restricted]"
        out.append(masked)
    return out
