// Internal writers and readers used by the ingest pipeline. Every aggregate
// the public queries read (book counts, shelves, counters) is maintained here
// so the read path never scans.

import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Id, Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { sourceKind } from "./schema";

const WEEK = 7 * 24 * 3600 * 1000;

async function bump(ctx: MutationCtx, key: string, by: number) {
  const row = await ctx.db.query("counters").withIndex("by_key", (q) => q.eq("key", key)).unique();
  if (row) await ctx.db.patch(row._id, { value: row.value + by });
  else await ctx.db.insert("counters", { key, value: by });
}

async function syncShelves(ctx: MutationCtx, book: Doc<"books">) {
  const existing = await ctx.db.query("shelves").withIndex("by_book", (q) => q.eq("bookId", book._id)).collect();
  const want = new Set(book.categories);
  for (const row of existing) {
    if (!want.has(row.category)) {
      await ctx.db.delete(row._id);
      await bump(ctx, `cat:${row.category}`, -1);
      continue;
    }
    want.delete(row.category);
    await ctx.db.patch(row._id, { lastSeenAt: book.lastSeenAt, mentionCount: book.mentionCount, trend7: book.trend7 });
  }
  for (const category of want) {
    await ctx.db.insert("shelves", { bookId: book._id, category, lastSeenAt: book.lastSeenAt, mentionCount: book.mentionCount, trend7: book.trend7 });
    await bump(ctx, `cat:${category}`, 1);
  }
}

export const lookup = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("lookups").withIndex("by_key", (q) => q.eq("key", key)).unique();
    return row ? { status: row.status, bookId: row.bookId } : null;
  },
});

export const recordLookup = internalMutation({
  args: { key: v.string(), status: v.union(v.literal("hit"), v.literal("miss")), bookId: v.optional(v.id("books")) },
  handler: async (ctx, { key, status, bookId }) => {
    const row = await ctx.db.query("lookups").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (row) await ctx.db.patch(row._id, { status, bookId, checkedAt: Date.now() });
    else await ctx.db.insert("lookups", { key, status, bookId, checkedAt: Date.now() });
  },
});

export const upsertBook = internalMutation({
  args: {
    olKey: v.string(),
    title: v.string(),
    authors: v.array(v.string()),
    coverId: v.optional(v.number()),
    firstYear: v.optional(v.number()),
    editionCount: v.optional(v.number()),
    rating: v.optional(v.number()),
    categories: v.array(v.string()),
    subjects: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<{ bookId: Id<"books">; created: boolean }> => {
    const existing = await ctx.db.query("books").withIndex("by_olKey", (q) => q.eq("olKey", args.olKey)).unique();
    if (existing) {
      // Metadata can improve between runs (a cover appears); counts never move here.
      await ctx.db.patch(existing._id, {
        coverId: existing.coverId ?? args.coverId,
        firstYear: existing.firstYear ?? args.firstYear,
        editionCount: args.editionCount ?? existing.editionCount,
        rating: args.rating ?? existing.rating,
        categories: existing.categories.length ? existing.categories : args.categories,
        subjects: existing.subjects.length ? existing.subjects : args.subjects,
      });
      return { bookId: existing._id, created: false };
    }
    const now = Date.now();
    const bookId = await ctx.db.insert("books", {
      ...args,
      mentionCount: 0,
      threadCount: 0,
      counterCount: 0,
      firstSeenAt: now,
      lastSeenAt: 0, // set by the first mention; 0 keeps it off the newest shelf until then
      trend7: 0,
      scoreSum: 0,
    });
    await bump(ctx, "books", 1);
    return { bookId, created: true };
  },
});

export const upsertThread = internalMutation({
  args: {
    redditId: v.string(),
    title: v.string(),
    flair: v.optional(v.string()),
    author: v.optional(v.string()),
    permalink: v.string(),
    createdAt: v.number(),
    numComments: v.number(),
    score: v.number(),
    source: sourceKind,
  },
  handler: async (ctx, args): Promise<Id<"threads">> => {
    const existing = await ctx.db.query("threads").withIndex("by_redditId", (q) => q.eq("redditId", args.redditId)).unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        title: args.title,
        flair: args.flair ?? existing.flair,
        numComments: Math.max(args.numComments, existing.numComments),
        score: args.score,
        // A thread first seen through the archive that is later read live is a live thread.
        source: existing.source === "archive" ? args.source : existing.source,
      });
      return existing._id;
    }
    const id = await ctx.db.insert("threads", { ...args, scannedComments: 0, mentionCount: 0 });
    await bump(ctx, "threads", 1);
    return id;
  },
});

