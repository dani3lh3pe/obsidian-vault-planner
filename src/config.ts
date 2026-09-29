/**
 * Everything the plugin does not ask the user for. One user, one vault: constants, not settings.
 * The only settings (see main.ts) are the tenant and client id, which must not live in git, and the
 * Planner switch.
 */

/**
 * Windows zone name for the WRITE path. Graph's create/update methods "might not support all"
 * dateTimeTimeZone zones, and /me/outlook/supportedTimeZones answers in the Windows format.
 */
export const PLANNER_TIME_ZONE = "W. Europe Standard Time";

/** IANA name for Intl — the only place zone maths happens (lib/time.ts). */
export const PLANNER_IANA_ZONE = "Europe/Berlin";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const LOGIN_BASE = "https://login.microsoftonline.com";

/**
 * OIDC scopes for the id token and the refresh token, plus the Graph permissions. MailboxSettings.Read
 * only reads the category colours (M7). Tasks.ReadWrite only while Planner is switched on: without it
 * the consent never asks for the task boards.
 */
export function scopes(planner: boolean): string {
  const base =
    "openid profile offline_access https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/MailboxSettings.Read";
  return planner ? `${base} https://graph.microsoft.com/Tasks.ReadWrite` : base;
}

/** `obsidian://vault-planner-auth` — registered as a custom redirect URI in Entra. */
export const REDIRECT_ACTION = "vault-planner-auth";
export const REDIRECT_URI = `obsidian://${REDIRECT_ACTION}`;

/**
 * Immutable ids, on EVERY event request, every page (graph-calendar skill). The plugin keeps no
 * event id beyond one read, so the stakes are lower than in the web app — the rule costs nothing.
 */
export const IMMUTABLE_ID_HEADER = { Prefer: 'IdType="ImmutableId"' } as const;

/** `createdDateTime`/`lastModifiedDateTime` are NOT $select-able on calendarView. */
export const EVENT_SELECT = "id,subject,start,end,isAllDay,isCancelled,showAs,responseStatus,categories";
export const EVENT_PAGE_SIZE = 250;
/** A broken nextLink loop would otherwise hang the view. Two weeks never come close. */
export const MAX_EVENT_PAGES = 10;

/**
 * The link from an Outlook event to a task line: value "<vaultName>|<blockId>".
 *
 * Generated once on 2026-09-24. NEVER change it — every block booked so far carries this id, and
 * a new GUID would turn all of them into foreign meetings.
 */
export const TASK_PROPERTY_ID = "String {F81E8688-4C88-461E-AFDA-12127709C02B} Name vaultTaskId";

/** Background refresh while the view is visible; returning to it refreshes at once. */
export const REFRESH_INTERVAL_MS = 15_000;
/**
 * Planner on its own, slower clock (web app M13): a board changes in minutes, and a 429 there must
 * not take the calendar with it.
 */
export const PLANNER_REFRESH_INTERVAL_MS = 60_000;
/** A broken nextLink loop would otherwise hang the list, like MAX_EVENT_PAGES for the calendar. */
export const MAX_PLANNER_PAGES = 10;
/** Planner tasks share one entry in the customer filter; the plan is their project. */
export const PLANNER_LABEL = "Planner";
/** `requestUrl` has no timeout of its own. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Renew the access token this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** The grid's FLOOR, not its frame: visibleHours widens it to the week's events. */
export const WORK_HOURS = { start: "07:00:00", end: "19:00:00" } as const;
/** Core hours, shaded inside the grid. */
export const BUSINESS_HOURS = { daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "17:00" };

/** The planning status looks at this week and the next, whatever week is on screen. */
export const STATUS_WINDOW_DAYS = 14;

/** Where tasks come from: `<Folder>/<Folder>.md` below these roots. */
export const CUSTOMER_ROOT = "10_Kunden";
export const INTERN_ROOT = "20_Intern";
export const INTERN_LABEL = "junis intern";

/**
 * The Tasks plugin's global filter, if the live vault uses one (umsetzungsplan M0.2).
 * Empty means every checkbox line is a task, which is the Tasks default.
 */
export const TASKS_GLOBAL_FILTER = "";

/** Checkbox characters that count as open: Tasks' "todo" and "in progress". */
export const OPEN_STATUSES: readonly string[] = [" ", "/"];

/** A date this close lands in "Nächste 7 Tage" — the web app's urgency horizon. */
export const URGENT_WITHIN_DAYS = 7;

/** Without `[aufwand::]` a block is booked for one hour, the same proposal as the web app. */
export const DEFAULT_AUFWAND_HOURS = 1;

/** Device-local storage keys. Never in data.json: that file lives in the synced vault. */
export const SECRET_REFRESH_TOKEN = "vault-planner-refresh-token";
export const LOCAL_ACCOUNT_KEY = "vault-planner-account";
/** The calendar view last chosen in the toolbar ("workWeek", "days3", …). */
export const CALENDAR_VIEW_KEY = "vault-planner-calendar-view";

export const VIEW_TYPE = "vault-planner-view";

/** How far the pointer may travel between press and release and still count as a click. */
export const CLICK_SLOP_PX = 5;
