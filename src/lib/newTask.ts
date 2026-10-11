import { CUSTOMER_ROOT, INTERN_ROOT } from "../config";
import { taskLabel } from "./parseTask";

/** The notes the "New task" form can write into (M10), by customer. */
export interface CustomerTargets {
  customer: string;
  /** Named for the project dropdown. */
  targets: { path: string; label: string }[];
}

/**
 * Every note below `10_Kunden/<C>/` and `20_Intern/`, by customer, named by its path below the
 * customer folder (below `20_Intern/` for "junis intern") — paths are unique, names would not be.
 * The customer's own note — no project by `taskLabel` (`_infos`, or the old `<C>/<C>.md`), directly
 * in that folder — comes first.
 */
export function taskTargets(paths: readonly string[]): CustomerTargets[] {
  const collate = (a: string, b: string) => a.localeCompare(b, "de");
  const entries = paths
    .flatMap((path) => {
      const parts = path.replace(/\.md$/u, "").split("/");
      const depth = parts[0] === CUSTOMER_ROOT ? 2 : parts[0] === INTERN_ROOT ? 1 : 0;
      if (depth === 0 || parts.length <= depth) return [];
      const { customer, project } = taskLabel(path);
      return [{ customer, own: project === null && parts.length === depth + 1, path, label: parts.slice(depth).join("/") }];
    })
    .sort((a, b) => collate(a.customer, b.customer) || Number(b.own) - Number(a.own) || collate(a.label, b.label));
  const byCustomer = new Map<string, CustomerTargets["targets"]>();
  for (const { customer, path, label } of entries) byCustomer.set(customer, [...(byCustomer.get(customer) ?? []), { path, label }]);
  return [...byCustomer].map(([customer, targets]) => ({ customer, targets }));
}

/** "<customer> · <label>": the note as the form named it, for the notice. */
export function targetName(customers: readonly CustomerTargets[], path: string): string {
  for (const { customer, targets } of customers) {
    const target = targets.find((entry) => entry.path === path);
    if (target !== undefined) return `${customer} · ${target.label}`;
  }
  return path;
}

/**
 * The form's preselection: the list filter's customer if it is one, else the customer of the note
 * used last; that note only within its own customer. null means the placeholder.
 */
export function preselect(
  customers: readonly CustomerTargets[],
  filter: string | null,
  lastPath: string | null,
): { customer: string | null; path: string | null } {
  const last = customers.find((entry) => entry.targets.some((target) => target.path === lastPath));
  const customer = customers.find((entry) => entry.customer === filter) ?? last;
  if (customer === undefined) return { customer: null, path: null };
  return { customer: customer.customer, path: customer === last ? lastPath : null };
}
