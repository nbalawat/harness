# sla-timers — agent guide

SLA windows are configuration ({kind: hours}); compute status through
status() with an injectable now for testability. at_risk means >80% of the
window consumed — surface it before the breach, that's the whole point.
