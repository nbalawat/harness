import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_bridge import Queue  # noqa: E402


def test_ack_removes_and_nack_redelivers_until_dead():
    q = Queue(max_attempts=2)
    q.publish({"job": "reindex"})

    first = q.pull()
    assert first["attempts"] == 1
    q.nack(first["id"])

    second = q.pull()
    assert second["attempts"] == 2, "redelivered with attempt count"
    q.nack(second["id"])
    assert q.pull() is None and len(q.dead) == 1, "exhausted messages go to the dead letter list"


def test_ack_path():
    q = Queue()
    q.publish({"job": "x"})
    msg = q.pull()
    assert q.ack(msg["id"]) is True and q.pull() is None
