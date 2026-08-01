The user reviewed this step's previous output and requested changes:

FUNCTIONAL GAP to fix in YOUR slice (on top of the revised foundation you receive): the portfolio Q&A agent currently refuses questions like "which deals await tiered approval" because its knowledge is not wired to live deal data. Ground it: build the agent's context at question time from the STORED deal records (pipeline stages, statuses, exposures, grades, open exceptions), scoped to what the asking user's role may see, so it answers portfolio questions with real deal codes and figures. Keep the safety behavior: answers remain clearly framed as automated drafts pending analyst approval, and it must still refuse when the data genuinely is not available rather than inventing figures. CONSTRAINTS: every recorded acceptance check must keep passing exactly as written; keep app.js changes pure appends.


The previously committed output is at: /Users/nbalawat/development/harness/underwriting-desk-v12/artifacts/slice-5
Start from it and apply ONLY the requested changes — keep everything else stable.