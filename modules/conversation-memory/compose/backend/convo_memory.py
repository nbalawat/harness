"""conversation-memory module: bounded context with summarization. See agent-guide."""


class Memory:
    def __init__(self, max_chars=2000):
        self.max_chars = max_chars
        self.turns = []
        self.summary_of = 0

    def add(self, role, text):
        self.turns.append((role, str(text)))
        self._fold()

    def _verbatim(self):
        return self.turns[self.summary_of:]

    def _fold(self):
        while sum(len(t) for _, t in self._verbatim()) > self.max_chars and len(self._verbatim()) > 2:
            self.summary_of += 1

    def context(self):
        parts = []
        folded = self.turns[: self.summary_of]
        if folded:
            topics = ", ".join(t[:40] for _, t in folded[-3:])
            parts.append(f"[earlier: {len(folded)} turn(s) covering {topics}]")
        for role, text in self._verbatim():
            parts.append(f"{role}: {text}")
        return "\n".join(parts)
