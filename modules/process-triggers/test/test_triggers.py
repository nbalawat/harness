import json, os, sys
os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "compose", "backend"))
import workflow_engine
_wf = os.path.join(os.path.dirname(os.path.abspath(workflow_engine.__file__)), "..", "workflows")
os.makedirs(_wf, exist_ok=True)
json.dump({"workflows":[{"name":"p","description":"d","nodes":[
  {"id":"a","kind":"deterministic","handler":"h","deps":[]},
  {"id":"b","kind":"human","question":"ok?","deps":["a"]}]}]}, open(os.path.join(_wf,"workflows.json"),"w"))
workflow_engine._defs_cache=None
workflow_engine.register_handler("h", lambda ctx: {"ok": True, "src": ctx["inputs"].get("_trigger")})
import ext_triggers
from fastapi import FastAPI
from fastapi.testclient import TestClient
app=FastAPI(); app.include_router(ext_triggers.router); c=TestClient(app)

def test_every_trigger_starts_the_process():
    assert len(c.get("/api/triggers").json()["triggers"]) == 5
    for path in ("/api/triggers/human/internal","/api/triggers/human/external","/api/triggers/event","/api/triggers/system"):
        r=c.post(path, json={"inputs":{"x":1}}).json()
        assert r["run_id"] and r["status"] in ("parked","running","completed")
    batch=c.post("/api/triggers/schedule/tick", json={"batch":[{"x":1},{"x":2}]}).json()
    assert batch["fired"]==2
