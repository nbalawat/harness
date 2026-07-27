# migrations — agent guide

Schema/data changes ship as numbered files (001_x.py exposing
migrate(store)). NEVER edit an applied migration — add a new one. apply_all is
idempotent: applied ids are recorded and skipped. Call it at app startup.
