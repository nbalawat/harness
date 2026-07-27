# webhook-in — agent guide

Inbound integrations land at /hooks/{name}; each hook has a shared
secret (APP_HOOK_SECRET_<NAME>). Unsigned or replayed deliveries are rejected
BEFORE parsing business content. App logic consumes accepted events from the
store — never process inline in the endpoint.
