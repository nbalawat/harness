# data-retention — agent guide

Retention policies come from the app's clarified requirements (e.g.
"90 days"), configured as {table: days} — never hardcode days in endpoints.
purge() soft-deletes expired rows and returns a report the audit trail should
record. Schedule it via the scheduling module, don't call it from requests.
