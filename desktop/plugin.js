// mc-workflows — Hermes Desktop plugin (disk door, uncompiled ESM).
// Install: ~/.hermes/desktop-plugins/mc-workflows/plugin.js  (folder name MUST
// equal the `id` below). Backend half: /opt/data/plugins/mc-workflows/dashboard/
// (plugin_api.py + manifest.json), enabled via `plugins.enabled` in config.yaml.
//
// No JSX in a disk plugin — build UI with jsx()/jsxs() from react/jsx-runtime.
// Only @hermes/plugin-sdk, react, and react/jsx-runtime resolve.
//
// Data: useQuery on ctx.rest (shared QueryClient, dedupes/polls). Live push via
// host.onEvent('cron.changed') (native gateway event) and
// host.onEvent('mc-workflows.skills.changed') (broadcast by the backend after a
// skill write). Polling fallback (12s) covers every topology — never rely on
// push alone.

import {
  host,
  haptic,
  useQuery,
  useMutation,
  queryClient,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
} from '@hermes/plugin-sdk'
import { jsx, Fragment } from 'react/jsx-runtime'
import { useState, useEffect, useMemo } from 'react'

// --------------------------------------------------------------------------- //
// Semantic pipeline colors (fallbacks only — the desktop reskins these via
// theme tokens when they exist; the hex values keep nodes distinct on any skin).
// --------------------------------------------------------------------------- //
const KIND_STYLE = {
  trigger: { color: '#22c55e', icon: '⚡', label: 'Trigger' },
  agent: { color: '#22c55e', icon: '◈', label: 'Agent' },
  prompt: { color: '#9ca3af', icon: '📄', label: 'Prompt' },
  skill: { color: '#22c55e', icon: '🛡', label: 'Skill' },
  script: { color: '#f59e0b', icon: '🖥', label: 'Script' },
  deterministic: { color: '#f59e0b', icon: '⚙', label: 'Deterministic' },
  deliver: { color: '#3b82f6', icon: '📤', label: 'Deliver' },
}

const POLL_MS = 12000 // polling fallback for live updates

// h(type, props, ...children) — hyperscript shim over jsx (children in props).
function h(type, props, ...kids) {
  const p = Object.assign({}, props || {})
  if (kids.length) p.children = kids.length === 1 ? kids[0] : kids
  return jsx(type, p)
}

function kindStyle(kind) {
  return KIND_STYLE[kind] || KIND_STYLE.prompt
}

// --------------------------------------------------------------------------- //
// Small primitives
// --------------------------------------------------------------------------- //
function StatusDot({ status }) {
  const map = { ok: '#22c55e', error: '#ef4444', paused: '#9ca3af' }
  const color = map[status] || '#9ca3af'
  const title = status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'paused'
  return h('span', {
    title,
    style: {
      display: 'inline-block',
      width: '8px',
      height: '8px',
      borderRadius: '9999px',
      background: color,
      flexShrink: 0,
    },
  })
}

function Badge({ children, tone }) {
  const color =
    tone === 'accent'
      ? 'var(--ui-accent, #00F593)'
      : 'var(--ui-text-tertiary, #9ca3af)'
  return h(
    'span',
    {
      style: {
        fontSize: '0.6875rem',
        lineHeight: '1',
        padding: '2px 6px',
        borderRadius: '9999px',
        border: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.12))',
        color,
        whiteSpace: 'nowrap',
      },
    },
    children
  )
}

function EmptyState({ message }) {
  return h(
    'div',
    {
      style: {
        padding: '24px',
        textAlign: 'center',
        color: 'var(--ui-text-tertiary, #9ca3af)',
        fontSize: '0.8125rem',
      },
    },
    message || 'Nothing here'
  )
}

