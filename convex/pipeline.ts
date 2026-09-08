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
}

export interface Budget {
  lookupsLeft: number; // Open Library requests this run may still make
}

export type Source = "reddit" | "archive";

export interface MentionDraft {
  bookId: Id<"books">;
  commentId: string;
  parentCommentId?: string;
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

// Resolves a candidate to a book id, through the lookups cache first.
// Returns null on a miss (also cached) or when the budget is spent.
async function resolveCandidate(ctx: ActionCtx, c: Candidate, budget: Budget, stats: ThreadStats): Promise<Id<"books"> | null> {
  const key = lookupKey(c);
  const cached = await ctx.runQuery(internal.store.lookup, { key });
  if (cached) return cached.status === "hit" ? (cached.bookId ?? null) : null;
  if (budget.lookupsLeft <= 0) return null;
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
  const stats: ThreadStats = { commentsScanned: comments.length, candidates: 0, lookups: 0, mentionsNew: 0, booksNew: 0 };
  const threadId = await ctx.runMutation(internal.store.upsertThread, {
    redditId: post.id,
    title: post.title,
    flair: post.flair,
    author: post.author,
    permalink: post.permalink,
    createdAt: post.createdAt,
    numComments: post.numComments,
    score: post.score,
    source,
  });

  const drafts: MentionDraft[] = [];
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
      drafts.push({
        bookId,
        commentId: comment.id,
        parentCommentId: comment.parentId.startsWith("t1_") ? comment.parentId.slice(3) : undefined,
        snippet: snippetAround(comment.body, c.raw),
        score: comment.score,
        author: comment.author,
        createdAt: comment.createdAt,
        permalink: comment.permalink,
        confidence: c.confidence,
      });
    }
  }

  // Write in batches so one mutation never carries a whole 400-comment thread.
  for (let i = 0; i < drafts.length; i += 40) {
    const { inserted } = await ctx.runMutation(internal.store.recordMentions, {
      threadId,
      source,
      drafts: drafts.slice(i, i + 40),
    });
    stats.mentionsNew += inserted;
  }
  await ctx.runMutation(internal.store.markScanned, { threadId, scannedComments: comments.length });
  return stats;
}
