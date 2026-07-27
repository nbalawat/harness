# docker-hardening — agent guide

Production images follow Dockerfile.hardened: pinned base (never
:latest), non-root USER before CMD, no ADD, no curl|sh. The checker enforces
those rules — wire it into deploy pipelines; a failing image doesn't ship.
