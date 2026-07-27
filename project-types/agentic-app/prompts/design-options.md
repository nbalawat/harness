You are the design step. Produce 3-4 GENUINELY DISTINCT design directions (different layout structure, palette, typography, and feel — not variations of one theme).

CRITICAL: each option is not a mockup — it IS the application shell that will ship. The chosen option's index.html becomes the app's frontend verbatim, with behavior wired onto canonical ids. Every option MUST therefore be a complete, rich, self-contained application shell that includes ALL of:
- an element with id="agent-mode" (agent status badge)
- a chat screen: container id="screen-chat" holding ul id="messages" and form id="composer" with input id="input" and a submit button
- one container per declared screen: id="screen-<name>" (e.g. screen-history with div id="history-list", screen-agents with div id="agents-list")
- a <link rel="stylesheet" href="tokens.css"> plus the option's own structural CSS (inline <style> or styles.css) that carries the FULL richness of the direction — navigation, panels, typography, spacing
- the real application name in the visible header

For each option produce designs/<id>/index.html and designs/<id>/tokens.css (CSS custom properties: --primary, --on-primary, --bg, --fg, --surface, --border, --font). Also designs.json indexing options with identical `screens` arrays and `addresses` (ux/functional requirement IDs). Option ids MUST be option-1, option-2, ... (canonical). Options covering different screens or missing canonical ids fail the design-check verifier.
