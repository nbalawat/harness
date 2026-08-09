# syntax=docker/dockerfile:1
# Runtime image for a produced process app: the Python/FastAPI app PLUS the
# pinned Node binary the simulated enterprise MCP servers run on (they are
# zero-dependency Node ESM, so the binary alone is enough — no npm, no node_modules).
FROM node:20.18.1-bookworm-slim AS node
FROM python:3.12.8-slim

# Just the pinned Node runtime — the MCP sim servers use only node: builtins.
COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt \
 && useradd --create-home appuser
COPY . .
USER appuser
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "--app-dir", "backend", "main:app", "--host", "0.0.0.0", "--port", "8080"]
