"""migrations module: ordered, tracked, idempotent. See agent-guide."""
import importlib.util
import os


def apply_all(migrations_dir, store):
    applied = {r["migration"] for r in store.list("_migrations")}
    ran = []
    if not os.path.isdir(migrations_dir):
        return ran
    for fname in sorted(os.listdir(migrations_dir)):
        if not fname.endswith(".py") or fname.startswith("_"):
            continue
        mig_id = fname[:-3]
        if mig_id in applied:
            continue
        spec = importlib.util.spec_from_file_location(mig_id, os.path.join(migrations_dir, fname))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.migrate(store)
        store.insert("_migrations", {"migration": mig_id})
        ran.append(mig_id)
    return ran
