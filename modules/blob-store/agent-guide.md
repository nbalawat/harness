# blob-store — agent guide

All file content goes through this module — never open() paths from
request data (traversal). Names are sanitized to a flat namespace. Size limit
via APP_BLOB_MAX_BYTES (default 10MB); reject beyond it, don't truncate.
