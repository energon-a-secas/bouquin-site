// Arctic Shift client: a public Reddit archive (Pushshift's successor, run
// by ArthurHeitmann, fair-use API, no key) that had r/suggestmeabook comments
// 16 minutes old when probed on 2026-09-08.
//
// It is the ingest source whenever the deployment has no Reddit OAuth app,
// which since 2025-11-11 is the normal case: Reddit closed self-service API
// registration that day (docs/delivery/research/reddit-api-access-2026.md).
// It is also the backfill source, and the fallback if a credential lapses.
//
// Two shapes to know: scores and comment counts on a freshly archived post
// read 0 or 1 until the archive revisits it (roughly 36 hours later), so the
// archive path decides rescans by age, not by num_comments. And every page
// is capped at 100 rows.

import { normaliseComment, type RedditComment, type RedditPost, SUBREDDIT } from "./reddit";
import { sleep } from "./openlibrary";

const BASE = "https://arctic-shift.photon-reddit.com/api";
const UA = "bouquin.neorgon.com/1.0 (book mention mirror; contact via https://neorgon.com)";
const POST_FIELDS = "id,title,link_flair_text,author,created_utc,num_comments,score";
const COMMENT_FIELDS = "id,parent_id,link_id,body,author,score,created_utc";

export const ARCHIVE_PACE_MS = 600;

export async function archiveGet(path: string): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": UA } });
      if (res.status === 429) {
        const reset = Number(res.headers.get("x-ratelimit-reset") ?? "5");
        await sleep(Math.min(30, Math.max(1, reset)) * 1000);
        continue;
      }
      const data = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>[]; error?: string };
      if (!res.ok || data.error) throw new Error(`arctic shift ${res.status} on ${path}: ${data.error ?? ""}`.trim());
      return data.data ?? [];
    } catch (e) {
      // A 4xx is a request we wrote wrong; retrying it only burns the pace budget.
      if (/arctic shift 4\d\d/.test(String(e)) || attempt === 3) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  return [];
}

export function archivePost(d: Record<string, unknown>): RedditPost {
  const id = String(d.id);
  return {
    id,
    title: String(d.title ?? ""),
    flair: typeof d.link_flair_text === "string" && d.link_flair_text ? d.link_flair_text : undefined,
    author: typeof d.author === "string" ? d.author : undefined,
    permalink: `/r/${SUBREDDIT}/comments/${id}/`,
    createdAt: Number(d.created_utc ?? 0) * 1000,
    numComments: Number(d.num_comments ?? 0),
    score: Number(d.score ?? 0),
  };
}

export async function fetchArchivePosts(opts: { after: number; before?: number; limit: number; sort: "asc" | "desc" }): Promise<RedditPost[]> {
  const q = new URLSearchParams({ subreddit: SUBREDDIT, after: String(opts.after), limit: String(Math.min(100, opts.limit)), sort: opts.sort, fields: POST_FIELDS });
  if (opts.before) q.set("before", String(opts.before));
  const rows = await archiveGet(`/posts/search?${q}`);
  await sleep(ARCHIVE_PACE_MS);
  return rows.map(archivePost);
}

export async function fetchArchiveComments(postId: string): Promise<RedditComment[]> {
  const out: RedditComment[] = [];
  let after = 0;
  for (let page = 0; page < 6; page++) {
    const q = new URLSearchParams({ link_id: postId, limit: "100", sort: "asc", fields: COMMENT_FIELDS });
    if (after) q.set("after", String(after));
    const rows = await archiveGet(`/comments/search?${q}`);
    await sleep(ARCHIVE_PACE_MS);
    for (const r of rows) {
      const c = normaliseComment(r);
      if (c) out.push(c);
    }
    if (rows.length < 100) break;
    after = Number(rows[rows.length - 1].created_utc);
  }
  return out;
}
