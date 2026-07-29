# search-index — agent guide

Search goes through this index, not through Python 'in' scans in
endpoints. Call index_table(table, text_fields) after writes (or rebuild on a
schedule). Ranking is deterministic (term frequency, then id) — do not add
randomness.
