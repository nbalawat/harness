"""checklists module: templated task lists. See agent-guide."""
from db import store


def create(name, template):
    return store.insert("_checklists", {"name": name, "items": {item: False for item in template}})


def _find(checklist_id):
    for row in store.list("_checklists"):
        if row["id"] == checklist_id:
            return row
    raise KeyError(f"no checklist {checklist_id}")


def toggle(checklist_id, item):
    checklist = _find(checklist_id)
    if item not in checklist["items"]:
        raise KeyError(f"no item '{item}'")
    checklist["items"][item] = not checklist["items"][item]
    return checklist["items"][item]


def progress(checklist_id):
    items = _find(checklist_id)["items"]
    done = sum(1 for v in items.values() if v)
    return {"done": done, "total": len(items), "percent": round(100 * done / len(items)) if items else 100}
