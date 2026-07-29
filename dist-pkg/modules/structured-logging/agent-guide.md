# structured-logging — agent guide

print() and bare logging fail review — log through slog with an event
name and fields. bind() attaches request-scoped context (request_id, user)
that every subsequent line carries. Never log secrets or full request bodies.
