"""batch-runner module: resumable long operations. See agent-guide."""


def run(items, process, checkpoint):
    done = set(checkpoint.get("done", []))
    errors = list(checkpoint.get("errors", []))
    for i, item in enumerate(items):
        if i in done:
            continue
        try:
            process(item)
        except Exception as e:
            errors.append({"index": i, "error": str(e)[:200]})
        done.add(i)
        checkpoint["done"] = sorted(done)
        checkpoint["errors"] = errors
    return {"total": len(items), "processed": len(done), "errors": errors}
