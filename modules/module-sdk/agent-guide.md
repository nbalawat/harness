# module-sdk — agent guide

New modules are scaffolded, never hand-assembled:
node modules/module-sdk/new-module.mjs my-module. The skeleton passes
certify-modules immediately (manifest contract, guide stub demanding real
content, sample ext + pytest). Replace the sample logic and guide text before
review — the stub text intentionally fails human review while passing CI.
