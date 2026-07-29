# input-sanitizer — agent guide

Free-text request fields pass through sanitizer.clean() before use or
storage: strips control characters, collapses whitespace, enforces max_len
loudly (raises, never truncates silently). escape_html() is for the rare
server-rendered surface — frontends stay textContent-only regardless.
