---
name: retro
description: End-of-session retrospective for the Vault Planner plugin — sweep the session for learnings and persist each one into its one canonical place (CLAUDE.md, a skill, docs/umsetzungsplan.md, README.md or memory). Use when asked for a retro ("retro", "was haben wir gelernt", "Learnings sichern"), after a session with surprises or first-attempt failures, whenever Daniel reports back from the Windows notebook (a manual check, the M1.0 live probe, an error message), and when the CLAUDE.md Learning Loop rule triggers. Not for improving a skill's own wording or triggering — that is skill-retro.
---

# Session Retro

Goal: nothing learned in this session evaporates. Sweep, then persist — each learning into exactly
ONE canonical place. If nothing qualifies, say so and change nothing; forced learnings are noise.

## 1. Sweep the session for five signals

1. **Docs lied or had gaps** — CLAUDE.md, a skill or the plan claimed X; reality was Y.
2. **A report from Windows** — Daniel ran a manual check, the live probe or a new build. This host
   cannot run Obsidian, so these reports are the only evidence about the running plugin; one that
   is not written down is lost.
3. **First attempt failed non-obviously** — something needed debugging that the next session would
   hit again (Obsidian API, FullCalendar 6.1.21, Tasks parsing, Graph, npm on this host).
4. **Environment facts not derivable from the repo** — tenant or app-registration state, the Tasks
   settings of the live vault, host quirks.
5. **Repeated manual sequences** — the same multi-step dance twice or more (candidate for a skill
   extension, a `scripts/` change or a permissions allowlist entry).

## 2. Place each learning

| Learning is… | Goes to | Why |
| --- | --- | --- |
| An always-true rule or decision criterion, 1–4 lines | `CLAUDE.md` | Loaded every session — expensive context, keep it short |
| Graph behaviour | `.claude/skills/graph-calendar/SKILL.md`, marked "verified live <date>", "documented" or "derived" | The standing authority against the obvious reading of the docs |
| A correction to the gate or the hand-over | `.claude/skills/verify/SKILL.md`, plus `scripts/verify.sh` if the procedure changed | The procedure's single source of truth |
| An Obsidian, Tasks or FullCalendar fact, or a trap with its countermeasure | "Belegt" or the milestone's trap table in `docs/umsetzungsplan.md` | Where the next milestone reads it |
| A manual check passed or failed, a live probe answered | The milestone's section and "Stand der Umsetzung" in `docs/umsetzungsplan.md`; a Graph answer also into the skill | Which milestone is proven must be visible without this session |
| An error the user can hit, with its fix | "Fehlerbilder" in `README.md` | Daniel reads that one, not CLAUDE.md |
| Deferred work or a known gap | "Offen, nicht blockierend" in the plan; in code a `ponytail:` comment | Repo-visible, reviewable |
| A preference or host fact invisible in the repo | Auto-memory (`~/.claude/projects/<project>/memory/` + `MEMORY.md`) | Persists, but only for Claude on this host |
| Volatile state (today's build id, a check still pending) | **Nowhere permanent** | Stale "facts" are worse than none |

Repo artifacts are shared truth; memory is personal. When in doubt, prefer the repo — and when a
fact moves into the repo, delete it from memory rather than leaving two copies to drift apart.

## 3. Persistence rules

- **Update, don't duplicate:** find the section that already covers the topic and correct it.
- **Smallest diff:** a learning is one correction, not a rewrite of the artifact around it.
- **Delete falsified content:** if the session proved a claim wrong, correcting it IS the learning.
  A wrong doc is worse than no doc.
- **One canonical place:** if two artifacts need to know, one gets the content, the other a pointer.
- **A verified claim moves, it is not copied:** in the graph-calendar skill it leaves "Open, to
  verify live" or "Documented, NOT verified here" and appears under "Verified live" with its date.

## 4. Verify

- Every backticked path in an edited file still resolves (`test -e` spot check).
- An edited skill's frontmatter `description` still matches what the skill does.
- A `ponytail:` shortcut left in the code this session: run `/ponytail-debt` so it is tracked.
- Report the persisted learnings as a short list (artifact → one-line change). "Keine Learnings in
  dieser Sitzung" is a valid, honest result.
