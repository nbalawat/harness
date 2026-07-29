# tool-registry — agent guide

App tools register here once; agents call ONLY via tools.invoke(agent,
name, ...) which enforces the roster contract (tools allow-list and
denied_tools). A denied invocation raises ToolDenied and must be surfaced, not
swallowed — silent denial hides misconfiguration.
