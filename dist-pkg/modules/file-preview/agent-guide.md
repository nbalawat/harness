# file-preview — agent guide

Preview strategy is by extension: text-ish renders inline (fetched as
text), images as <img>, everything else gets a download affordance — NEVER an
iframe of arbitrary content (CSP + surprise plugins). Unknown types must say
'download to view', not fail silently.
