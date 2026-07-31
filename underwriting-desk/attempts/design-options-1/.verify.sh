#!/bin/bash
# Buildable-shell contract verifier for design options.
SCREENS="pipeline intake deal review approvals sla audit chat"
TOKENS="--primary --on-primary --bg --fg --surface --border --font"
FAIL=0
for n in 1 2 3 4; do
  D="designs/option-$n"
  H="$D/index.html"
  T="$D/tokens.css"
  echo "=== option-$n ==="
  [ -f "$H" ] || { echo "  MISSING index.html"; FAIL=1; continue; }
  [ -f "$T" ] || { echo "  MISSING tokens.css"; FAIL=1; continue; }
  for s in $SCREENS; do
    grep -q "id=\"screen-$s\"" "$H" || { echo "  MISSING id=screen-$s"; FAIL=1; }
  done
  for id in agent-mode messages composer input; do
    grep -q "id=\"$id\"" "$H" || { echo "  MISSING id=$id"; FAIL=1; }
  done
  grep -q 'rel="stylesheet"[^>]*href="tokens.css"' "$H" || { echo "  MISSING tokens.css link"; FAIL=1; }
  grep -q '<style' "$H" || { echo "  MISSING structural <style> block"; FAIL=1; }
  grep -q 'Underwriting Command Center' "$H" || { echo "  MISSING app name"; FAIL=1; }
  grep -q 'type="submit"' "$H" || { echo "  MISSING submit button"; FAIL=1; }
  for t in $TOKENS; do
    grep -q -- "$t:" "$T" || { echo "  MISSING token $t"; FAIL=1; }
  done
  echo "  html $(wc -l < "$H" | tr -d ' ') lines / css $(wc -l < "$T" | tr -d ' ') lines"
done
echo "=== RESULT: $([ $FAIL -eq 0 ] && echo PASS || echo FAIL) ==="
