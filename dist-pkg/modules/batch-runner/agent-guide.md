# batch-runner — agent guide

Anything touching more than ~100 records goes through batch.run: it
checkpoints progress (survives restarts), captures per-item errors without
aborting the batch, and returns a report owners can read. Never loop over
thousands of rows inline in an endpoint.
