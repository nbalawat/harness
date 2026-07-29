# harness

Build working agentic applications from a problem statement.

## Get started (two commands)

```sh
npm install -g @nbalawat/harness
harness ui
```

Open http://localhost:4400, press **Start building**, and answer the intake
questions (upload your documents right in the form). Build as many apps in
parallel as you like — one browser tab per build.

First live build: run `harness setup --install-sdk` once (provisions the
Claude Agent SDK into ~/.harness/runtime) and set `ANTHROPIC_API_KEY`.

Command line instead of the UI:

```sh
harness run <project-type> --workspace my-app
harness status my-app
```
