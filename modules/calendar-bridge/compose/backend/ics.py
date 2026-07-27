"""calendar-bridge module: standards-based calendar interop. See agent-guide."""
import re


def _ics_time(iso):
    digits = re.sub(r"[-:]", "", str(iso).replace("Z", "")).split(".")[0].replace("+0000", "")
    return digits + "Z"


def event(summary, start_iso, end_iso, uid="harness-app"):
    return "\r\n".join([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//harness//app//EN",
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"DTSTART:{_ics_time(start_iso)}",
        f"DTEND:{_ics_time(end_iso)}",
        f"SUMMARY:{summary}",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
    ])


def parse(text):
    events, current = [], None
    for line in str(text).splitlines():
        line = line.strip()
        if line == "BEGIN:VEVENT":
            current = {}
        elif line == "END:VEVENT" and current is not None:
            events.append(current)
            current = None
        elif current is not None and ":" in line:
            key, value = line.split(":", 1)
            current[key.lower()] = value
    return events
