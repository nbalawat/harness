# usage-analytics — agent guide

Usage is counted automatically per path per day (and per user when
auth-basic provides one). No third-party analytics; the data never leaves the
app. Feature buckets: register human-readable names with
usage.label("/workflow/submissions", "Approvals").
