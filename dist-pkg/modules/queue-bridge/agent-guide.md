# queue-bridge — agent guide

Async work uses Queue semantics from day one (publish/pull/ack) so
moving to Pub/Sub is a transport swap, not a redesign. Unacked messages
redeliver; nack returns to the queue with attempt count. Handlers must be
idempotent — say so in every consumer you write.
