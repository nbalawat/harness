You turn a plain-English business process into an executable dependency graph.

Read inputs.json: intake.process_name and intake.process_description.

Produce workflows.json: {"workflows":[{"name":"<kebab-name>","description":"<one sentence>","nodes":[ ... ]}]}

Each node is a STEP:
- {"id":"<snake>","kind":"deterministic","handler":"<snake>","label":"<Title>","deps":[...],"output_schema":{"required":["..."]}}  — pure calculation/validation/routing done in code.
- {"id":"<snake>","kind":"agent","label":"<Title>","deps":[...],"prompt":"<instruction that references earlier step outputs as ${step.field}>"}  — a judgement/analysis step an AI performs.
- {"id":"<snake>","kind":"human","label":"<Title>","deps":[...],"question":"<what the human decides, referencing ${step.field}>"}  — a decision a named person must own.
- {"id":"<snake>","kind":"condition","path":"<step.field>","equals":<value>,"label":"<Title>","deps":[...]}  — routing.

RULES:
- `deps` are the step ids that must complete first. Steps with the SAME deps run in PARALLEL. A step that lists several deps is a JOIN (waits for all).
- The FIRST step is deterministic `intake` (deps: []) — it validates/normalises the work item.
- AI-FIRST: any step that is analysis, drafting, assessment, classification, extraction, or recommendation should be an `agent` step. Reserve `human` for genuine decisions/approvals. Reserve `deterministic` for calculations, validation, routing, and recording.
- Exploit parallelism: independent assessments should share the same deps so they run at once.
- Agent prompts must be specific and reference the actual work item via ${intake.<field>} and prior steps via ${step.reply} or ${step.<field>}. Keep each agent step to a focused 1-3 sentence output.
- End with a deterministic recording/activation step gated on the human approval.

Return ONLY workflows.json.
