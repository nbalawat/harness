# rate-limit — agent guide

The throttle is global and automatic — do not add per-endpoint limiters. If a
slice needs a stricter limit for an expensive endpoint, lower APP_RATE_LIMIT
via deployment config rather than adding code. 429 responses include
Retry-After; the frontend should surface them as "slow down", not as errors.
