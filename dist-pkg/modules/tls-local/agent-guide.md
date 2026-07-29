# tls-local — agent guide

On-prem installs that need TLS run tls-local.sh — it generates a
self-signed cert with localhost + 127.0.0.1 SANs into ./certs. Browsers warn
by design (self-signed); for firm-trusted certs use the firm CA process, not
this script. Never commit generated keys.
