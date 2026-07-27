import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import importer  # noqa: E402
import pytest  # noqa: E402
from db import store  # noqa: E402

SCHEMA = {"user": {"type": "str", "required": True}}
MAPPING = {"User Name": "user"}


def test_dry_run_then_apply_clean_plan():
    the_plan = importer.plan([{"User Name": "ana"}, {"User Name": ""}], MAPPING, SCHEMA)
    assert len(the_plan["valid"]) == 1 and the_plan["invalid"][0]["row"] == 2
    assert the_plan["ready"] is False

    with pytest.raises(ValueError):
        importer.apply(the_plan, "conversations")

    result = importer.apply(the_plan, "conversations", accept_partial=True)
    assert result == {"inserted": 1, "skipped": 1}
    assert any(r["user"] == "ana" for r in store.list("conversations"))
