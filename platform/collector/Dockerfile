# Cloud Run image for the collector service — zero npm dependencies, so the image
# is just the runtime plus one file.
FROM node:22-slim
WORKDIR /app
COPY server.mjs .
USER node
ENV NODE_ENV=production
# Cloud Run: /app is read-only for the node user; stores live in /tmp
# (ephemeral — prod persistence is GCS/BigQuery per the architecture doc).
ENV STORE=/tmp/collector-store
CMD ["node", "server.mjs"]
