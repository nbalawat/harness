# session-audit — agent guide

Call these from auth flows: login() on successful /auth/login,
denied() whenever rbac.require raises. Never log tokens or credentials — only
usernames and event types. The entries appear in /audit with event prefix
"session.".
