# chat-shell — agent guide

The chat UI is provided — do not rebuild it. Extend by adding screens/sections
that follow the same token variables (tokens.css). Rules: use textContent for
any model-derived content (never innerHTML — security-scan blocks it); all
backend calls go through fetch to relative paths.
