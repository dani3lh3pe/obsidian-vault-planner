/** The narrowing every Graph and Entra answer starts with. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One page of an OData collection: the items, and where the next page lives. Defensive: a
 * response of the wrong shape yields an empty page instead of throwing inside a paging loop.
 */
export function readPage(body: unknown): { value: unknown[]; nextLink: string | null } {
  if (!isRecord(body)) return { value: [], nextLink: null };
  const next = body["@odata.nextLink"];
  return {
    value: Array.isArray(body.value) ? body.value : [],
    nextLink: typeof next === "string" ? next : null,
  };
}
