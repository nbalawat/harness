import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import batch  # noqa: E402


def test_resume_skips_done_and_errors_dont_abort():
    seen = []

    def process(item):
        if item == "boom":
            raise RuntimeError("bad item")
        seen.append(item)

    checkpoint = {}
    report = batch.run(["a", "boom", "c"], process, checkpoint)
    assert report["processed"] == 3 and len(report["errors"]) == 1
    assert seen == ["a", "c"]

    report2 = batch.run(["a", "boom", "c"], process, checkpoint)
    assert seen == ["a", "c"], "resume re-processes nothing"
    assert len(report2["errors"]) == 1
