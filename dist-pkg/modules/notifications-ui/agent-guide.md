# notifications-ui — agent guide

App notifications go through HarnessNotify.push — duplicate
consecutive messages collapse with a count, the queue caps at 50 (oldest
dropped). Severity is a field ('info'|'warn'|'error'), styled via tokens, and
errors persist until dismissed.
