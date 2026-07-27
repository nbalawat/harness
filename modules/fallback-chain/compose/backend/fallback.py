"""fallback-chain module: ordered degradation. See agent-guide."""


def try_chain(steps):
    failures = []
    for name, fn in steps:
        try:
            return fn(), {"used": name, "failures": failures}
        except Exception as e:
            failures.append({"step": name, "error": str(e)[:120]})
    raise RuntimeError(f"all {len(steps)} fallback steps failed: {failures}")
