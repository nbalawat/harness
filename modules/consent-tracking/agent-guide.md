# consent-tracking — agent guide

Before storing personal data for a purpose, check(subject, purpose)
must be true (or the basis must be legitimate-interest, recorded explicitly).
withdraw() never deletes history — it appends a withdrawal that check()
honors. Purge on withdrawal is data-retention's job.
