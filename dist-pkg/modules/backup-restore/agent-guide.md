# backup-restore — agent guide

dump() writes a versioned JSON snapshot of the named tables; restore()
loads into a store and returns per-table counts for verification. Schedule
dumps via the scheduling module; test restores in CI — the restore path is the
one that matters.
