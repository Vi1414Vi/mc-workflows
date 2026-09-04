#!/usr/bin/env python3
"""Smoke-test mc-workflows backend logic against real canonical files."""
import asyncio, json, sys
sys.path.insert(0, "/opt/data/mc-workflows/dashboard")
import plugin_api as P

async def main():
    # health
    print("health:", P.health.__wrapped__() if hasattr(P.health, "__wrapped__") else await P.health())

    # crons
    c = await P.get_crons()
    print(f"crons: total={c['total']} projects={list(c['projects'].keys())}")
    seq = c['jobs'][0]['sequence']
    print("  sample seq kinds:", [(s['type'], s['kind']) for s in seq])
    print("  sample job keys:", sorted(c['jobs'][0].keys()))

    # webhooks
    w = await P.get_webhooks()
    print(f"webhooks: routes={len(w['routes'])} names={[r['name'] for r in w['routes']]}")
    if w['routes']:
        r0 = w['routes'][0]
        assert 'secret' not in json.dumps(w), "SECRET LEAKED!"
        print("  secret stripped: OK; sample seq:", [(s['type'], s['kind']) for s in r0['sequence']])

    # skills
    s = await P.list_skills()
    print(f"skills: count={s['count']}")
    s0 = s['skills'][0]
    print("  sample skill keys:", sorted(s0.keys()), "name=", s0['name'])

    # detail
    d = await P.get_skill(s0['name'])
    print(f"detail[{s0['name']}]: desc={d['description'][:40]!r} related={d['related_skills']} used_by={d['used_by_crons']} raw_len={len(d['raw'])}")
    assert d['raw'].startswith('---'), "raw should start with frontmatter"

    # validation
    from fastapi import HTTPException
    # valid edit round-trip (no write — just validate)
    ok = P._validate_skill_content(d['raw'])
    print("validate(existing raw):", "OK" if ok is None else f"ERR {ok}")
    print("validate(no fm):", P._validate_skill_content("hello world"))
    print("validate(desc too long):", P._validate_skill_content("---\nname: x\ndescription: " + "a"*2000 + "\n---\n\nbody")[:60])

    # traversal rejection
    try:
        P._resolve_skill_path("../etc/passwd")
        print("TRAVERSAL NOT REJECTED (BUG)")
    except HTTPException as e:
        print("traversal rejected:", e.detail)

    print("ALL SMOKE TESTS DONE")

asyncio.run(main())
