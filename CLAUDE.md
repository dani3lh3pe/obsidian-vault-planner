# CLAUDE.md

Canonical project rules. Each rule lives in exactly one place; where another artifact owns the
detail, this file points to it.

## Project

An Obsidian plugin for **one** user: on the left the open tasks from the vault's project files (with
a switch also the user's own Planner tasks and their personal To Dos), on the right their own Outlook
calendar. Dragging a task into a gap creates a focus block in Outlook.

> **The goal in one sentence:** in the morning, review the open tasks in under two minutes, drag
> the ones relevant for today into free calendar gaps, done. Whatever does not speed up this flow
> stays out.

## Key documents

- `docs/implementation-plan.md` — milestones, pitfalls with countermeasures, manual verification per
  milestone, verified facts with sources. Read the section before every milestone.
  It is also the place for decisions (no `docs/adr/`) and for deferred ideas
  ("Open, not blocking").
- `.claude/skills/graph-calendar/` — Graph rules (read UTC, write wall-clock time, immutable ids,
  extended property). **Read before every change to a Graph call.**
- `.claude/skills/verify/` — the gate and the hand-off of a build.
- `.claude/skills/retro/` — end-of-session pass: every learning into its one place.
- `.claude/grilling-seeds.md` — questions the `grilling` skill must ask early here, because
  otherwise they came too late.
- `.claude/agents/invariant-reviewer.md` — checks tokens, HTTP and both write paths against the
  invariants, changes nothing. Mandatory before M5.
- `README.md` — setup (Entra app, settings), usage, troubleshooting.
- The model is the web app **daily-planner** (`../daily-planner`): for "how was this solved
  there", look there instead of reinventing it.

**Obsidian, Tasks, FullCalendar 6.1.21 and Graph never from memory.** The training data knows
other versions and outdated patterns. Verify (installed source, `obsidian.d.ts`, primary docs) or
mark as open.

## Developed here, run on Windows

Built and tested on this Linux host. Obsidian and the vault run on the Windows laptop. Every
verify run produces `release/vault-planner.zip` with a build id (`0.1.0-dev.<timestamp>`) in the
manifest. Daniel unpacks the zip into `<test vault>/.obsidian/plugins/` and turns the plugin off and
on again. `release/test-vault.zip` contains the test vault and is transferred once.

**Never develop against the live vault.** It syncs via self-hosted LiveSync with a server and a
phone, and Claude edits it in parallel. Since 2026-09-29, by Daniel's decision, the plugin runs in it
(M5 moved up), but Claude never reads or writes it from here. Every build goes to it: a bug in a
write path hits real lines and spreads at once.

## Commands

```bash
npx npm@11 install     # the distro's npm 9.2.0 is broken with Node 22 on this host
bash scripts/verify.sh # the gate: tsc, tests (TZ=UTC), build, package — also the Stop hook
npm test               # tests only
npm run dev            # esbuild in watch mode to build/main.js
git tag 0.2.0 && git push origin 0.2.0  # CI runs the gate and publishes the GitHub release
```

A release: raise `version` in `manifest.json` and `package.json`, commit, then tag exactly that
version — no `v`, Obsidian looks a release up by the manifest version. `scripts/package.mjs`
refuses a tag that differs; `.github/workflows/release.yml` attaches the zip and the three plugin
files.

## Invariants

1. **The calendar is the truth for the planning status.** Neither the vault nor `data.json` ever
   holds a planning date or an event id. No `⏳` write path, not even "just as a hint". Whether a
   task is planned, `lib/schedule.ts` derives from the loaded calendar on every render.
2. **The plugin writes exactly two things to the vault, both only on a user action:** a block id
   at the end of the task line (once, never changed), and on completing it replaces exactly the
   target line with the output of the Tasks API (one or two lines). Never in the background, never
   another line, never create, delete or rename a file.
3. **Every write goes through `app.vault.process()`**, after open editors of the file have been
   saved. The target line is found in the current content by block id or by unique raw text, never
   by line number; line endings stay byte-exact. Not found or ambiguous means: abort and report.
4. **Graph follows the graph-calendar skill**, in both calendars. Never `attendees`. To Do blocks
   live only in the private calendar, all others only in the work calendar.
5. **All HTTP calls go through `requestUrl`, never `fetch`**, and only to `login.microsoftonline.com`
   and `graph.microsoft.com`. No telemetry.
6. **Tokens never in `data.json`** — it lives in the vault, and a vault sync can carry it along. The
   refresh tokens live in `app.secretStorage`, each account under its own name (work account, since
   M9 the personal account). Signing out of, or a failure in, one account leaves the other untouched.
   Only a click opens the browser ("Sign in" for both accounts, "Open in Planner", a Planner or To Do
   card), never a timer.
7. **The plugin writes exactly two things to Planner, both only on a user action:** completing
   (`percentComplete: 100`) and moving to another bucket. Always with `If-Match`; a 412 is never
   retried automatically. If the task is assigned to other people too, a dialog asks first.
