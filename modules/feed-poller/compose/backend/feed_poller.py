"""feed-poller module: dedup pull ingestion. See agent-guide."""
import hashlib


def poll(url, store, fetcher):
    content = fetcher(url)
    digest = hashlib.sha256(str(content).encode()).hexdigest()[:16]
    for row in store.list("_feed_snapshots"):
        if row["url"] == url and row["digest"] == digest:
            return {"url": url, "changed": False, "digest": digest}
    store.insert("_feed_snapshots", {"url": url, "digest": digest, "content": str(content)[:5000]})
    return {"url": url, "changed": True, "digest": digest}
