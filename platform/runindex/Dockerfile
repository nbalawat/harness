# Image for the run-index service — zero npm dependencies, one file. File-backed
# store in /tmp locally; prod projects the same contract onto DynamoDB + S3.
FROM node:22-slim
WORKDIR /app
COPY server.mjs .
USER node
ENV NODE_ENV=production
ENV STORE=/tmp/runindex-store
CMD ["node", "server.mjs"]
