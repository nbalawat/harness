#!/usr/bin/env bash
# tls-local: self-signed certificate with proper SANs for local HTTPS.
set -euo pipefail
OUT="${1:-certs}"
mkdir -p "${OUT}"
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -keyout "${OUT}/app.key" -out "${OUT}/app.crt" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "wrote ${OUT}/app.key and ${OUT}/app.crt (self-signed, 365 days)"
