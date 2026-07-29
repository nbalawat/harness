# compat-matrix — agent guide

Architecture-time validation: given a module selection, every
module-typed 'requires' must be in the selection and no 'conflicts' pair may
coexist. certify-modules enforces manifest syntax; this tool enforces
SELECTION coherence — call it from architecture verifiers.
