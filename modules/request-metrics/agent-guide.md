# request-metrics — agent guide

Metrics are automatic; do not hand-count in endpoints. /metrics is the
scrape surface (Prometheus text format subset). Add business metrics via
request_metrics.counter(name).inc() — named, lowercase, underscore.
