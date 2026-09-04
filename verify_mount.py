#!/usr/bin/env python3
"""Verify mc-workflows routes are actually mounted on the FastAPI app."""
import os
os.environ.setdefault("HERMES_HOME", "/opt/data")

# Importing web_server builds `app` and runs _mount_plugin_api_routes().
import hermes_cli.web_server as ws

routes = []
for r in ws.app.routes:
    path = getattr(r, "path", None)
    if path and "/api/plugins/mc-workflows" in path:
        methods = sorted(getattr(r, "methods", []) or [])
        routes.append((path, methods))

print(f"mc-workflows routes mounted: {len(routes)}")
for path, methods in routes:
    print(f"  {methods} {path}")

expected = {
    "/api/plugins/mc-workflows/health": {"GET"},
    "/api/plugins/mc-workflows/crons": {"GET"},
    "/api/plugins/mc-workflows/webhooks": {"GET"},
    "/api/plugins/mc-workflows/skills": {"GET"},
    "/api/plugins/mc-workflows/skills/{name}": {"GET", "PUT"},
    "/api/plugins/mc-workflows/broadcast": {"POST"},
}
found = {p: set(m) for p, m in routes}
missing = [p for p in expected if p not in found]
print("missing routes:", missing or "NONE")
assert not missing, f"missing: {missing}"
print("MOUNT VERIFIED: all mc-workflows routes present on app")
