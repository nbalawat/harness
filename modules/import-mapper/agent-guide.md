# import-mapper — agent guide

Imports are two-phase BY CONTRACT: plan() maps columns and validates
every row against the forms schema (dry run — nothing written); apply() only
accepts a clean or explicitly-accepted plan. Show users the plan report before
apply. Never insert rows that failed validation.
