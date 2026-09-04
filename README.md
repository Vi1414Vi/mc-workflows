# mc-workflows

A Hermes Desktop plugin that replaces the Mission Control **Workflows + Skills**
view — crons, webhooks, and skills pipelines, with live updates and in-place
skill editing.

One package, two halves (deployed on two machines in Benoit's topology):

```
mc-workflows/
├── dashboard/
│   ├── manifest.json      # { "name": "mc-workflows", "api": "plugin_api.py" }
│   └── plugin_api.py      # FastAPI router → /api/plugins/mc-workflows/
├── desktop/
│   └── plugin.js          # ESM, uncompiled (jsx/jsxs), imports fenced to SDK
└── README.md
```

## What it does

- **Crons** — reads `/opt/data/cron/jobs.json`, renders each job as a
  top-to-bottom semantic pipeline (trigger → prompt/script/skill → deliver),
  grouped by inferred project, with status dots, issues, and the full prompt.
- **Webhooks** — reads `/opt/data/webhook_subscriptions.json`, same pipeline
  rendering. HMAC `secret` is stripped in the backend and never serialized.
- **Skills** — discovers `SKILL.md` under `/opt/data/skills/**`, shows
  description, credentials, related skills, used-by crons, and the full
  `SKILL.md`. **Edit** opens a raw-editor dialog → validated atomic write.

## Backend API (mounted at `/api/plugins/mc-workflows/`)

| Route | Method | Returns |
|---|---|---|
| `/health` | GET | plugin version + source presence |
| `/crons` | GET | `{jobs[], total, projects, updated_at}` — jobs carry `sequence[]` with semantic `kind` |
| `/webhooks` | GET | `{routes[]}` — per route `sequence[]`, `secret` stripped |
| `/skills` | GET | `{skills[], count}` — light index |
| `/skills/{name}` | GET | full detail + `raw` SKILL.md content |
| `/skills/{name}` | PUT | edit (validated, atomic write, broadcasts `mc-workflows.skills.changed`) |
| `/broadcast` | POST | fire the live-push event (test) |

### Edit guardrails (skills)

- Scope: `/opt/data/skills/**` only — never the platform tree (`/opt/hermes/skills`),
  never shared-skills, never secrets. Path traversal is rejected.
- Validation before write (mirrors `tools/skill_manager_tool.py::_validate_frontmatter`):
  `---` at byte 0, frontmatter closes, valid YAML mapping, `name` + `description`
  present, `description ≤ 1024` chars, non-empty body.
- Atomic write: temp file + `os.replace`.
- Cron/webhook prompts are read-only in v1 (no PUT on those).

### Live updates

- **Crons**: native gateway event `cron.changed` (already broadcast every 1s when
  `jobs.json` changes) → `host.onEvent` invalidates the query.
- **Skills**: backend calls the gateway's `_broadcast_global_event` with
  `mc-workflows.skills.changed` after a write → `host.onEvent` invalidates.
- **Polling fallback**: every query also polls at ~12s via `refetchInterval`,
  so freshness holds even when push is unavailable (OAuth remotes, dropped
  sockets, remote-gateway topology). Push is an accelerator, never a dependency.

## Install

### Backend (VPS — the machine running the dashboard/gateway)

```bash
# 1. copy the dashboard half into the user-plugin root (HERMES_HOME=/opt/data)
mkdir -p /opt/data/plugins/mc-workflows
cp -r dashboard /opt/data/plugins/mc-workflows/

# 2. add to config.yaml as a PROPER YAML LIST (no `plugins:` section exists yet):
#   plugins:
#     enabled:
#       - mc-workflows

# 3. restart the dashboard process, then verify the mount in the logs:
#   "Mounted plugin API routes: /api/plugins/mc-workflows/"
```

### Frontend (the machine running Hermes Desktop — NOT the VPS)

```bash
mkdir -p ~/.hermes/desktop-plugins/mc-workflows
cp desktop/plugin.js ~/.hermes/desktop-plugins/mc-workflows/plugin.js
```

The app hot-loads the file within seconds. If it doesn't appear:
⌘K → **Reload desktop plugins**, then open the **Workflows & Skills** sidebar row
(route `/workflows`). Settings → Plugins shows it in the inventory.

### Verify the backend

```bash
curl -s http://127.0.0.1:8787/api/plugins/mc-workflows/health
curl -s http://127.0.0.1:8787/api/plugins/mc-workflows/crons | head -c 400
curl -s http://127.0.0.1:8787/api/plugins/mc-workflows/webhooks | head -c 400
curl -s http://127.0.0.1:8787/api/plugins/mc-workflows/skills | head -c 400
```

(Use port 4860 for the s6 dashboard, 8787 for the desktop `--tui` dashboard.)

## Publishing

Standalone GitHub repo + one-click install link (deep links never auto-install):

```html
<a href="hermes://plugin/install?repo=OWNER/mc-workflows&enable=1">Install in Hermes</a>
```

Optional: PR the `hermes-plugin-index` repo to list it in `hermes plugins search`.

## Scope notes

- v2 (not built): pause/run cron actions, live RPC reads, skill-to-skill
  relationship graph, rich markdown rendering + side-by-side preview.
- Cron/webhook prompts are read-only in v1.
- The pipeline semantic colors are theme-token-first with hardcoded fallbacks
  (amber=script/deterministic, green=agent/skill/trigger, blue=deliver) so nodes
  stay distinct even before the desktop exposes the matching `--ui-*` tokens.
