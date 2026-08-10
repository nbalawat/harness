# Hosted harness front door — the dashboard as a container, the way folks enter
# the harness. Binds all interfaces and gates access with HARNESS_UI_TOKEN (put
# firm SSO / ALB-OIDC in front in production). Runs on App Runner / ECS / EKS.
#
# Build from the repo root:  docker build -f platform/harness-ui/Dockerfile -t harness-ui .
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci
COPY project-types ./project-types
COPY modules ./modules
COPY mcp ./mcp
COPY stage-library ./stage-library
RUN npm run build && npm cache clean --force
# Hosted defaults: reachable + token-gated. HARNESS_UI_TOKEN is injected at deploy
# time (never baked into the image). At 100k scale the run root is backed by shared
# storage (S3/EFS) and the service scales out horizontally behind the LB; see
# docs/DEPLOYMENT-AWS.md §"Front door at scale".
ENV HARNESS_UI_HOST=0.0.0.0 PORT=8080 HARNESS_TELEMETRY=0
EXPOSE 8080
CMD ["node","packages/cli/dist/index.js","ui","."]
