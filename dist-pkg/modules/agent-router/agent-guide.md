# agent-router — agent guide

Routing rules are ordered data: [{"agent": name, "keywords": [...]}]
or {"pattern": regex}. First match wins; always provide a default. Rules live
next to the roster (agents/routing.json) so changing routing never touches
code.
