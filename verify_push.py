#!/usr/bin/env python3
"""Prove the live-push path: does _broadcast_global_event from plugin_api.py
reach a target via the gateway's _live_transports registry?"""
import os
os.environ.setdefault("HERMES_HOME", "/opt/data")
import sys
sys.path.insert(0, "/opt/data/mc-workflows/dashboard")

import tui_gateway.server as gs

class FakeTransport:
    def __init__(self):
        self.frames = []
    def write(self, frame):
        self.frames.append(frame)

ft = FakeTransport()
gs.register_live_transport(ft)

import plugin_api
plugin_api._broadcast("mc-workflows.skills.changed", {"name": "test"})

gs.unregister_live_transport(ft)
print("frames delivered to transport:", len(ft.frames))
assert ft.frames, "broadcast did NOT deliver any frame"
frame = ft.frames[0]
print("frame[0] keys:", sorted(frame.keys()) if isinstance(frame, dict) else type(frame))
import json as _json
print("frame[0] full:", _json.dumps(frame))
# The event should carry our custom event name + payload
raw = str(ft.frames)
assert "mc-workflows.skills.changed" in raw, "event name missing"
assert "test" in raw, "payload missing"
print("LIVE PUSH VERIFIED: _broadcast_global_event delivers the custom event")
