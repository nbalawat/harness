# deprecation — agent guide

Deprecating a module: add 'deprecated: true' and 'successor: <name>'
to its manifest (successor must exist), keep it certified for two more
releases, then remove. Architecture agents must never pick deprecated modules
for NEW apps; existing apps migrate via the successor's guide.
