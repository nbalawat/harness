# secrets-manager — agent guide

All credentials come from secrets_mgr.get("NAME") — direct os.environ
reads for secrets fail review, and hardcoded literals are caught by
scan_source (run in CI/verify). Missing required secrets raise at startup, not
at first use in production.
