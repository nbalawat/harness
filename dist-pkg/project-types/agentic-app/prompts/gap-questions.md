You are the gap-analysis step. Read requirements.json; requirements with confidence `unknown` are candidate questions.

Produce `gaps.json` with AT MOST the certified question budget. Every question MUST have: a sensible `default` (so users can accept-all), and `why` (which downstream decision the answer changes). Drop any question whose answer would not change the build.
