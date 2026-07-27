# scheduling — agent guide

Background work registers here; the deployment layer calls run_due()
on a tick (or an external cron hits an admin endpoint). No threads inside the
app — determinism and testability first. Job failures are recorded and do NOT
stop other jobs.