// --------------------------------------------------------------------------- //
// Pipeline renderer — MC-style node cards in a vertical chain (custom, since
// the SDK can't import React Flow: only @hermes/plugin-sdk, react resolve).
// Each node: tinted border + colored header (icon + kind label) + title +
// detail, connected by an arrow. Clickable when onStepClick is provided.
// --------------------------------------------------------------------------- //
function FlowArrow() {
  return h(
    'svg',
    { width: 14, height: 20, style: { margin: '0 auto', display: 'block', flexShrink: 0 } },
    jsx('line', { x1: 7, y1: 0, x2: 7, y2: 14, stroke: 'rgba(255,255,255,0.22)', strokeWidth: 1 }),
    jsx('path', { d: 'M2.5 13.5 L7 18.5 L11.5 13.5', stroke: 'rgba(255,255,255,0.22)', fill: 'none', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })
  )
}

function Pipeline({ sequence, onStepClick }) {
  if (!sequence || !sequence.length) return h(EmptyState, { message: 'No steps' })
  const rows = []
  sequence.forEach((step, i) => {
    const st = kindStyle(step.kind || step.type)
    const isSkillStep = step.kind === 'skill' || step.kind === 'agent'
    const clickable = !!(onStepClick && isSkillStep && step.label && step.label !== st.label)
    rows.push(
      h(
        'div',
        { key: i, style: { display: 'flex', flexDirection: 'column' } },
        i > 0 ? h(FlowArrow, {}) : null,
        h(
          'div',
          {
            onClick: clickable ? () => onStepClick({ type: 'skill', id: step.label }) : undefined,
            title: clickable ? 'Open skill: ' + step.label : undefined,
            style: {
              width: '100%',
              maxWidth: '440px',
              margin: '0 auto',
              border: '1px solid ' + st.color + '4d',
              borderLeft: '3px solid ' + st.color,
              borderRadius: '10px',
              background: 'linear-gradient(180deg, ' + st.color + '17, rgba(255,255,255,0.02))',
              padding: '10px 12px',
              cursor: clickable ? 'pointer' : 'default',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: { color: st.color, fontSize: '0.8125rem', lineHeight: '1' } }, st.icon),
            h('span', { style: { color: st.color, fontSize: '0.625rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' } }, st.label),
            step.kindLabel && step.kindLabel !== st.label
              ? h('span', { style: { color: 'var(--ui-text-quaternary, #6b7280)', fontSize: '0.625rem', marginLeft: 'auto' } }, step.kindLabel)
              : null
          ),
          step.label && step.label !== st.label
            ? h('div', { style: { color: 'var(--ui-text-secondary, #e5e7eb)', fontSize: '0.8125rem', fontWeight: 600, overflowWrap: 'break-word' } }, step.label)
            : null,
          step.detail
            ? h('div', { style: { color: 'var(--ui-text-tertiary, #9ca3af)', fontSize: '0.6875rem', overflowWrap: 'break-word', maxHeight: '3.2em', overflow: 'hidden' } }, String(step.detail))
            : null
        )
      )
    )
  })
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 0 } }, rows)
}

