# Tier-2 hosted builder image — one per active build (ECS/Fargate task or EKS
# pod), workspace on EFS for park/resume. Carries the exact toolchain the
# certified verifier nodes shell out to: node (engine), uv/python (produced
# apps + pytest), and Playwright + Chrome (UI interactivity checks).
#
# BYO credentials: the pod gets ANTHROPIC_BASE_URL=<llm-gateway> + its SSO
# identity header ONLY — never a raw key. The gateway forwards the user's own
# credential. Egress is restricted to the gateway + package mirrors.
FROM node:20-bookworm-slim

# uv (Astral) for the produced FastAPI apps + pytest.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Python + the Playwright Chrome dependency chain for the UI verifiers.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv git ca-certificates \
      libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxshmfence1 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home builder

USER builder
WORKDIR /home/builder
# Chrome channel used by check-ui-interactivity.cjs (chromium.launch channel:"chrome").
RUN npx --yes playwright-core@latest install chrome || true

# The harness engine is provisioned at deploy time (npm i -g @firm/harness) or
# baked in a derived image; the entrypoint runs one build then parks/resumes.
ENV HARNESS_HOME=/home/builder/.harness \
    HARNESS_TELEMETRY=1
ENTRYPOINT ["/bin/bash","-lc"]
# Example (the control plane templates this per build):
#   harness run "$PROJECT_TYPE" --workspace /work --owner "$HARNESS_IDENTITY" --team "$HARNESS_TEAM"
CMD ["harness --help"]
