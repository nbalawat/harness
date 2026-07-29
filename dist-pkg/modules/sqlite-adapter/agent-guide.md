# sqlite-adapter — agent guide

Durable storage for single-host deployments. Construct with a file path;
the interface is IDENTICAL to db.store (insert returns the row with id; list
returns copies). Never write SQL against the file directly — the adapter owns
the schema. persistence-core v1 will select this via APP_STORE=sqlite.
