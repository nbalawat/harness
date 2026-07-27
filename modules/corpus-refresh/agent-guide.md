# corpus-refresh — agent guide

The live index is swapped ATOMICALLY after a full successful rebuild —
never index into the serving instance. rebuild() reports files indexed and
skipped (with extraction warnings); surface that report to owners. Schedule
rebuilds; don't rebuild per request.