// Which listed threads deserve a comment fetch this run: new ones, ones whose
// comment count grew since the last scan, and young ones not scanned in 6h
// (comment counts on a listing lag). Returns thread ids in priority order.
export const threadsNeedingScan = internalQuery({
  args: {
    source: sourceKind,
    posts: v.array(v.object({ redditId: v.string(), numComments: v.number(), createdAt: v.number() })),
    max: v.number(),
  },
  handler: async (ctx, { source, posts, max }) => {
    const now = Date.now();
    const scored: { redditId: string; priority: number }[] = [];
    for (const p of posts) {
      const t = await ctx.db.query("threads").withIndex("by_redditId", (q) => q.eq("redditId", p.redditId)).unique();
      const ageH = (now - p.createdAt) / 3600000;
      if (!t || !t.lastScannedAt) { scored.push({ redditId: p.redditId, priority: 1000 + p.numComments + (ageH < 24 ? 100 : 0) }); continue; }
      const staleH = (now - t.lastScannedAt) / 3600000;
      if (source === "reddit") {
        // The listing's num_comments is live: rescan when it moved.
        const grew = p.numComments - t.scannedComments;
        if (grew >= 3 || (grew >= 1 && staleH >= 2) || (ageH < 72 && staleH >= 6 && p.numComments > t.scannedComments)) {
          scored.push({ redditId: p.redditId, priority: grew * 10 + (ageH < 24 ? 50 : 0) });
        }
      } else {
        // The archive's num_comments lags by more than a day, so age decides:
        // a young thread is refetched every 2h, an older one every 12h.
        if ((ageH < 48 && staleH >= 2) || (ageH < 168 && staleH >= 12)) {
          scored.push({ redditId: p.redditId, priority: Math.max(0, 100 - ageH) });
        }
      }
    }
    scored.sort((a, b) => b.priority - a.priority);
    return scored.slice(0, max).map((s) => s.redditId);
  },
});

export const markScanned = internalMutation({
  args: { threadId: v.id("threads"), scannedComments: v.number() },
  handler: async (ctx, { threadId, scannedComments }) => {
    const t = (await ctx.db.get(threadId))!;
    await ctx.db.patch(threadId, { lastScannedAt: Date.now(), scannedComments, numComments: Math.max(t.numComments, scannedComments) });
  },
});

const draftValidator = v.object({
  bookId: v.id("books"),
  commentId: v.string(),
  parentCommentId: v.optional(v.string()),
  snippet: v.string(),
  score: v.number(),
  author: v.optional(v.string()),
  createdAt: v.number(),
  permalink: v.string(),
  confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
});

