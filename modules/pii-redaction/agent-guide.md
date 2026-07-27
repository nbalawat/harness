# pii-redaction — agent guide

Run redact() before persisting any free text a human typed (emails,
phones, SSNs, card numbers via Luhn). Detection is conservative by design —
tune patterns here, never inline. Masked forms keep the kind ([email], [phone])
so text stays readable for reviewers.
