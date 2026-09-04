#!/usr/bin/env python3
import os, signal
os.environ.setdefault("HERMES_HOME", "/opt/data")

import hermes_cli.web_server as ws
from fastapi.testclient import TestClient

client = TestClient(ws.app, raise_server_exceptions=False)
headers = {ws._SESSION_HEADER_NAME: ws._SESSION_TOKEN}

def show(label, resp):
    body = resp.text
    print(f"{label}: HTTP {resp.status_code}  ({len(body)} bytes)")
    if resp.status_code != 200:
        print("   ", body[:200])
    return resp

show("health  ", client.get("/api/plugins/mc-workflows/health", headers=headers))
show("crons   ", client.get("/api/plugins/mc-workflows/crons", headers=headers))
show("webhooks", client.get("/api/plugins/mc-workflows/webhooks", headers=headers))
show("skills  ", client.get("/api/plugins/mc-workflows/skills", headers=headers))
show("detail  ", client.get("/api/plugins/mc-workflows/skills/newsletter-drafting", headers=headers))

# verify a subtle invariant: secret never leaks in webhooks
w = client.get("/api/plugins/mc-workflows/webhooks", headers=headers).json()
assert "secret" not in str(w), "SECRET LEAK"
print("secret still stripped: OK")
