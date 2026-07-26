# persistence-core — agent guide

Use `from db import store` for ALL data access. `store.insert(table, row)` and
`store.list(table)`. Valid table names come from `models.TABLES`. Never create
your own dicts/lists for persistence and never import a database driver
directly — the module owns the storage backend.
