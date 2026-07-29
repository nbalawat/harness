# seed-data — agent guide

Demo data ships as seeds (table -> rows) and loads through
/admin/seed, which is REFUSED unless APP_ALLOW_SEED=1 (never in production).
Seeding is idempotent — a marker row prevents double-seeding. Seeds are
deterministic: no random names, no now() timestamps.
