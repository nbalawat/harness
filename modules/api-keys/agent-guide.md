# api-keys — agent guide

Machine callers authenticate with X-Api-Key. Only the HASH is stored —
the secret is shown once at issue time. verify() returns the key's name for
attribution (pass it to audit-log). Revoke by name; never delete the record.
