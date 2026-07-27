# spreadsheet-io — agent guide

Analyst-facing tabular data flows through this module (import-mapper
builds on it). read_rows coerces numerics conservatively ('10' -> 10,
'10.5' -> 10.5, everything else stays str); write_csv emits columns in the
declared order — never dict order.
