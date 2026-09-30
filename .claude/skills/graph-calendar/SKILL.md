---
name: graph-calendar
description: Microsoft Graph calendar rules for the Vault Planner plugin — UTC-only reads, wall-clock writes, immutable ids, server-side series expansion, all-day and showAs handling, and the extended property that links an Outlook block to a task line. Use BEFORE touching src/graph.ts, src/lib/graphRequests.ts, src/lib/mapGraphEvents.ts, src/lib/time.ts or src/lib/schedule.ts, before adding any /me/events or /me/calendarView call, header or $select field, and whenever a block lands an hour off, a block is not recognised as our own, a task shows as unplanned although it has a block, or Outlook sends invitations nobody asked for — in German too: "der Termin liegt eine Stunde daneben", "der Block wird nicht wiedererkannt", "warum ist die Aufgabe ungeplant", "Outlook verschickt Einladungen". Do not rely on memory — several of these contradict the obvious reading of the Microsoft docs. Not for FullCalendar dragging or rendering (that is src/view.ts), and not for sign-in or redirect problems (that is README.md, "Anmeldung").
---

# Graph Calendar

Carried over from the daily-planner web app (`github.com/dani3lh3pe/daily-planner`, stand
`59acb7c`), where M1–M4 were built against the real mailbox. Every claim says how it is known.
Plugin-specific claims are marked as such.

## The one rule

**In application code only the absolute instant (`Date`) exists. Wall-clock time lives
exclusively at the Graph boundary.**

| Direction | Format | Where |
| --- | --- | --- |
| Window bounds → Graph | `date.toISOString()` (UTC, has a `Z`) | `lib/graphRequests.ts` |
| Graph → app | Response is UTC; `fromGraphUtc()` parses it | `lib/mapGraphEvents.ts` |
| App → Graph | Berlin wall clock + `"W. Europe Standard Time"` | `lib/graphRequests.ts` |

Every zone conversion is `toWallClock()` in `src/lib/time.ts`. A second one is the bug this file
exists to prevent.

## Reading

`GET /me/calendarView?startDateTime=…&endDateTime=…` — **not** `/me/events`. Only calendarView
expands a series server-side, applies its exceptions and drops cancelled instances.

Sent on every request and page:

```
$select=id,subject,start,end,isAllDay,isCancelled,showAs,responseStatus,categories
$expand=singleValueExtendedProperties($filter=id eq 'String {F81E…C02B} Name vaultTaskId')
$top=250
Prefer: IdType="ImmutableId"
```

- **Build the query with `encodeURIComponent`** (`encodeParams`), never `URLSearchParams`: the
  latter writes spaces as `+`, and the `$filter` inside `$expand` has spaces.
- **Follow `@odata.nextLink` exactly as returned.** It carries every query option already. Plugin
  rule: `send()` refuses any URL outside `GRAPH_BASE` (`isGraphUrl`), so a nextLink can never carry
  the token to another host.
- **Do not add `createdDateTime` or `lastModifiedDateTime` to `$select`** — documented as not
  selectable on calendarView; expect a 400.
- **The `Prefer` header is per request** — documented. `graph.ts` sets it on every call.
- `MAX_EVENT_PAGES = 10` is a hard stop against a broken nextLink loop.

### Do NOT send `Prefer: outlook.timezone`

Evaluated and rejected in the web app — do not re-attempt. It changes the zone of the
**response**, but not of the `startDateTime`/`endDateTime` parameters: asked in one zone, answered
in another. Without it, responses are `{ "dateTime": "2026-09-10T07:00:00.0000000", "timeZone":
"UTC" }`.

### The `Z`-less string

Seven fractional digits and **no trailing `Z`**: `new Date(x)` reads that as local time — two
hours off in Berlin, silently. `fromGraphUtc()` slices to seconds and appends `Z`. The one parse
site drops any event whose `timeZone` is not `"UTC"` rather than guessing.

### Field traps (documented by Microsoft; handling is checkable in code)

| Field | Trap | Handling |
| --- | --- | --- |
| `isAllDay` | Midnight bounds, `end` is midnight of the **following** day | Date prefix only, all-day row, never a grid position (`toFullCalendarEvents.ts`) |
| `showAs` | `free` and `workingElsewhere` mean available | Background tint, not a wall |
| `isCancelled` | Can still sit in the calendar | Not shown, not a plan |
| `responseStatus` | `declined` is not blocked time; your own events are `none`/`organizer` | Filter `declined` only |
| occurrence `id` | Synthetic for series occurrences | Harmless: our blocks are never series |
| `categories` | Names only; the colour is in the user's master list | Tint by the first name that has a colour (M7) |

### Category colours (M7)

`GET /me/outlook/masterCategories` returns `{ displayName, color }` per category. Documented:
it needs **MailboxSettings.Read**, which needs no admin consent (delegated). `color` is `none` or
`preset0`…`preset24`. Graph names the presets (`Red`, `DarkSteel`, …) but publishes **no hex
values** — "the actual color is dependent on the Outlook client". The hex table in `styles.css`
is derived (our approximation). Not an event request, so **no** `Prefer: IdType` header. First
page only; a failed read leaves the base colour and shows no banner — decoration, not plan status.
Reading `categories` is fine; **writing** them stays forbidden (see Writing).

## The task link (plugin-specific)

A block is ours when it carries the single-value extended property
`String {F81E8688-4C88-461E-AFDA-12127709C02B} Name vaultTaskId` with value
`<vaultName>|<blockId>`. **The GUID never changes** — every block booked so far carries it.

- **The vault name is part of the value** because the test vault and the live vault share one
  calendar. Another vault's block is a foreign meeting.
