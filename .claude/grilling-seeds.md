# Grilling seed questions

Read by the `grilling` skill before round 1. The Vault Planner writes into a synced vault that
Claude edits in parallel and into a real Outlook mailbox, and it runs on a Windows notebook this
host cannot see. A handful of areas cost a rework round when the question comes late. Use them to
grow the design tree when the change touches the area; they are prompts, not a questionnaire to
read out.

**Where results go:** decisions into `docs/umsetzungsplan.md`, in the milestone's "Mit Daniel
entschieden" or a "Bewusst so (mit Daniel, <date>)" line; this project has no `docs/adr/`.
Parked ideas into the plan's "Offen, nicht blockierend", never into memory — the `retro` skill
routes them there too.

- **Used every morning?** The goal in CLAUDE.md: what does not speed up the morning flow (sight the
  open tasks, drag today's into free slots) stays out. Ask whether Daniel would use it daily
  before designing it. (2026-09-29: the effort field `[aufwand::]` was built in M3 and removed
  unused in M8.)
- **What the live lines look like**: the test vault holds neutral fixtures, the live vault does
  not match them. Its Notion imports carry only `⏳` and no `📅`, block ids are long slugs
  (`^t-<area>-<slug>`), and old `[aufwand::]` notes remain. Ask for a real line or a screenshot
  before the data model settles, never read the live vault from here. (2026-09-29: the
  date-sorted list learned about `⏳` only from a screenshot.)
- **Does the calendar count?** Blocks are the planning status (Invariant 1). Every grouping, filter,
  count or sort has to decide whether a block counts or only the task line does. (2026-09-29: a
  task dragged onto today stayed under "Ohne Datum", fixed in M8.4.)
- **Planner tasks too?** They have no `⏳` and no block id, their priority 0–10 maps onto Tasks
  priorities, their date is an instant, and they allow only two writes. Decide per feature
  whether and how it applies to them, not after the vault side is built.
- **Does anything write?** Vault and Planner each allow exactly two writes (Invariants 2 and 7);
  Outlook gets blocks without `attendees` and without `categories`. A third write is its own
  decision with an invariant change and a high-level review, never a detail. (2026-09-29:
  "Priorität per Drag and Drop verschieben" would have been a third write in both.)
- **A new Graph scope?** A new scope signs Daniel out once, and while consent is missing there
  is no calendar at all, unless a settings switch offers a way out. Planner has one, the category
  colours (`MailboxSettings.Read`, M7) deliberately do not. Settle the escape hatch before building.
- **Where state lives**: `data.json` syncs with the vault (never tokens, never a plan date),
  `app.saveLocalStorage` is per device, the vault gets only the two writes, the calendar is the
  truth for planning. Where does the new piece of state belong, and does it survive a restart?
- **How it gets proven**: Obsidian, the vault and Outlook run only on Windows; the gate proves the
  logic, not rendering or Graph behaviour. Which verification-table rows prove it, does anything
  need a live probe first (a new `$select` field, a new endpoint), and has it been looked at in
  the dark theme and in the drag preview, which lives in `<body>`? (M7)
