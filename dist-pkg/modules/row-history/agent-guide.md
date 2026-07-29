# row-history — agent guide

Call track() in every endpoint that UPDATES a row, passing the row
before and after — the module diffs field-by-field. history() feeds the
audit-view panel. Do not track reads, and never track secrets fields
(password, token, key) — they are dropped automatically.
