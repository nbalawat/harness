"""data-retention module: policy-driven purge. See agent-guide."""
import datetime

import soft_delete
from db import store


def purge(policies, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    report = {}
    for table, days in policies.items():
        expired = 0
        for row in soft_delete.active(table):
            created = row.get("created_at")
            if not created:
                continue
            created_dt = datetime.datetime.fromisoformat(str(created).replace("Z", "+00:00"))
            if (now - created_dt).days >= days:
                soft_delete.delete(table, row["id"])
                expired += 1
        report[table] = expired
    return report
