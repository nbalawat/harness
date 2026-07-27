# fallback-chain — agent guide

Order steps from best to safest (live model -> smaller model -> stub
disclosure). try_chain returns which step served the request — ALWAYS surface
that in the response metadata so degraded answers are visible. All steps
failing raises the LAST error; never return silence.
