#!/usr/bin/env python3
"""Verify config + plugin discovery + enabled-set, using the hermes venv."""
import os, sys, json, re
os.environ.setdefault("HERMES_HOME", "/opt/data")

# 1. config.yaml is valid YAML and contains the block
import yaml
cfg = yaml.safe_load(open("/opt/data/config.yaml"))
print("1. config plugins.enabled:", cfg.get("plugins", {}).get("enabled"))

# 2. enabled set
from hermes_cli.plugins_cmd import _get_enabled_set
print("2. _get_enabled_set():", _get_enabled_set())
assert "mc-workflows" in _get_enabled_set(), "mc-workflows NOT in enabled set"

# 3. discovery
from hermes_cli.web_server import _discover_dashboard_plugins
plugins = _discover_dashboard_plugins()
print("3. discovered dashboard plugins:")
for p in plugins:
    print("   -", p["name"], "| source=", p["source"], "| api=", p.get("_api_file"), "| has_api=", p.get("has_api"))
mc = [p for p in plugins if p["name"] == "mc-workflows"]
assert mc, "mc-workflows NOT discovered"
m = mc[0]
assert m.get("_api_file") == "plugin_api.py", f"bad api file: {m.get('_api_file')}"
assert m.get("source") == "user", f"bad source: {m.get('source')}"
print("   -> mc-workflows discovery OK (user source, api=plugin_api.py)")
