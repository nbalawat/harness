"""assignment module: fair routing. See agent-guide."""
import itertools

_cursors = {}


def round_robin(workers, queue="default"):
    if not workers:
        raise ValueError("no workers to assign")
    cursor = _cursors.setdefault(queue, itertools.cycle(sorted(workers)))
    return next(cursor)


def least_loaded(workers, load_fn):
    if not workers:
        raise ValueError("no workers to assign")
    return min(sorted(workers), key=load_fn)