export const recordMentions = internalMutation({
  args: { threadId: v.id("threads"), source: sourceKind, drafts: v.array(draftValidator) },
  handler: async (ctx, { threadId, source, drafts }): Promise<{ inserted: number }> => {
    let inserted = 0;
    const now = Date.now();
    // Books named by each parent comment, for the counter/second decision.
    // The parent may be in an earlier batch, so read from the table as well.
    const byComment = new Map<string, Set<Id<"books">>>();
    for (const d of drafts) {
      if (!byComment.has(d.commentId)) byComment.set(d.commentId, new Set());
      byComment.get(d.commentId)!.add(d.bookId);
    }
    const parentBooks = async (commentId: string): Promise<Set<Id<"books">>> => {
      if (byComment.has(commentId)) return byComment.get(commentId)!;
      const rows = await ctx.db.query("mentions").withIndex("by_comment_book", (q) => q.eq("commentId", commentId)).collect();
      const set = new Set(rows.map((r) => r.bookId));
      byComment.set(commentId, set);
      return set;
    };

    for (const d of drafts) {
      const dup = await ctx.db
        .query("mentions")
        .withIndex("by_comment_book", (q) => q.eq("commentId", d.commentId).eq("bookId", d.bookId))
        .unique();
      if (dup) continue;
      let kind: "suggestion" | "counter" | "second" = "suggestion";
      let parentBookId: Id<"books"> | undefined;
      if (d.parentCommentId) {
        const parents = await parentBooks(d.parentCommentId);
        if (parents.size) {
          if (parents.has(d.bookId)) kind = "second";
          else { kind = "counter"; parentBookId = [...parents][0]; }
        }
      }
      await ctx.db.insert("mentions", {
        bookId: d.bookId,
        threadId,
        commentId: d.commentId,
        kind,
        parentBookId,
        snippet: d.snippet,
        score: d.score,
        author: d.author,
        createdAt: d.createdAt,
        permalink: d.permalink,
        confidence: d.confidence,
        source,
      });
      inserted++;
      await bump(ctx, "mentions", 1);

      const book = (await ctx.db.get(d.bookId))!;
      const already = await ctx.db
        .query("mentions")
        .withIndex("by_book", (q) => q.eq("bookId", d.bookId))
        .filter((q) => q.eq(q.field("threadId"), threadId))
        .first();
      const newThread = !already || already.commentId === d.commentId;
      await ctx.db.patch(d.bookId, {
        mentionCount: book.mentionCount + 1,
        threadCount: book.threadCount + (newThread ? 1 : 0),
        counterCount: book.counterCount + (kind === "counter" ? 1 : 0),
        firstSeenAt: book.mentionCount === 0 ? d.createdAt : Math.min(book.firstSeenAt, d.createdAt),
        lastSeenAt: Math.max(book.lastSeenAt, d.createdAt),
        trend7: book.trend7 + (now - d.createdAt < WEEK ? 1 : 0),
        scoreSum: book.scoreSum + d.score,
      });
      await syncShelves(ctx, (await ctx.db.get(d.bookId))!);
    }
    if (inserted) {
      const thread = (await ctx.db.get(threadId))!;
      await ctx.db.patch(threadId, { mentionCount: thread.mentionCount + inserted });
    }
    return { inserted };
  },
});

// Nightly: trend7 is incremented at write time and only decays here.
export const decayTrends = internalMutation({
  args: { cursor: v.optional(v.string()), batch: v.number() },
  handler: async (ctx, { cursor, batch }): Promise<{ done: boolean; cursor: string | null; touched: number }> => {
    const page = await ctx.db.query("books").withIndex("by_trend7", (q) => q.gt("trend7", 0)).paginate({ numItems: batch, cursor: cursor ?? null });
    const since = Date.now() - WEEK;
    let touched = 0;
    for (const book of page.page) {
      const recent = await ctx.db.query("mentions").withIndex("by_book", (q) => q.eq("bookId", book._id).gte("createdAt", since)).collect();
      if (recent.length !== book.trend7) {
        await ctx.db.patch(book._id, { trend7: recent.length });
        await syncShelves(ctx, { ...book, trend7: recent.length });
        touched++;
      }
    }
    return { done: page.isDone, cursor: page.isDone ? null : page.continueCursor, touched };
  },
});

export const openRun = internalMutation({
  args: { kind: v.union(v.literal("scan"), v.literal("backfill"), v.literal("trend")), note: v.optional(v.string()) },
  handler: async (ctx, { kind, note }): Promise<Id<"runs">> =>
    ctx.db.insert("runs", {
      kind, startedAt: Date.now(), status: "running", threadsSeen: 0, threadsScanned: 0, commentsScanned: 0,
      candidates: 0, lookups: 0, mentionsNew: 0, booksNew: 0, note, errors: [],
    }),
});

export const closeRun = internalMutation({
  args: {
    runId: v.id("runs"),
    status: v.union(v.literal("ok"), v.literal("partial"), v.literal("failed"), v.literal("skipped")),
    threadsSeen: v.number(), threadsScanned: v.number(), commentsScanned: v.number(),
    candidates: v.number(), lookups: v.number(), mentionsNew: v.number(), booksNew: v.number(),
    note: v.optional(v.string()), errors: v.array(v.string()),
  },
  handler: async (ctx, { runId, ...rest }) => {
    await ctx.db.patch(runId, { ...rest, finishedAt: Date.now() });
  },
});

export const kvGet = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("kv").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (!row) return null;
    if (row.expiresAt && row.expiresAt < Date.now()) return null;
    return row.value;
  },
});

export const kvSet = internalMutation({
  args: { key: v.string(), value: v.string(), expiresAt: v.optional(v.number()) },
  handler: async (ctx, { key, value, expiresAt }) => {
    const row = await ctx.db.query("kv").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (row) await ctx.db.patch(row._id, { value, expiresAt });
    else await ctx.db.insert("kv", { key, value, expiresAt });
  },
});
