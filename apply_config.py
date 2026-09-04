#!/usr/bin/env python3
"""Insert the plugins.enabled block into config.yaml (idempotent)."""
from pathlib import Path

p = Path("/opt/data/config.yaml")
text = p.read_text(encoding="utf-8")

if "plugins:\n" in text or "\nplugins:\n" in text:
    print("plugins: block already present — skipping")
else:
    anchor = "paste_collapse_threshold: 5\n"
    if anchor not in text:
        print("ANCHOR NOT FOUND — aborting, no change")
        raise SystemExit(1)
    block = "plugins:\n  enabled:\n    - mc-workflows\n"
    text = text.replace(anchor, block + anchor, 1)
    p.write_text(text, encoding="utf-8")
    print("inserted plugins.enabled block")

# verify
import re
m = re.search(r"^plugins:\n  enabled:\n    - mc-workflows$", text, re.MULTILINE)
print("verified:", bool(m))
