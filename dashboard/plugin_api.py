"""mc-workflows — backend API for the Hermes Desktop plugin.

Reads the canonical workflow sources directly (one source of truth, many
projections) and edits user-owned skills in place:

  GET  /health           -> {ok, name, version, sources}
  GET  /crons            -> {jobs, total, projects, updated_at}
  GET  /webhooks         -> {routes}
  GET  /skills           -> {skills, count}
  GET  /skills/{name}    -> skill detail + raw SKILL.md content
  PUT  /skills/{name}    -> edit a user-owned skill (validated, atomic write)
  POST /broadcast        -> fire mc-workflows.skills.changed (live-push test)

Sequence building (the semantic trigger/prompt/skill/deliver "kind" tagging)
mirrors the Mission Control sync scripts sync-crons-live.py and
sync-webhooks-live.py — copied (not imported) because those scripts run their
write path on import. Webhook HMAC secrets are stripped, never serialized.

The backend runs inside the dashboard/gateway process, so it can reach the
gateway's global event broadcaster for live push. Broadcast is best-effort and
safe: the desktop side always keeps a polling fallback, and a missing or
unreachable broadcaster degrades to a no-op.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

try:  # PyYAML ships in the hermes venv (skill_manager_tool imports it).
    import yaml
except Exception:  # pragma: no cover - fallback keeps the plugin importable
    yaml = None

router = APIRouter()

_log = logging.getLogger("mc-workflows")

PLUGIN_NAME = "mc-workflows"
PLUGIN_VERSION = "1.0.0"

# Canonical sources. Skills scope is deliberately /opt/data/skills/** only —
# the platform tree (/opt/hermes/skills) and shared-skills are read elsewhere,
# never edited here.
CRON_JOBS = Path("/opt/data/cron/jobs.json")
WEBHOOKS = Path("/opt/data/webhook_subscriptions.json")
SKILLS_ROOT = Path("/opt/data/skills")

WEBHOOK_BASE = "http://127.0.0.1:8644/webhooks/"
MAX_DESCRIPTION_LENGTH = 1024

# Skills are read-only in v1 for anything outside this root.
_SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


# --------------------------------------------------------------------------- #
# Live push
# --------------------------------------------------------------------------- #
def _broadcast(event: str, payload: Optional[dict] = None) -> None:
    """Fan a session-less event to connected WS clients (the desktop's
    host.onEvent stream). Best-effort: the broadcaster lives in
    tui_gateway.server, which the dashboard process imports; when that import
    is unavailable (or no transports are registered) this is a silent no-op —
    polling in the frontend is the guaranteed fallback."""
    try:
        from tui_gateway import server as gateway_server

        gateway_server._broadcast_global_event(event, payload)
    except Exception:  # noqa: BLE001 - never let push break a write
        _log.debug("broadcast(%s) unavailable", event, exc_info=True)


# --------------------------------------------------------------------------- #
# Cron sequence building (mirrors sync-crons-live.py)
# --------------------------------------------------------------------------- #
def _humanize_schedule(expr: str) -> str:
    if not expr or expr == "?":
        return "?"
    day_names = {0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat"}
    if expr.startswith("every "):
        return expr.replace("every ", "Every ")
    parts = expr.split()
    if len(parts) != 5:
        return expr
    minute, hour, dom, month, dow = parts
    time_str = ""
    if hour != "*" and minute != "*":
        try:
            h, m = int(hour), int(minute)
            ampm = "am" if h < 12 else "pm"
            disp_h = h if h <= 12 else h - 12
            disp_h = 12 if disp_h == 0 else disp_h
            time_str = f"{disp_h}{'' if m == 0 else f':{m:02d}'}{ampm}"
        except ValueError:
            time_str = f"{hour}:{minute}"
    if dow == "*" and dom == "*":
        return f"Daily at {time_str}" if time_str else "Daily"
    if dow != "*":
        try:
            days = [day_names.get(int(d), d) for d in dow.split(",")]
            day_str = ", ".join(days)
        except ValueError:
            day_str = dow
        if dow == "1,2,3,4,5" or dow == "1-5":
            return f"Weekdays at {time_str}" if time_str else "Weekdays"
        if dow == "1":
            day_str = "Monday"
        elif dow == "0":
            day_str = "Sunday"
        return f"{day_str} at {time_str}" if time_str else day_str
    if "/" in minute:
        return f"Every {minute.split('/')[1]} minutes"
    if "/" in hour:
        return f"Every {hour.split('/')[1]} hours"
    return expr


def _infer_project(name, skills, workdir, prompt) -> str:
    wd = (workdir or "").lower()
    text = f"{name or ''} {' '.join(skills or [])} {wd} {prompt or ''}".lower()
    if "covaly" in text or "cov" in wd:
        return "Covaly"
    if "panoply" in text or "panoply" in wd:
        return "Panoply"
    if "flora" in text:
        return "Flora"
    if "chess" in text:
        return "Personal"
    if "veille" in text or "linkedin" in text or "content" in text:
        return "Content"
    if "email" in text:
        return "Email"
    if "invoice" in text:
        return "Finance"
    if "log" in text:
        return "Systems"
    if "watchdog" in text or "meridian" in text or "sync" in text:
        return "Systems"
    if "check-in" in text or "evening" in text or "priority" in text:
        return "Personal"
    if "granola" in text or "context" in text:
        return "Systems"
    return "Other"


def _cron_sequence(j: dict) -> list[dict]:
    prompt = j.get("prompt") or ""
    skills = j.get("skills") or []
    sequence = []
    if j.get("script"):
        kind = "deterministic" if j.get("no_agent") else "script"
        sequence.append(
            {"type": "script", "kind": kind, "kindLabel": kind,
             "label": j["script"], "name": j["script"]}
        )
    if prompt and not j.get("no_agent"):
        sequence.append(
            {"type": "prompt", "kind": "agent", "kindLabel": "agent",
             "label": "Prompt", "detail": prompt[:80]}
        )
    for s in skills:
        sequence.append(
            {"type": "skill", "kind": "agent", "kindLabel": "agent",
             "label": s, "name": s}
        )
    if j.get("deliver") and j.get("deliver") != "local":
        sequence.append(
            {"type": "deliver", "kind": "deliver", "kindLabel": j["deliver"],
             "label": j["deliver"]}
        )
    return sequence


@router.get("/crons")
async def get_crons():
    if not CRON_JOBS.exists():
        return {"jobs": [], "total": 0, "projects": {}, "updated_at": ""}
    try:
        live = json.loads(CRON_JOBS.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"jobs.json unreadable: {exc}")

    raw_jobs = live.get("jobs", [])
    jobs = []
    projects: dict = {}
    for j in raw_jobs:
        prompt = j.get("prompt") or ""
        skills = j.get("skills") or []
        name = j.get("name") or "Unnamed"
        schedule_raw = j.get("schedule") or {}
        if isinstance(schedule_raw, dict):
            schedule = schedule_raw.get("display") or schedule_raw.get("expr") or "?"
        else:
            schedule = str(schedule_raw)
        schedule_human = _humanize_schedule(schedule)
        project = _infer_project(name, skills, j.get("workdir", ""), prompt)

        if not j.get("enabled", True):
            status = "paused"
        elif j.get("last_status") == "error":
            status = "error"
        else:
            status = "ok"

        issues = []
        if j.get("last_delivery_error"):
            issues.append(f"Delivery: {j['last_delivery_error']}")
        if not skills and not j.get("script") and not j.get("no_agent"):
            issues.append("No skill or script attached")

        jobs.append({
            "name": name,
            "schedule": schedule,
            "schedule_human": schedule_human,
            "skills": skills,
            "has_skill": len(skills) > 0,
            "script": j.get("script"),
            "no_agent": j.get("no_agent", False),
            "status": status,
            "deliver": j.get("deliver", "local"),
            "workdir": j.get("workdir"),
            "prompt_preview": prompt[:100] + "..." if len(prompt) > 100 else prompt,
            "prompt_full": prompt,
            "issues": issues,
            "project": project,
            "sequence": _cron_sequence(j),
            "last_run": j.get("last_run_at"),
        })
        projects[project] = projects.get(project, 0) + 1

    return {
        "updated_at": live.get("updated_at", ""),
        "total": len(jobs),
        "jobs": jobs,
        "projects": projects,
    }


# --------------------------------------------------------------------------- #
# Webhook sequence building (mirrors sync-webhooks-live.py, secret stripped)
# --------------------------------------------------------------------------- #
def _webhook_sequence(name: str, route: dict) -> list[dict]:
    steps = [{
        "type": "trigger", "kind": "trigger",
        "label": f"{name} · POST", "detail": f"{WEBHOOK_BASE}{name}",
        "kindLabel": "webhook",
    }]
    if route.get("dispatcher"):
        steps.append({
            "type": "script", "kind": "deterministic",
            "label": "Dispatcher", "detail": route["dispatcher"],
            "kindLabel": "deterministic",
        })
    prompt = route.get("prompt") or ""
    steps.append({
        "type": "prompt", "kind": "agent", "label": "Prompt template",
        "detail": prompt[:200], "kindLabel": "agent",
    })
    for skill in route.get("skills") or []:
        steps.append({
            "type": "skill", "kind": "agent", "label": skill,
            "name": skill, "kindLabel": "agent",
        })
    steps.append({
        "type": "deliver", "kind": "deliver",
        "label": route.get("deliver", "deliver"),
        "detail": str(route.get("deliver_extra") or {})[:200],
        "kindLabel": route.get("deliver", "deliver"),
    })
    return steps


@router.get("/webhooks")
async def get_webhooks():
    if not WEBHOOKS.exists():
        return {"routes": []}
    try:
        raw = json.loads(WEBHOOKS.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"webhook_subscriptions.json unreadable: {exc}")

    routes = []
    for name, route in raw.items():
        # secret is deliberately never serialized.
        routes.append({
            "name": name,
            "description": route.get("description", ""),
            "url": f"{WEBHOOK_BASE}{name}",
            "events": route.get("events") or [],
            "deliver": route.get("deliver", ""),
            "deliver_extra": route.get("deliver_extra", {}),
            "skills": route.get("skills") or [],
            "prompt_preview": (route.get("prompt") or "")[:200],
            "prompt_full": route.get("prompt") or "",
            "created_at": route.get("created_at"),
            "sequence": _webhook_sequence(name, route),
        })
    routes.sort(key=lambda r: r["name"])
    return {"routes": routes}


# --------------------------------------------------------------------------- #
# Skills: discovery, parse, validate, edit
# --------------------------------------------------------------------------- #
def _split_frontmatter(text: str) -> tuple[dict, str]:
    """Tolerant frontmatter split (read path). Returns (frontmatter_dict, body)."""
    content = text.lstrip("\ufeff")
    if not content.startswith("---"):
        return {}, content.strip()
    end = re.search(r"\n---\s*\n", content[3:])
    if not end:
        return {}, content.strip()
    fm_text = content[3 : end.start() + 3]
    body = content[end.end() + 3 :].strip()
    fm: dict = {}
    if yaml is not None:
        try:
            parsed = yaml.safe_load(fm_text)
            if isinstance(parsed, dict):
                fm = parsed
        except Exception:
            fm = {}
    return fm, body


def _resolve_skill_path(name: str) -> Path:
    """Map a skill name to its SKILL.md under /opt/data/skills (user-owned only)."""
    if not _SKILL_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail=f"invalid skill name: {name!r}")
    matches = [p for p in SKILLS_ROOT.rglob("SKILL.md") if p.parent.name == name]
    if not matches:
        raise HTTPException(status_code=404, detail=f"skill not found: {name}")
    # Deterministic: shallowest path wins on a (rare) name collision.
    return sorted(matches, key=lambda p: (len(p.parts), str(p)))[0]


def _related_skills(fm: dict, body: str) -> list[str]:
    rel: list = []
    for key in ("depends_on", "related_skills"):
        v = fm.get(key)
        if isinstance(v, list):
            rel.extend(str(x) for x in v)
        elif isinstance(v, str) and v.strip():
            rel.append(v.strip())
    # step skill references (skill_view(name='...')) — best-effort
    for m in re.finditer(r"skill_view\s*\(\s*name\s*=\s*['\"]([^'\"]+)", body):
        rel.append(m.group(1))
    seen: set = set()
    out = []
    for x in rel:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _used_by_crons(name: str) -> list[str]:
    if not CRON_JOBS.exists():
        return []
    try:
        live = json.loads(CRON_JOBS.read_text(encoding="utf-8"))
    except Exception:
        return []
    users = []
    for j in live.get("jobs", []):
        if name in (j.get("skills") or []):
            users.append(j.get("name") or "Unnamed")
    return sorted(users)


@router.get("/skills")
async def list_skills():
    skills = []
    if SKILLS_ROOT.exists():
        for md in sorted(SKILLS_ROOT.rglob("SKILL.md")):
            try:
                name = md.parent.name
                rel = md.parent.relative_to(SKILLS_ROOT)
                text = md.read_text(encoding="utf-8", errors="replace")
                fm, body = _split_frontmatter(text)
                description = str(fm.get("description", ""))
                creds = fm.get("credentials")
                has_credentials = bool(isinstance(creds, list) and creds)
                skills.append({
                    "name": name,
                    "category": str(rel.parent) if rel.parent != Path(".") else "",
                    "path": str(md),
                    "description": description,
                    "has_credentials": has_credentials,
                    "related": _related_skills(fm, body),
                    "editable": True,
                })
            except Exception as exc:  # noqa: BLE001
                _log.warning("skill scan failed for %s: %s", md, exc)
    return {"skills": skills, "count": len(skills)}


@router.get("/skills/{name}")
async def get_skill(name: str):
    md = _resolve_skill_path(name)
    try:
        text = md.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"unreadable: {exc}")
    fm, body = _split_frontmatter(text)
    rel = md.parent.relative_to(SKILLS_ROOT)
    return {
        "name": name,
        "category": str(rel.parent) if rel.parent != Path(".") else "",
        "path": str(md),
        "frontmatter": fm,
        "description": str(fm.get("description", "")),
        "credentials": fm.get("credentials") if isinstance(fm.get("credentials"), list) else [],
        "body": body,
        "raw": text,
        "related_skills": _related_skills(fm, body),
        "used_by_crons": _used_by_crons(name),
        "editable": True,
    }


class SkillUpdate(BaseModel):
    content: str


def _validate_skill_content(content: str) -> Optional[str]:
    """Replicates tools/skill_manager_tool.py::_validate_frontmatter (edit path).
    Returns an error string, or None when valid."""
    if not content.strip():
        return "Content cannot be empty."
    content = content.lstrip("\ufeff")
    if not content.startswith("---"):
        return "SKILL.md must start with YAML frontmatter (---)."
    end_match = re.search(r"\n---\s*\n", content[3:])
    if not end_match:
        return "SKILL.md frontmatter is not closed (missing closing '---' line)."
    yaml_content = content[3 : end_match.start() + 3]
    if yaml is not None:
        try:
            parsed = yaml.safe_load(yaml_content)
        except Exception as exc:
            return f"YAML frontmatter parse error: {exc}"
        if not isinstance(parsed, dict):
            return "Frontmatter must be a YAML mapping (key: value pairs)."
        if "name" not in parsed:
            return "Frontmatter must include a 'name' field."
        if "description" not in parsed:
            return "Frontmatter must include a 'description' field."
        if len(str(parsed["description"])) > MAX_DESCRIPTION_LENGTH:
            return f"Description exceeds {MAX_DESCRIPTION_LENGTH} characters."
    body = content[end_match.end() + 3 :].strip()
    if not body:
        return "SKILL.md must have content after the frontmatter."
    return None


@router.put("/skills/{name}")
async def put_skill(name: str, update: SkillUpdate):
    md = _resolve_skill_path(name)
    # Hard scope: user-owned skills only. The path is already resolved under
    # SKILLS_ROOT by _resolve_skill_path (rglob only walks /opt/data/skills).
    err = _validate_skill_content(update.content)
    if err:
        raise HTTPException(status_code=422, detail=err)

    # Atomic write: temp file in the same dir, then rename over the target.
    try:
        fd, tmp = tempfile.mkstemp(dir=str(md.parent), prefix=f".{name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(update.content)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, str(md))
        except Exception:
            try:
                os.unlink(tmp)
            except Exception:  # noqa: BLE001
                pass
            raise
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"write failed: {exc}")

    # Live push: tell every connected desktop the skill changed. Best-effort.
    _broadcast("mc-workflows.skills.changed", {"name": name})

    fm, _ = _split_frontmatter(update.content)
    return {
        "ok": True,
        "name": name,
        "description": str(fm.get("description", "")),
        "path": str(md),
    }


@router.post("/broadcast")
async def post_broadcast():
    _broadcast("mc-workflows.skills.changed", {"name": "__test__", "test": True})
    return {"ok": True, "event": "mc-workflows.skills.changed"}


@router.get("/health")
async def health():
    return {
        "ok": True,
        "name": PLUGIN_NAME,
        "version": PLUGIN_VERSION,
        "sources": {
            "crons": CRON_JOBS.exists(),
            "webhooks": WEBHOOKS.exists(),
            "skills_root": SKILLS_ROOT.exists(),
        },
    }
