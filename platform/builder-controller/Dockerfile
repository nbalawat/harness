# Image for the builder-controller — zero npm dependencies, one file. In local
# mode it spawns the engine; in ecs mode it runs one Fargate task per build (the
# fleet). The harness engine + CLI are provided at deploy time or in a derived image.
FROM node:22-slim
WORKDIR /app
COPY server.mjs .
USER node
ENV NODE_ENV=production BUILDER_MODE=ecs WORKROOT=/tmp/harness-builds
CMD ["node", "server.mjs"]
