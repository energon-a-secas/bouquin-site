// ── Convex HTTP API client ────────────────────────────────────
// Read-only. The site has no login: every function it calls is a public
// query, and the cron that writes runs on Convex, not in the browser.

export const CONVEX_URL = 'https://elegant-bear-662.convex.cloud';

async function query(path, args = {}) {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
  });
  if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status}`);
  const data = await res.json();
  if (data.status === 'error') throw new Error(data.errorMessage || `${path} failed`);
  return data.value;
}

/** One page of books. sort: newest | trending | most. category: id or null. */
export function listBooks({ sort, category, cursor, limit }) {
  const args = { sort, limit };
  if (category && category !== 'all') args.category = category;
  if (cursor) args.cursor = cursor;
  return query('books:list', args);
}

export function searchBooks(q) {
  return query('books:search', { q });
}

export function getBook(id) {
  return query('books:get', { id });
}

export function getCategories() {
  return query('books:categories', {});
}

export function getStats() {
  return query('books:stats', {});
}
