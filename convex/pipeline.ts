// The shared half of ingestion: given a thread and its comments (from Reddit
// live or from the archive), extract candidates, resolve them, and write the
// mentions. Both ingest.ts (cron) and backfill.ts call processThread, so the
// two sources cannot drift in what counts as a mention.

import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { extractCandidates, normaliseTitle, type Candidate } from "./extract";
import { pickMatch, categorise, type OlDoc } from "./resolve";
import { searchOpenLibrary, sleep, OL_PACE_MS } from "./openlibrary";
import type { RedditComment, RedditPost } from "./reddit";

export interface ThreadStats {
  commentsScanned: number;
  candidates: number;
  lookups: number;
  mentionsNew: number;
  booksNew: number;
  // True when at least one uncached candidate was skipped because the run's
  // lookup budget was spent. The caller must then leave the thread unmarked
  // so the next run picks it up again; otherwise those books are lost.
  budgetExhausted: boolean;
}

export interface Budget {
  lookupsLeft: number; // Open Library requests this run may still make
  deadline: number;    // Date.now() after which callers stop starting work
}

export type Source = "reddit" | "archive";
export type MentionKind = "suggestion" | "counter" | "second";

export interface MentionDraft {
  bookId: Id<"books">;
  commentId: string;
  parentCommentId?: string;
  kind: MentionKind;
  parentBookId?: Id<"books">;
  snippet: string;
  score: number;
  author?: string;
  createdAt: number;
  permalink: string;
  confidence: Candidate["confidence"];
}

function lookupKey(c: Candidate): string {
  return `${normaliseTitle(c.title)}|${(c.author ?? "").toLowerCase().replace(/[^a-z ]/g, "").trim()}`;
}

// One sentence of context around the raw match, for the detail sheet.
function snippetAround(body: string, raw: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(raw.slice(0, 40).toLowerCase());
  if (at < 0) return flat.slice(0, 240);
  const start = Math.max(0, flat.lastIndexOf(". ", at) + 1);
  const endDot = flat.indexOf(". ", at + raw.length);
  const end = endDot < 0 ? Math.min(flat.length, at + raw.length + 160) : Math.min(endDot + 1, start + 240);
  return flat.slice(start, end).trim().slice(0, 240);
}

// Reddit timestamps are epoch seconds times 1000; anything outside a sane
// window is a parse error upstream and must not reach toISOString on the page.
function saneTime(ms: number, fallback: number): number {
  return Number.isFinite(ms) && ms > 946684800000 && ms < 4102444800000 ? ms : fallback;
}

// Resolves a candidate to a book id, through the lookups cache first.
// Returns null on a miss (also cached) or when the budget is spent.
async function resolveCandidate(ctx: ActionCtx, c: Candidate, budget: Budget, stats: ThreadStats): Promise<Id<"books"> | null> {
  const key = lookupKey(c);
  const cached = await ctx.runQuery(internal.store.lookup, { key });
  if (cached) return cached.status === "hit" ? (cached.bookId ?? null) : null;
  if (budget.lookupsLeft <= 0 || Date.now() > budget.deadline) {
    stats.budgetExhausted = true;
    return null;
  }
  budget.lookupsLeft--;
  stats.lookups++;
  const docs: OlDoc[] = await searchOpenLibrary(c.title, c.author);
  await sleep(OL_PACE_MS);
  const match = pickMatch(c, docs);
  if (!match) {
    await ctx.runMutation(internal.store.recordLookup, { key, status: "miss" });
    return null;
  }
  const d = match.doc;
  const { bookId, created } = await ctx.runMutation(internal.store.upsertBook, {
    olKey: d.key,
    title: d.title,
    authors: (d.author_name ?? []).slice(0, 3),
    coverId: d.cover_i,
    firstYear: d.first_publish_year,
    editionCount: d.edition_count,
    rating: d.ratings_average,
    categories: categorise(d.subject),
    subjects: (d.subject ?? []).slice(0, 20),
  });
  if (created) stats.booksNew++;
  await ctx.runMutation(internal.store.recordLookup, { key, status: "hit", bookId });
  return bookId;
}

export async function processThread(
  ctx: ActionCtx,
  post: RedditPost,
  comments: RedditComment[],
  source: Source,
  budget: Budget,
): Promise<ThreadStats> {
  const stats: ThreadStats = { commentsScanned: comments.length, candidates: 0, lookups: 0, mentionsNew: 0, booksNew: 0, budgetExhausted: false };
  const now = Date.now();
  const threadId = await ctx.runMutation(internal.store.upsertThread, {
    redditId: post.id,
    title: post.title,
    flair: post.flair,
    author: post.author,
    permalink: post.permalink,
    createdAt: saneTime(post.createdAt, now),
    numComments: post.numComments,
    score: post.score,
    source,
  });

  // First pass: resolve every candidate and remember which books each
  // comment named, so a reply's kind can be decided against its parent
  // whether the parent sits earlier or later in the fetched order.
  const raw: Omit<MentionDraft, "kind" | "parentBookId">[] = [];
  const booksByComment = new Map<string, Set<Id<"books">>>();
  const memo = new Map<string, Id<"books"> | null>();
  for (const comment of comments) {
    const candidates = extractCandidates(comment.body);
    stats.candidates += candidates.length;
    const seenInComment = new Set<string>();
    for (const c of candidates.slice(0, 12)) {
      const key = lookupKey(c);
      let bookId: Id<"books"> | null;
      if (memo.has(key)) bookId = memo.get(key) ?? null;
      else {
        bookId = await resolveCandidate(ctx, c, budget, stats);
        memo.set(key, bookId);
      }
      if (!bookId || seenInComment.has(bookId)) continue;
      seenInComment.add(bookId);
      if (!booksByComment.has(comment.id)) booksByComment.set(comment.id, new Set());
      booksByComment.get(comment.id)!.add(bookId);
      raw.push({
        bookId,
        commentId: comment.id,
        parentCommentId: comment.parentId.startsWith("t1_") ? comment.parentId.slice(3) : undefined,
        snippet: snippetAround(comment.body, c.raw),
        score: comment.score,
        author: comment.author,
        createdAt: saneTime(comment.createdAt, now),
        permalink: comment.permalink,
        confidence: c.confidence,
      });
    }
  }

  // Second pass: kind. A parent that named nothing in this fetch may have
  // named something in an earlier scan; recordMentions falls back to the
  // table for those, so only parents known here are decided here.
  const drafts: MentionDraft[] = raw.map((d) => {
    const parents = d.parentCommentId ? booksByComment.get(d.parentCommentId) : undefined;
    if (!parents || !parents.size) return { ...d, kind: "suggestion" };
    if (parents.has(d.bookId)) return { ...d, kind: "second" };
    return { ...d, kind: "counter", parentBookId: [...parents][0] };
  });

  // Write in batches so one mutation never carries a whole 400-comment thread.
  for (let i = 0; i < drafts.length; i += 40) {
    const { inserted } = await ctx.runMutation(internal.store.recordMentions, {
      threadId,
      source,
      drafts: drafts.slice(i, i + 40),
    });
    stats.mentionsNew += inserted;
  }

  // A thread the budget cut short stays unmarked so the next run returns to
  // it; the mentions already written are deduplicated on that pass.
  if (!stats.budgetExhausted) {
    await ctx.runMutation(internal.store.markScanned, {
      threadId,
      // The reddit listing's num_comments is what threadsNeedingScan compares
      // against next time, so that is what "scanned" must mean there. The
      // archive path is age-based and records what it actually fetched.
      scannedComments: source === "reddit" ? post.numComments : comments.length,
    });
  }
  return stats;
}
