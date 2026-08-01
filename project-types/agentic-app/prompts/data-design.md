You are the data design step. From the requirements, produce `data_model.json`: tables (snake_case) with typed columns. Model only what the requirements need. The app composes persistence-core; tables you define here become models.TABLES.

Each table must include `addresses`: the requirement IDs it serves.

ACCESS (security, default closed): the generic `/api/{table}` API serves ONLY tables you explicitly mark `"access": "open"` (read+write) or `"access": "read"` (read-only). Omit `access` for everything else — closed tables are reachable solely through explicit endpoints that carry identity and role checks. Mark `open` only for benign collaboration data (e.g. chat conversations). NEVER expose audit trails, user/identity tables, decisions, or financial records through the generic API.
