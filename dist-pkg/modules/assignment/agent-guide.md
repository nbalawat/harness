# assignment — agent guide

Pick assignees through these helpers only. round_robin is stable
across calls (deterministic order); least_loaded takes a load function so the
definition of 'busy' is explicit. Record every assignment in audit-log.
