# feed-poller — agent guide

Outbound fetching is INJECTED (fetcher callable) so polling logic
stays testable and the transport policy (timeouts/retries) comes from
rest-client. Dedupe is by content hash — a feed that didn't change costs one
row lookup, not a re-ingest. Schedule with the scheduling module.
