# a11y-baseline — agent guide

Run the checker against any frontend dir (verify-slice can include
it). Violations: <input> without placeholder/aria-label/associated label,
<button> with no text, <html> without lang. It reads static HTML — dynamic
DOM needs the same rules applied in JS modules (textContent labels).
