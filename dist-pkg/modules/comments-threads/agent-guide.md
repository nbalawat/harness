# comments-threads — agent guide

Comments attach to (table, record_id) — never invent per-feature
comment tables. Text passes through input-sanitizer at write. Deletion is
soft-delete's job; comments here are append-only.
