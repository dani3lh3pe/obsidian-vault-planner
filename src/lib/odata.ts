/**
 * One page of an OData collection: the items, and where the next page lives. Defensive: a
 * response of the wrong shape yields an empty page instead of throwing inside a paging loop.
 */
export function readPage(body: unknown): { value: unknown[]; nextLink: string | null } {
  if (typeof body !== "object" || body === null) return { value: [], nextLink: null };
  const record = body as Record<string, unknown>;
  const next = record["@odata.nextLink"];
  return {
    value: Array.isArray(record.value) ? record.value : [],
    nextLink: typeof next === "string" ? next : null,
  };
}
