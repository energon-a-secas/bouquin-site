// Public read API. The static site calls these over the Convex HTTP API
// (POST /api/query with {path, args}); nothing here writes.

import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { CATEGORIES } from "./resolve";

const sortValidator = v.union(v.literal("newest"), v.literal("trending"), v.literal("most"));

function publicBook(b: Doc<"books">) {
  return {
    id: b._id,
    olKey: b.olKey,
    title: b.title,
    authors: b.authors,
    coverId: b.coverId ?? null,
    firstYear: b.firstYear ?? null,
    rating: b.rating ?? null,
    categories: b.categories,
    mentionCount: b.mentionCount,
    threadCount: b.threadCount,
    counterCount: b.counterCount,
    firstSeenAt: b.firstSeenAt,
    lastSeenAt: b.lastSeenAt,
    trend7: b.trend7,
  };
}

export const list = query({
  args: {
    sort: sortValidator,
    category: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { sort, category, cursor, limit }) => {
    const numItems = Math.min(Math.max(limit ?? 24, 1), 60);
    const opts = { numItems, cursor: cursor ?? null };
    if (category && category !== "all") {
      const index = sort === "newest" ? "by_cat_recent" : sort === "trending" ? "by_cat_trend" : "by_cat_count";
      const page = await ctx.db.query("shelves").withIndex(index, (q) => q.eq("category", category)).order("desc").paginate(opts);
      const books = await Promise.all(page.page.map((s) => ctx.db.get(s.bookId)));
      return {
        items: books.filter((b): b is Doc<"books"> => !!b && b.mentionCount > 0).map(publicBook),
        cursor: page.isDone ? null : page.continueCursor,
      };
    }
    const index = sort === "newest" ? "by_lastSeenAt" : sort === "trending" ? "by_trend7" : "by_mentionCount";
    const page = await ctx.db.query("books").withIndex(index).order("desc").paginate(opts);
    return {
      items: page.page.filter((b) => b.mentionCount > 0).map(publicBook),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const search = query({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    const term = q.trim();
    if (term.length < 2) return [];
    const rows = await ctx.db.query("books").withSearchIndex("search_title", (s) => s.search("title", term)).take(20);
    return rows.filter((b) => b.mentionCount > 0).map(publicBook);
  },
});

export const get = query({
  args: { id: v.id("books") },
  handler: async (ctx, { id }) => {
    const book = await ctx.db.get(id);
    if (!book) return null;
    const mentions = await ctx.db.query("mentions").withIndex("by_book", (q) => q.eq("bookId", id)).order("desc").take(60);
    const threadIds = [...new Set(mentions.map((m) => m.threadId))];
    const threads = new Map<Id<"threads">, Doc<"threads">>();
    for (const tid of threadIds) {
      const t = await ctx.db.get(tid);
      if (t) threads.set(tid, t);
    }
    const parentIds = [...new Set(mentions.map((m) => m.parentBookId).filter((x): x is Id<"books"> => !!x))];
    const parents = new Map<Id<"books">, string>();
    for (const pid of parentIds) {
      const p = await ctx.db.get(pid);
      if (p) parents.set(pid, p.title);
    }
    return {
      ...publicBook(book),
      subjects: book.subjects,
      editionCount: book.editionCount ?? null,
      mentions: mentions.map((m) => {
        const t = threads.get(m.threadId);
        return {
          id: m._id,
          kind: m.kind,
          insteadOf: m.parentBookId ? parents.get(m.parentBookId) ?? null : null,
          snippet: m.snippet,
          score: m.score,
          author: m.author ?? null,
          createdAt: m.createdAt,
          permalink: m.permalink,
          confidence: m.confidence,
          thread: t ? { title: t.title, flair: t.flair ?? null, permalink: t.permalink, createdAt: t.createdAt } : null,
        };
      }),
    };
  },
});

async function counter(ctx: QueryCtx, key: string): Promise<number> {
  const row = await ctx.db.query("counters").withIndex("by_key", (q) => q.eq("key", key)).unique();
  return row?.value ?? 0;
}

export const categories = query({
  args: {},
  handler: async (ctx) => {
    const out = [];
    for (const c of CATEGORIES) {
      const n = await counter(ctx, `cat:${c.id}`);
      if (n > 0) out.push({ id: c.id, label: c.label, count: n });
    }
    return out;
  },
});

export const stats = query({
  args: {},
  handler: async (ctx) => {
    const lastRuns = await ctx.db.query("runs").withIndex("by_startedAt").order("desc").take(12);
    const lastScan = lastRuns.find((r) => r.kind === "scan");
    const lastIngest = lastRuns.find((r) => (r.kind === "scan" || r.kind === "backfill") && r.status !== "skipped" && r.status !== "running");
    const backfillRaw = await ctx.db.query("kv").withIndex("by_key", (q) => q.eq("key", "backfill")).unique();
    const backfill = backfillRaw ? (JSON.parse(backfillRaw.value) as { threads: number; stopped?: boolean; chunks: number }) : null;
    return {
      books: await counter(ctx, "books"),
      mentions: await counter(ctx, "mentions"),
      threads: await counter(ctx, "threads"),
      lastIngestAt: lastIngest?.finishedAt ?? null,
      lastIngestKind: lastIngest?.kind ?? null,
      lastScan: lastScan
        ? {
            at: lastScan.finishedAt ?? lastScan.startedAt,
            status: lastScan.status,
            source: lastScan.note?.startsWith("source ") ? lastScan.note.slice(7) : null,
            mentionsNew: lastScan.mentionsNew,
          }
        : null,
      backfill: backfill ? { threads: backfill.threads, running: !backfill.stopped, chunks: backfill.chunks } : null,
    };
  },
});
