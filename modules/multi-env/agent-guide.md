# multi-env — agent guide

Environments are env files (env.dev, env.staging, env.prod) layered
over a base — merge() is last-wins with one exception: prod REFUSES debug
flags and seed enablement (guard rails, not conventions). Promotion = same
image + next env file, never a rebuild.
