# prompt-registry — agent guide

Every prompt an app agent uses is registered here and rendered with
render(name, var=...) — string literals in endpoint code fail review. Missing
template variables raise immediately (fail loud at call time, not silently in
the model). Version on every change; get() returns the latest.