8. **The plugin writes exactly one thing to To Do (personal account, M9), only on a click:**
   completing (`status: completed`). No list change. If the task is in a shared list, a dialog asks
   first. `If-Match` only once M9.0 shows that To Do honours it.

The link task ↔ event is the extended property with the value `<vaultName>|<blockId>`, for Planner
tasks vault-independent `planner:<taskId>`, for To Do tasks `todo:<taskId>` (in the private
calendar).
Its GUID in `src/config.ts` is **never** changed.

## Tasks plugin

- The parser (`lib/parseTask.ts`) reads like Tasks: fields from the end of the line, behind the
  fields only a block link and tags. A link behind `📅` makes the date invisible — in Tasks as here.
- `⏳` is only **read**: as the list's date where `📅` is missing (the imports in the live vault only
  have `⏳`). Never written and never the planning status — that comes from the calendar
  (Invariant 1).
- Since M8 the plugin no longer reads `[aufwand:: …]`: every block is one hour long. `cleanTitle`
  only hides old values in the lines from title and subject.
- Source files are only `<Folder>/<Folder>.md` below `10_Kunden/` and `20_Intern/`.
- A global filter in the Tasks settings belongs in `TASKS_GLOBAL_FILTER` in `src/config.ts`.
- Completing only through `apiV1.executeToggleTaskDoneCommand` — it returns text and writes
  nothing; a home-made toggle would lose the next occurrence for `🔁`.

## Concurrency

`lib/readGate.ts` owns the rules for the calendar, `lib/remoteSource.ts` the same for Planner and
To Do (the newest read counts, write mark until a different etag). For the calendar: only the
answer of the most recently started read counts, during a gesture (drag, resize, PATCH) nothing is
applied, and "Saving…" ends only after the first read that was started after the POST. `droppable`
does **not** block external drops in FullCalendar 6.1.21 — the gate is `eventAllow`.
`eventDragMinDistance` stays 0: with a threshold the gesture opens too late, and a read in between
creates a ghost block.

## Code standards

- The smallest solution that solves the problem. No abstractions for one-off code, no
  configurability in advance.
- TypeScript strict, no `any` — `unknown` plus narrowing at the edges. `import type` for pure type
  imports (`verbatimModuleSyntax`).
- Pure logic belongs in `src/lib/` and has tests; `src/lib/` never imports `obsidian`.
- No `console.log`, no `alert()`, no `confirm()`. Feedback via `Notice`, confirmation via a
  `Modal` that names the thing.
- FullCalendar stays at exactly 6.1.21 (v7 has different packages and no automatic CSS).
- **No field or method of a class derived from Obsidian (`View`, `Modal`, `PluginSettingTab`) may
  be named like an internal member** (`open`, `close`, `load`, `unload` …). These classes have
  members that `obsidian.d.ts` lacks; one with the same name silently replaces them, `tsc` notices
  nothing. That is how `open(task)` once kept the view from opening: a white page. Own names
  therefore carry their purpose (`openCard`, `probeReport`, `stopListening`).
- **The repository is public and English throughout:** identifiers, comments, UI texts, tests,
  docs, skills, commit messages. Replies to Daniel stay German. German stays only where it is data
  from the live vault or from To Do: the folders `10_Kunden/` and `20_Intern/`, the field
  `[aufwand:: …]`, the label `junis intern`, the titles of the M9.0 probe tasks.
- Every commit is public: no real customer names, no tenant or client ids, no credentials. The test
  vault uses neutral names.

## UX rules

1. **Loading states are mandatory.** Graph takes 2–10 s: a loading hint, never an empty area.
2. **Errors in plain language** with an action (`lib/errors.ts`), never raw Graph or AADSTS JSON.
3. **Destructive actions need a real dialog** naming the thing.
4. **Calendar not ready → status unknown:** no status lines, no drop, a banner.

## Commit style and reviews

Conventional Commits. Before a multi-file commit `/ponytail-review`, decide every finding with
Daniel, then `/code-review`. Neither replaces the other: ponytail-review does not look for bugs.
The level depends on what a bug costs, not on the size of the diff:

- **high** — everything that writes: Outlook events, the two vault, the two Planner and the To Do
  write, sign-in
- **medium** — Graph read path (calendar, Planner, To Do), task index
- **low** — pure UI

If a diff touches several levels, the highest applies. `/code-review` is skipped only for docs or
typo diffs.

After a change the user can see: name the manual checks from the milestone's table that this
change needs, and what each one proves — only what automation does not prove. If the gate covers
the change completely (a rename, a pure refactor), say so in one line instead of inventing steps.

## Learning loop

If a session shows that a claim here, in the plan or in a skill was wrong, it is corrected in the
same session — at the canonical place. New Graph findings belong in the graph-calendar skill, with
their evidence ("verified live", "documented", "derived"). Where everything else goes is up to the
`retro` skill. A wrong document is worse than none.
