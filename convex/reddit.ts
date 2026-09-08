// Reddit Data API client for the ingest action. App-only OAuth
// (grant_type=client_credentials) against www.reddit.com, then reads from
// oauth.reddit.com. Nothing here touches the database: it is imported by
// ingest.ts and holds every Reddit-specific shape in one place.
//
// Rate budget: Reddit allows 100 requests per minute per OAuth client,
// reported back in X-Ratelimit-Remaining / X-Ratelimit-Reset. One scan is
// one token mint, one listing and at most MAX_THREADS_PER_SCAN thread reads.

export const SUBREDDIT = "suggestmeabook";
export const MAX_THREADS_PER_SCAN = 25;

export interface RedditCreds {
  clientId: string;
  clientSecret: string;
  userAgent: string;
}

export interface RedditPost {
  id: string;
  title: string;
  flair?: string;
  author?: string;
  permalink: string;
  createdAt: number; // ms
  numComments: number;
  score: number;
}

export interface RedditComment {
  id: string;
  parentId: string; // "t3_<post>" for top level, "t1_<comment>" for replies
  body: string;
  author?: string;
  score: number;
  createdAt: number; // ms
  permalink: string;
}

const BOT_AUTHORS = new Set(["AutoModerator", "goodreads-bot", "sneakpeekbot", "RemindMeBot", "WikiSummarizerBot", "[deleted]"]);

export function credsFromEnv(): RedditCreds | null {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT;
  if (!clientId || !clientSecret || !userAgent) return null;
  return { clientId, clientSecret, userAgent };
}

export async function fetchToken(creds: RedditCreds): Promise<{ token: string; expiresAt: number }> {
  const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": creds.userAgent,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(`reddit token ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!data.access_token) throw new Error(`reddit token: ${data.error ?? "no access_token in response"}`);
  return { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
}

async function oauthGet(path: string, token: string, userAgent: string): Promise<unknown> {
  const res = await fetch(`https://oauth.reddit.com${path}${path.includes("?") ? "&" : "?"}raw_json=1`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent },
  });
  if (res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    throw new Error(`reddit 429 rate limited, resets in ${reset ?? "?"}s`);
  }
  if (!res.ok) throw new Error(`reddit ${res.status} on ${path}`);
  return res.json();
}

type Listing<T> = { kind: "Listing"; data: { children: { kind: string; data: T }[] } };

function toPost(d: Record<string, unknown>): RedditPost {
  return {
    id: String(d.id),
    title: String(d.title ?? ""),
    flair: typeof d.link_flair_text === "string" && d.link_flair_text ? d.link_flair_text : undefined,
    author: typeof d.author === "string" ? d.author : undefined,
    permalink: String(d.permalink ?? `/r/${SUBREDDIT}/comments/${d.id}/`),
    createdAt: Number(d.created_utc ?? 0) * 1000,
    numComments: Number(d.num_comments ?? 0),
    score: Number(d.score ?? 0),
  };
}

export async function fetchNewPosts(token: string, userAgent: string, limit = 100): Promise<RedditPost[]> {
  const data = (await oauthGet(`/r/${SUBREDDIT}/new?limit=${limit}`, token, userAgent)) as Listing<Record<string, unknown>>;
  return (data.data?.children ?? []).filter((c) => c.kind === "t3").map((c) => toPost(c.data));
}

// Flattens the comment tree the /comments endpoint returns. "more" stubs
// (collapsed replies past the depth or limit) are skipped: the suggestions
// live in the top of the thread, and a rescan picks up what grows.
export async function fetchThreadComments(postId: string, token: string, userAgent: string): Promise<{ post: RedditPost; comments: RedditComment[] }> {
  const data = (await oauthGet(`/comments/${postId}?limit=500&depth=4&sort=top`, token, userAgent)) as [Listing<Record<string, unknown>>, Listing<Record<string, unknown>>];
  const postData = data[0]?.data?.children?.[0]?.data;
  if (!postData) throw new Error(`reddit: no post data for ${postId}`);
  const post = toPost(postData);
  const comments: RedditComment[] = [];
  const walk = (listing: Listing<Record<string, unknown>> | "" | undefined) => {
    if (!listing || typeof listing === "string") return;
    for (const child of listing.data?.children ?? []) {
      if (child.kind !== "t1") continue;
      const d = child.data;
      const c = normaliseComment(d);
      if (c) comments.push(c);
      walk(d.replies as Listing<Record<string, unknown>> | "" | undefined);
    }
  };
  walk(data[1]);
  return { post, comments };
}

// Shared by the live path and the archive backfill: both hand over raw
// reddit-shaped objects.
export function normaliseComment(d: Record<string, unknown>): RedditComment | null {
  const body = typeof d.body === "string" ? d.body : "";
  const author = typeof d.author === "string" ? d.author : undefined;
  if (!body || body === "[removed]" || body === "[deleted]") return null;
  if (author && BOT_AUTHORS.has(author)) return null;
  const id = String(d.id ?? "");
  const linkId = String(d.link_id ?? "").replace(/^t3_/, "");
  return {
    id,
    parentId: String(d.parent_id ?? ""),
    body,
    author,
    score: Number(d.score ?? 0),
    createdAt: Number(d.created_utc ?? 0) * 1000,
    permalink: typeof d.permalink === "string" && d.permalink ? d.permalink : `/r/${SUBREDDIT}/comments/${linkId}/_/${id}/`,
  };
}
