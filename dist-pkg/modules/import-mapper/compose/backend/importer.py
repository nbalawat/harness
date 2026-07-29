"""import-mapper module: two-phase data onboarding. See agent-guide."""
import forms
from db import store


def plan(rows, mapping, schema):
    valid, invalid = [], []
    for i, row in enumerate(rows):
        mapped = {target: row.get(source) for source, target in mapping.items()}
        result = forms.validate(schema, mapped)
        if result["ok"]:
            valid.append(result["cleaned"])
        else:
            invalid.append({"row": i + 1, "errors": result["errors"]})
    return {"valid": valid, "invalid": invalid, "ready": not invalid}


def apply(the_plan, table, accept_partial=False):
    if not the_plan["ready"] and not accept_partial:
        raise ValueError("plan has invalid rows — fix them or accept_partial explicitly")
    inserted = [store.insert(table, row) for row in the_plan["valid"]]
    return {"inserted": len(inserted), "skipped": len(the_plan["invalid"])}
