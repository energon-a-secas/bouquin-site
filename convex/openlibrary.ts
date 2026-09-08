// Open Library search, the only metadata source. No key, no quota to renew.
// The search API asks for a descriptive User-Agent and a gentle pace; the
// ingest action calls this at most once per new candidate string, cached
// in the lookups table by ingest.ts, and sleeps between calls.

import type { OlDoc } from "./resolve";

const FIELDS = "key,title,author_name,cover_i,first_publish_year,subject,edition_count,ratings_average,ratings_count";
const UA = "bouquin.neorgon.com/1.0 (book mention mirror; contact via https://neorgon.com)";

export const OL_PACE_MS = 350;

export async function searchOpenLibrary(title: string, author?: string): Promise<OlDoc[]> {
  const params = new URLSearchParams({ title, limit: "5", fields: FIELDS });
  if (author) params.set("author", author);
  let docs = await search(params);
  // The author filter is strict about spelling ("Leguin"); a miss with an
  // author retries on the title alone, and pickMatch still requires the
  // surname to agree, so this widens recall without loosening the gate.
  if (!docs.length && author) {
    params.delete("author");
    docs = await search(params);
  }
  return docs;
}

async function search(params: URLSearchParams): Promise<OlDoc[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://openlibrary.org/search.json?${params}`, { headers: { "User-Agent": UA } });
      if (res.status === 429 || res.status === 503) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) return [];
      const data = (await res.json()) as { docs?: OlDoc[] };
      return data.docs ?? [];
    } catch {
      await sleep(1000 * (attempt + 1));
    }
  }
  return [];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
