# soft-delete — agent guide

NEVER remove rows from the store. delete() stamps deleted_at; all
reads that feed users must use active(); deleted() exists for audit screens
and restore flows. Purging for real is data-retention's job, not yours.
