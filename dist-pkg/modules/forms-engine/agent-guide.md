# forms-engine — agent guide

Form schemas are data ({field: {type, required, choices, max_len}});
the SAME schema validates on the backend via forms.validate — frontend
validation is UX, backend validation is law. Unknown fields are rejected, not
silently dropped.