// --------------------------------------------------------------------------- //
// Crons tab
// --------------------------------------------------------------------------- //
function CronsTab({ ctx, nav, onOpenSkill }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const q = useQuery({
    queryKey: ['mc-workflows', 'crons'],
    queryFn: () => ctx.rest('/crons'),
    refetchInterval: POLL_MS,
  })

  // Incoming cross-tab navigation: select the targeted job once visible.
  useEffect(() => {
    if (nav && nav.to === 'crons' && nav.item) setSelected(nav.item)
  }, [nav])

  const jobs = useMemo(() => {
    const list = q.data && q.data.jobs ? q.data.jobs : []
    if (!query.trim()) return list
    const ql = query.toLowerCase()
    return list.filter(
      (j) =>
        (j.name || '').toLowerCase().includes(ql) ||
        (j.project || '').toLowerCase().includes(ql) ||
        (j.skills || []).some((s) => s.toLowerCase().includes(ql))
    )
  }, [q.data, query])

  const active = selected && jobs.find((j) => j.name === selected) ? selected : jobs.length ? jobs[0].name : null

  if (q.isLoading) return h('div', { style: { padding: '16px', color: 'var(--ui-text-tertiary)' } }, 'Loading crons…')
  if (q.isError)
    return h('div', { style: { padding: '16px', color: '#ef4444' } }, 'Failed to load crons: ' + (q.error?.message || q.error))

  if (!jobs.length) return h(EmptyState, { message: 'No cron jobs' })

  const job = jobs.find((j) => j.name === active)

  return h(
    'div',
    { style: { display: 'flex', height: '100%', minHeight: 0 } },
    h(
      'div',
      { style: { width: '280px', flexShrink: 0, borderRight: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.08))', display: 'flex', flexDirection: 'column', minHeight: 0 } },
      h('input', {
        placeholder: 'Search crons…',
        value: query,
        onChange: (e) => setQuery(e.target.value),
        style: {
          margin: '8px',
          padding: '6px 8px',
          fontSize: '0.8125rem',
          borderRadius: '6px',
          border: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.12))',
          background: 'transparent',
          color: 'var(--ui-text-secondary, #e5e7eb)',
          outline: 'none',
        },
      }),
      h(
        'div',
        { style: { flex: '1', overflowY: 'auto', minHeight: 0 } },
        jobs.map((j) =>
          h(
            'button',
            {
              key: j.name,
              onClick: () => setSelected(j.name),
              style: {
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px',
                border: 'none',
                background: j.name === active ? 'var(--ui-accent, rgba(0,245,147,0.08))' : 'transparent',
                color: 'var(--ui-text-secondary, #e5e7eb)',
                cursor: 'pointer',
                borderLeft: j.name === active ? '2px solid var(--ui-accent, #00F593)' : '2px solid transparent',
              },
            },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h(StatusDot, { status: j.status }),
              h('span', { style: { fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, j.name)
            ),
            h('div', { style: { fontSize: '0.6875rem', color: 'var(--ui-text-tertiary, #9ca3af)', paddingLeft: '14px' } }, j.schedule_human || j.schedule)
          )
        )
      )
    ),
    job
      ? h(
          'div',
          { style: { flex: '1', minWidth: 0, overflowY: 'auto', padding: '16px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('div', { style: { fontSize: '0.9375rem', fontWeight: 600, color: 'var(--ui-text-secondary, #e5e7eb)' } }, job.name),
            h(StatusDot, { status: job.status }),
            h(Badge, { children: job.project }),
            job.deliver && job.deliver !== 'local' ? h(Badge, { tone: 'accent', children: '→ ' + job.deliver }) : null
          ),
          h('div', { style: { fontSize: '0.75rem', color: 'var(--ui-text-tertiary, #9ca3af)', marginTop: '4px' } }, job.schedule_human || job.schedule),
          job.issues && job.issues.length
            ? h('div', { style: { marginTop: '8px' } }, job.issues.map((iss, i) => h('div', { key: i, style: { color: '#f59e0b', fontSize: '0.75rem' } }, '⚠ ' + iss)))
            : null,
          h('div', { style: { marginTop: '16px', color: 'var(--ui-text-quaternary, #6b7280)', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Pipeline'),
          h('div', { style: { marginTop: '8px', padding: '12px', border: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.08))', borderRadius: '8px' } },
            h(Pipeline, { sequence: job.sequence, onStepClick: (ref) => onOpenSkill(ref.id) })
          ),
          h('div', { style: { marginTop: '16px', color: 'var(--ui-text-quaternary, #6b7280)', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Prompt'),
          h('pre', {
            style: {
              marginTop: '8px',
              padding: '12px',
              borderRadius: '8px',
              background: 'var(--ui-stroke-secondary, rgba(255,255,255,0.04))',
              color: 'var(--ui-text-secondary, #e5e7eb)',
              fontSize: '0.75rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: '240px',
              overflowY: 'auto',
            },
          }, job.prompt_full || '(no prompt)')
        )
      : h(EmptyState, { message: 'Select a cron' })
  )
}

// --------------------------------------------------------------------------- //
// Webhooks tab
// --------------------------------------------------------------------------- //
function WebhooksTab({ ctx, nav, onOpenSkill }) {
  const [selected, setSelected] = useState(null)
  const q = useQuery({
    queryKey: ['mc-workflows', 'webhooks'],
    queryFn: () => ctx.rest('/webhooks'),
    refetchInterval: POLL_MS,
  })

  // Incoming cross-tab navigation: select the targeted route once visible.
  useEffect(() => {
    if (nav && nav.to === 'webhooks' && nav.item) setSelected(nav.item)
  }, [nav])

  const routes = q.data && q.data.routes ? q.data.routes : []
  const active = selected && routes.find((r) => r.name === selected) ? selected : routes.length ? routes[0].name : null
  const route = routes.find((r) => r.name === active)

  if (q.isLoading) return h('div', { style: { padding: '16px', color: 'var(--ui-text-tertiary)' } }, 'Loading webhooks…')
  if (q.isError) return h('div', { style: { padding: '16px', color: '#ef4444' } }, 'Failed to load webhooks')
  if (!routes.length) return h(EmptyState, { message: 'No webhooks' })

  return h(
    'div',
    { style: { display: 'flex', height: '100%', minHeight: 0 } },
    h(
      'div',
      { style: { width: '280px', flexShrink: 0, borderRight: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.08))', overflowY: 'auto', minHeight: 0 } },
      routes.map((r) =>
        h(
          'button',
          {
            key: r.name,
            onClick: () => setSelected(r.name),
            style: {
              display: 'block', width: '100%', textAlign: 'left', padding: '8px',
              border: 'none',
              background: r.name === active ? 'var(--ui-accent, rgba(0,245,147,0.08))' : 'transparent',
              color: 'var(--ui-text-secondary, #e5e7eb)', cursor: 'pointer',
              borderLeft: r.name === active ? '2px solid var(--ui-accent, #00F593)' : '2px solid transparent',
            },
          },
          h('span', { style: { fontSize: '0.8125rem' } }, r.name),
          r.description ? h('div', { style: { fontSize: '0.6875rem', color: 'var(--ui-text-tertiary, #9ca3af)' } }, r.description) : null
        )
      )
    ),
    route
      ? h(
          'div',
          { style: { flex: '1', minWidth: 0, overflowY: 'auto', padding: '16px' } },
          h('div', { style: { fontSize: '0.9375rem', fontWeight: 600, color: 'var(--ui-text-secondary, #e5e7eb)' } }, route.name),
          h('div', { style: { fontSize: '0.75rem', color: 'var(--ui-text-tertiary, #9ca3af)', marginTop: '4px' } }, route.url),
          route.events && route.events.length
            ? h('div', { style: { marginTop: '8px', display: 'flex', gap: '4px', flexWrap: 'wrap' } }, route.events.map((e) => h(Badge, { key: e, children: e })))
            : h('div', { style: { marginTop: '8px' } }, h(Badge, { children: 'all events' })),
          h('div', { style: { marginTop: '16px', color: 'var(--ui-text-quaternary, #6b7280)', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Pipeline'),
          h('div', { style: { marginTop: '8px', padding: '12px', border: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.08))', borderRadius: '8px' } },
            h(Pipeline, { sequence: route.sequence, onStepClick: (ref) => onOpenSkill(ref.id) })
          ),
          h('div', { style: { marginTop: '16px', color: 'var(--ui-text-quaternary, #6b7280)', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Prompt template'),
          h('pre', { style: { marginTop: '8px', padding: '12px', borderRadius: '8px', background: 'var(--ui-stroke-secondary, rgba(255,255,255,0.04))', color: 'var(--ui-text-secondary, #e5e7eb)', fontSize: '0.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '240px', overflowY: 'auto' } }, route.prompt_full || '(no prompt)')
        )
      : h(EmptyState, { message: 'Select a webhook' })
  )
}

// --------------------------------------------------------------------------- //
// Skills tab (sidebar + detail + edit)
// --------------------------------------------------------------------------- //
function EditDialog({ skill, ctx, onClose, onSaved }) {
  const [content, setContent] = useState(skill ? skill.raw : '')
  const [err, setErr] = useState(null)

  const mutation = useMutation({
    mutationFn: (newContent) => ctx.rest('/skills/' + skill.name, { method: 'PUT', body: { content: newContent } }),
    onSuccess: () => {
      haptic('tap')
      queryClient.invalidateQueries({ queryKey: ['mc-workflows', 'skills'] })
      queryClient.invalidateQueries({ queryKey: ['mc-workflows', 'skill', skill.name] })
      host.notify({ kind: 'success', message: 'Skill saved: ' + skill.name })
      onSaved && onSaved()
    },
    onError: (e) => setErr(e?.message || String(e)),
  })

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return h(
    'div',
    {
      onClick: (e) => { if (e.target === e.currentTarget) onClose() },
      style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '24px' },
    },
    h(
      'div',
      { style: { width: '100%', maxWidth: '720px', height: '80vh', display: 'flex', flexDirection: 'column', borderRadius: '10px', border: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.14))', background: 'var(--card, #111417)', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' } },
      h('div', { style: { padding: '12px 16px', borderBottom: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.08))', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('div', { style: { fontWeight: 600, fontSize: '0.875rem', color: 'var(--ui-text-secondary, #e5e7eb)' } }, 'Edit skill: ' + skill.name),
        h('button', { onClick: onClose, style: { background: 'transparent', border: 'none', color: 'var(--ui-text-tertiary)', cursor: 'pointer', fontSize: '1rem' } }, '✕')
      ),
      h('div', { style: { padding: '8px 16px', fontSize: '0.6875rem', color: 'var(--ui-text-quaternary, #6b7280)' } },
        'Full SKILL.md — YAML frontmatter (--- … ---) then markdown body. Validated on save.'
      ),
      h('textarea', {
        value: content,
        onChange: (e) => { setContent(e.target.value); setErr(null) },
        spellCheck: false,
        style: {
          flex: '1', margin: '0 16px', padding: '12px', resize: 'none',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '0.75rem', lineHeight: '1.5',
          borderRadius: '8px',
          border: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.14))',
          background: 'var(--background, #0b0d0f)',
          color: 'var(--ui-text-secondary, #e5e7eb)',
          outline: 'none', whiteSpace: 'pre', overflowX: 'auto',
        },
      }),
      err ? h('div', { style: { margin: '8px 16px', color: '#ef4444', fontSize: '0.75rem' } }, err) : null,
      h('div', { style: { padding: '12px 16px', display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
        h('button', { onClick: onClose, style: { padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.14))', background: 'transparent', color: 'var(--ui-text-secondary)', cursor: 'pointer', fontSize: '0.8125rem' } }, 'Cancel'),
        h('button', {
          onClick: () => mutation.mutate(content),
          disabled: mutation.isPending,
          style: { padding: '6px 14px', borderRadius: '6px', border: 'none', background: 'var(--ui-accent, #00F593)', color: '#06291b', cursor: mutation.isPending ? 'not-allowed' : 'pointer', fontSize: '0.8125rem', fontWeight: 600 },
        }, mutation.isPending ? 'Saving…' : 'Save')
      )
    )
  )
}

// --------------------------------------------------------------------------- //
// Skill detail body — shared between the Skills tab panel and the modal.
// --------------------------------------------------------------------------- //
function SkillDetail({ detail, onEdit, onSwitch, onCron }) {
  return h(Fragment, {},
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
      h('div', { style: { fontSize: '0.9375rem', fontWeight: 600, color: 'var(--ui-text-secondary, #e5e7eb)' } }, detail.name),
      detail.category ? h(Badge, { children: detail.category }) : null,
      onEdit ? h('button', {
        onClick: onEdit,
        style: { marginLeft: 'auto', padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.14))', background: 'transparent', color: 'var(--ui-text-secondary, #e5e7eb)', cursor: 'pointer', fontSize: '0.75rem' },
      }, '✎ Edit') : null
    ),
    detail.description ? h('div', { style: { marginTop: '8px', color: 'var(--ui-text-tertiary, #9ca3af)', fontSize: '0.8125rem' } }, detail.description) : null,
    detail.credentials && detail.credentials.length
      ? h('div', { style: { marginTop: '8px' } },
          h('div', { style: { color: 'var(--ui-text-quaternary, #6b7280)', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Credentials'),
          h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' } }, detail.credentials.map((c) => h(Badge, { key: String(c), tone: 'accent', children: String(c) })))
        )
      : null,
    detail.related_skills && detail.related_skills.length
      ? h('div', { style: { marginTop: '8px' } },
          h('div', { style: { color: 'var(--ui-text-quaternary, #6b7280)', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Related skills'),
          h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' } }, detail.related_skills.map((r) =>
            h('button', {
              key: r,
              onClick: () => onSwitch && onSwitch(String(r)),
              style: { background: 'transparent', border: 'none', padding: 0, cursor: onSwitch ? 'pointer' : 'default' },
            }, h(Badge, { key: r, children: r }))
          ))
        )
      : null,
    detail.used_by_crons && detail.used_by_crons.length
      ? h('div', { style: { marginTop: '8px' } },
          h('div', { style: { color: 'var(--ui-text-quaternary, #6b7280)', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Used by crons'),
          h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' } }, detail.used_by_crons.map((c) =>
            h('button', {
              key: c,
              onClick: () => onCron && onCron(String(c)),
              style: { background: 'transparent', border: 'none', padding: 0, cursor: onCron ? 'pointer' : 'default' },
            }, h(Badge, { key: c, children: c }))
          ))
        )
      : null,
    h('div', { style: { marginTop: '16px', color: 'var(--ui-text-quaternary, #6b7280)', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'SKILL.md'),
    h('pre', { style: { marginTop: '8px', padding: '12px', borderRadius: '8px', background: 'var(--ui-stroke-secondary, rgba(255,255,255,0.04))', color: 'var(--ui-text-secondary, #e5e7eb)', fontSize: '0.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, detail.raw)
  )
}

// --------------------------------------------------------------------------- //
// Skill modal — opened by clicking a skill/agent step in a pipeline. Keeps
// the pipeline in view behind it (no tab switch).
// --------------------------------------------------------------------------- //
function SkillModal({ name, ctx, onNavigate, onClose }) {
  const [current, setCurrent] = useState(name)
  const [editing, setEditing] = useState(false)
  const q = useQuery({
    queryKey: ['mc-workflows', 'skill', current],
    queryFn: () => ctx.rest('/skills/' + encodeURIComponent(current)),
    refetchInterval: POLL_MS,
  })

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const detail = q.data

  return h(
    'div',
    {
      onClick: (e) => { if (e.target === e.currentTarget) onClose() },
      style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '24px' },
    },
    h(
      'div',
      { style: { width: '100%', maxWidth: '720px', height: '80vh', display: 'flex', flexDirection: 'column', borderRadius: '10px', border: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.14))', background: 'var(--card, #111417)', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' } },
      h('div', { style: { padding: '12px 16px', borderBottom: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.08))', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('div', { style: { fontWeight: 600, fontSize: '0.875rem', color: 'var(--ui-text-secondary, #e5e7eb)' } }, 'Skill: ' + current),
        h('button', { onClick: onClose, style: { background: 'transparent', border: 'none', color: 'var(--ui-text-tertiary)', cursor: 'pointer', fontSize: '1rem' } }, '✕')
      ),
      h('div', { style: { flex: '1', minHeight: 0, overflowY: 'auto', padding: '16px' } },
        q.isLoading ? h('div', { style: { color: 'var(--ui-text-tertiary)' } }, 'Loading skill…') :
        q.isError ? h('div', { style: { color: '#ef4444' } }, 'Failed to load skill: ' + (q.error?.message || q.error)) :
        detail ? h(SkillDetail, {
          detail,
          onEdit: () => setEditing(true),
          onSwitch: (r) => setCurrent(r),
          onCron: (c) => { onClose(); onNavigate('crons', c) },
        }) : h(EmptyState, { message: 'No skill data' })
      ),
      editing && detail ? h(EditDialog, { skill: detail, ctx, onClose: () => setEditing(false), onSaved: () => setEditing(false) }) : null
    )
  )
}

function SkillsTab({ ctx, nav, onNavigate }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const [editing, setEditing] = useState(false)

  // Incoming cross-tab navigation: select the targeted skill once visible.
  useEffect(() => {
    if (nav && nav.to === 'skills' && nav.item) setSelected(nav.item)
  }, [nav])

  const listQ = useQuery({
    queryKey: ['mc-workflows', 'skills'],
    queryFn: () => ctx.rest('/skills'),
    refetchInterval: POLL_MS,
  })
  const detailQ = useQuery({
    queryKey: ['mc-workflows', 'skill', selected],
    queryFn: () => ctx.rest('/skills/' + selected),
    enabled: !!selected,
    refetchInterval: POLL_MS,
  })

  const skills = useMemo(() => {
    const list = listQ.data && listQ.data.skills ? listQ.data.skills : []
    if (!query.trim()) return list
    const ql = query.toLowerCase()
    return list.filter((s) => (s.name || '').toLowerCase().includes(ql) || (s.description || '').toLowerCase().includes(ql) || (s.category || '').toLowerCase().includes(ql))
  }, [listQ.data, query])

  const active = selected && skills.find((s) => s.name === selected) ? selected : skills.length ? skills[0].name : null
  const detail = detailQ.data

  return h(
    'div',
    { style: { display: 'flex', height: '100%', minHeight: 0 } },
    h(
      'div',
      { style: { width: '280px', flexShrink: 0, borderRight: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.08))', display: 'flex', flexDirection: 'column', minHeight: 0 } },
      h('input', {
        placeholder: 'Search skills…',
        value: query,
        onChange: (e) => setQuery(e.target.value),
        style: { margin: '8px', padding: '6px 8px', fontSize: '0.8125rem', borderRadius: '6px', border: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.12))', background: 'transparent', color: 'var(--ui-text-secondary, #e5e7eb)', outline: 'none' },
      }),
      listQ.isLoading
        ? h('div', { style: { padding: '16px', color: 'var(--ui-text-tertiary)' } }, 'Loading…')
        : h(
            'div',
            { style: { flex: '1', overflowY: 'auto', minHeight: 0 } },
            skills.map((s) =>
              h(
                'button',
                {
                  key: s.name,
                  onClick: () => setSelected(s.name),
                  style: {
                    display: 'block', width: '100%', textAlign: 'left', padding: '8px',
                    border: 'none',
                    background: s.name === active ? 'var(--ui-accent, rgba(0,245,147,0.08))' : 'transparent',
                    color: 'var(--ui-text-secondary, #e5e7eb)', cursor: 'pointer',
                    borderLeft: s.name === active ? '2px solid var(--ui-accent, #00F593)' : '2px solid transparent',
                  },
                },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                  h('span', { style: { fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.name),
                  s.has_credentials ? h('span', { style: { color: 'var(--ui-accent, #00F593)', fontSize: '0.6875rem' }, title: 'uses credentials' }, '🔑') : null
                ),
                s.category ? h('div', { style: { fontSize: '0.6875rem', color: 'var(--ui-text-quaternary, #6b7280)', paddingLeft: '6px' } }, s.category) : null,
                s.description ? h('div', { style: { fontSize: '0.6875rem', color: 'var(--ui-text-tertiary, #9ca3af)', paddingLeft: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.description) : null
              )
            )
          )
    ),
    h(
      'div',
      { style: { flex: '1', minWidth: 0, overflowY: 'auto', padding: '16px' } },
      active && detailQ.isLoading ? h('div', { style: { color: 'var(--ui-text-tertiary)' } }, 'Loading skill…') :
      active && detailQ.isError ? h('div', { style: { color: '#ef4444' } }, 'Failed to load skill') :
      active && detail ? h(SkillDetail, {
        detail,
        onEdit: () => setEditing(true),
        onSwitch: (r) => { setSelected(String(r)); setQuery('') },
        onCron: (c) => onNavigate('crons', String(c)),
      }) : h(EmptyState, { message: 'Select a skill' })
    ),
    editing && detail ? h(EditDialog, { skill: detail, ctx, onClose: () => setEditing(false), onSaved: () => setEditing(false) }) : null
  )
}

// --------------------------------------------------------------------------- //
// Page — tabs
// --------------------------------------------------------------------------- //
function WorkflowsPage({ ctx }) {
  const [tab, setTab] = useState('crons')
  // Cross-tab navigation: a badge click can jump to another tab and
  // select an item there. { to: 'skills'|'crons'|'webhooks', item: name }.
  const [nav, setNav] = useState(null)
  // Skill modal: opened by clicking a skill/agent step in a pipeline.
  const [modalSkill, setModalSkill] = useState(null)
  const tabs = [
    { id: 'crons', label: 'Crons' },
    { id: 'webhooks', label: 'Webhooks' },
    { id: 'skills', label: 'Skills' },
  ]

  const navigate = (to, item) => {
    const tabId = to === 'skill' ? 'skills' : to
    setNav({ to: tabId, item })
    setTab(tabId)
  }

  const openSkill = (name) => setModalSkill(name)

  useEffect(() => {
    // Live push: native gateway cron.changed + our skills broadcast.
    const offCron = host.onEvent('cron.changed', () => {
      queryClient.invalidateQueries({ queryKey: ['mc-workflows', 'crons'] })
    })
    const offSkills = host.onEvent('mc-workflows.skills.changed', () => {
      queryClient.invalidateQueries({ queryKey: ['mc-workflows', 'skills'] })
    })
    return () => {
      offCron && offCron()
      offSkills && offSkills()
    }
  }, [])

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '2px', padding: '8px 12px', borderBottom: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.08))' } },
      h('div', { style: { fontWeight: 600, fontSize: '0.875rem', color: 'var(--ui-text-secondary, #e5e7eb)', marginRight: '16px' } }, 'Workflows & Skills'),
      tabs.map((t) =>
        h('button', {
          key: t.id,
          onClick: () => { setNav(null); setTab(t.id) },
          style: {
            padding: '5px 12px',
            borderRadius: '6px',
            border: 'none',
            background: tab === t.id ? 'var(--ui-accent, rgba(0,245,147,0.12))' : 'transparent',
            color: tab === t.id ? '#ffffff' : 'var(--ui-text-tertiary, #9ca3af)',
            cursor: 'pointer',
            fontSize: '0.8125rem',
          },
        }, t.label)
      )
    ),
    h(
      'div',
      { style: { flex: '1', minHeight: 0 } },
      tab === 'crons' ? h(CronsTab, { ctx, nav, onOpenSkill: openSkill }) : tab === 'webhooks' ? h(WebhooksTab, { ctx, nav, onOpenSkill: openSkill }) : h(SkillsTab, { ctx, nav, onNavigate: navigate })
    ),
    modalSkill ? h(SkillModal, { name: modalSkill, ctx, onNavigate: navigate, onClose: () => setModalSkill(null) }) : null
  )
}

// --------------------------------------------------------------------------- //
// Plugin
// --------------------------------------------------------------------------- //
export default {
  id: 'mc-workflows',
  name: 'Workflows & Skills',
  register(ctx) {
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/workflows' },
        render: () => jsx(WorkflowsPage, { ctx }),
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: '/workflows', label: 'Workflows & Skills', codicon: 'workflow' },
      },
    ])
  },
}
