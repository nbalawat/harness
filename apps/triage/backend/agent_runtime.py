"""Agent runtime for Ask Docs — mode detection from the certified module,
but respond() sends the caller's already-grounded prompt DIRECTLY (no
double-wrapping, no boilerplate framing). Live-cli / live-api / stub.
"""
import os
import re
import shutil
import subprocess

_MODEL = os.environ.get("APP_AGENT_MODEL", "claude-opus-5")


def _claude_cli():
    return os.environ.get("CLAUDE_CODE_EXECPATH") or shutil.which("claude")


def _has_api_key() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def mode() -> dict:
    if os.environ.get("HARNESS_AGENT_MODE") == "stub":
        return {"mode": "stub", "detail": "offline extractive responder"}
    if _has_api_key():
        return {"mode": "live-api", "detail": f"Anthropic SDK · {_MODEL}"}
    if _claude_cli():
        return {"mode": "live-cli", "detail": "Claude, via your existing login"}
    return {"mode": "stub", "detail": "offline extractive responder"}


def _respond_api(prompt: str) -> str:
    import anthropic

    client = anthropic.Anthropic()
    result = client.messages.create(
        model=_MODEL, max_tokens=400, messages=[{"role": "user", "content": prompt}]
    )
    return "".join(b.text for b in result.content if b.type == "text")


def _respond_cli(prompt: str) -> str:
    result = subprocess.run(
        [_claude_cli(), "-p", prompt, "--output-format", "text"],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[:300])
    return result.stdout.strip()


def _respond_stub(prompt: str) -> str:
    # Offline: extract the most on-topic sentence from the grounded passages in
    # the prompt so the app is still genuinely useful with no credentials.
    ctx = prompt.split("Handbook passages:", 1)[-1].split("Question:", 1)[0]
    q = prompt.rsplit("Question:", 1)[-1].split("Answer:", 1)[0]
    q_terms = {w for w in re.findall(r"[a-z]{4,}", q.lower())}
    best, best_score = "", 0
    for sent in re.split(r"(?<=[.!?])\s+", re.sub(r"\[[^\]]+\]", " ", ctx)):
        s = sent.strip()
        if len(s) < 20:
            continue
        score = sum(1 for w in re.findall(r"[a-z]{4,}", s.lower()) if w in q_terms)
        if score > best_score:
            best, best_score = s, score
    return best or "That's covered in the handbook sections shown below."


def respond(prompt: str) -> str:
    current = mode()["mode"]
    try:
        if current == "live-api":
            return _respond_api(prompt)
        if current == "live-cli":
            return _respond_cli(prompt)
    except Exception:
        pass
    return _respond_stub(prompt)
