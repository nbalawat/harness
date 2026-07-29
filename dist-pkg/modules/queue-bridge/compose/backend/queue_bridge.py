"""queue-bridge module: ack/retry queue semantics. See agent-guide."""
import itertools


class Queue:
    def __init__(self, max_attempts=3):
        self._ids = itertools.count(1)
        self._ready = []
        self._inflight = {}
        self.max_attempts = max_attempts
        self.dead = []

    def publish(self, payload):
        msg = {"id": next(self._ids), "payload": payload, "attempts": 0}
        self._ready.append(msg)
        return msg["id"]

    def pull(self):
        if not self._ready:
            return None
        msg = self._ready.pop(0)
        msg["attempts"] += 1
        self._inflight[msg["id"]] = msg
        return dict(msg)

    def ack(self, msg_id):
        return self._inflight.pop(msg_id, None) is not None

    def nack(self, msg_id):
        msg = self._inflight.pop(msg_id, None)
        if msg is None:
            return False
        if msg["attempts"] >= self.max_attempts:
            self.dead.append(msg)
        else:
            self._ready.append(msg)
        return True