- **A Planner task's block carries `planner:<taskId>`, with NO vault name** (umsetzungsplan M6): the
  task is the same in every vault, and the vaults share one calendar. Block ids are `[a-zA-Z0-9-]`
  and a Windows folder name cannot hold `:`, so it never reads as `<vaultName>|<blockId>`. Planner requests do NOT get the
  `Prefer: IdType` header — it is the calendar's; the Planner facts live in the plan's M6.
- **The POST response does not contain the property** (documented). The next read shows it.
- **`$expand` on calendarView:** documented only for single events; a Microsoft employee confirms
  it for calendarView (Q&A 462964); one report says the property vanishes when combined with
  `$select` (Q&A 1180665). **Not verified here yet — umsetzungsplan M1.0.** If it vanishes only
  with `$select`, drop `$select` (two weeks of events is a small payload). Record the result
  in this section with the date.
- `mapGraphEvents` takes the **first** expanded property's value and does not compare its id:
  the `$filter` already chose it, and Graph may echo the id in another spelling.

## Writing

```jsonc
POST /me/events            // Prefer: IdType="ImmutableId"
{
  "subject": "…", "body": { "contentType": "text", "content": "…" },
  "start": { "dateTime": "2026-09-10T09:00:00", "timeZone": "W. Europe Standard Time" },
  "end":   { "dateTime": "2026-09-10T12:00:00", "timeZone": "W. Europe Standard Time" },
  "showAs": "busy", "isReminderOn": false, "transactionId": "<uuid>",
  "singleValueExtendedProperties": [{ "id": "<the property id>", "value": "<vault>|<blockId>" }]
}
```

- **Never send `attendees`, not even an empty array.** Graph mails an invitation to everyone in it.
- **Windows zone name on the write path**, not `Europe/Berlin`: the create docs warn that methods
  "might not support all" zones.
- **`transactionId`** guards a POST that the transport re-sends. It does NOT stop a second drop —
  every drop is a new transaction; the "Wird gespeichert…" marker (`lib/readGate.ts`) does that.
- **`isReminderOn: false`** — a self-blocker that beeps is noise.
- **No `categories`** — the user had the category removed in the web app.

`PATCH /me/events/{id}` sends only start and end. Whether the id survives a PATCH no longer
matters here: the plugin keeps event ids only from one read to the next write, and the link is the
property.

`DELETE /me/events/{id}`: **a 404 counts as success** (documented). Plugin-path check:
umsetzungsplan M4.4.

`encodeURIComponent` the id in the path — base64-ish, can carry `=` and `/`.

## Immutable ids

`Prefer: IdType="ImmutableId"` on **every** event request. A default id changes when an item
moves between calendars. The plugin does not persist ids, so the stakes are lower than in the web
app — but the header costs nothing and a mixed id format would be undiagnosable.

## How each claim is known

**Verified live in the web app, 2026-09-10/11:** calendarView answers in UTC without the Prefer
timezone header; POST and calendarView ids are byte-identical with the immutable-id header; the
write path lands at the intended Berlin wall-clock time.

**Measured with Node 22 + Intl** (`src/lib/time.test.ts`): CET/CEST offsets, the spring-forward
gap, and the autumn hour where two instants share one wall-clock string (not fixable in
`dateTimeTimeZone`; one hour a year).

**Documented by Microsoft, NOT verified here:** `$top` capped at 1000; the two unselectable
fields; the Prefer header not affecting the window parameters; `attendees` triggering invitations;
`transactionId` idempotency; the POST response omitting extended properties; DELETE 404.

**Documented by Microsoft, NOT verified here (M7):** masterCategories needs MailboxSettings.Read
without admin consent; `categories` holds `displayName` values of the master list.

**Verified live in the plugin, 2026-09-28:** calendarView accepts `categories` in `$select`
alongside the `$expand` — the week loads (a 400 would have shown the banner), and the sign-in with
MailboxSettings.Read went through.

**Verified live in the plugin, 2026-09-30:** `$expand` of the task property together with
`$select` returns the value (M1.0) — booked blocks come back filled, with the task icon, as our own.

**Open, to verify live:** a categorized meeting actually tinted, i.e. masterCategories readable
(M7).

## Rejected — do not re-attempt

| Approach | Why not |
| --- | --- |
| `Prefer: outlook.timezone` | Asymmetry within one request |
| `/me/events` for reading | Client-side series expansion, exceptions, cancellations |
| Delta query, webhooks | A two-week read is small and always correct; no public endpoint |
| `categories` or a subject prefix as the marker | The user can strip them; the property they cannot |
| Retry/backoff on 429 | One user: a notice and "Erneut versuchen" are more honest than a hidden wait |
| Mirroring the plan into the vault (`⏳`, a sync service, an event cache) | A second store drifts; see CLAUDE.md, "Invarianten" |

## Where the code is

| File | Owns |
| --- | --- |
| `src/lib/time.ts` | The only zone conversion: `toWallClock`, `fromGraphUtc`, `plannerDay` |
| `src/lib/graphRequests.ts` | URLs and bodies: calendarView query, POST/PATCH bodies, event URL |
| `src/graph.ts` | `requestUrl`, headers, 401 retry, paging, DELETE-404 |
| `src/lib/mapGraphEvents.ts` | The single parse site; drops what it cannot narrow; the category colour list |
| `src/lib/toFullCalendarEvents.ts` | What `showAs`, `isCancelled`, `isAllDay` MEAN for display |
| `src/lib/schedule.ts` | Which task a block belongs to, and the planning status |
| `src/config.ts` | Zone names, the property id, `$select`, paging limits |
