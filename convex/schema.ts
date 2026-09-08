import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Bouquin keeps what the site needs to show and to link back, not the corpus:
// a thread row per r/suggestmeabook post it has looked at, a book row per
// Open Library work that at least one comment resolved to, and a mention row
// per (comment, book) pair carrying one sentence of context and a permalink.
// Everything aggregate (counts, trend, shelves) is denormalised at write time
// because the public queries run on every page load and the writers run
// every 30 minutes.

export const mentionKind = v.union(
  v.literal("suggestion"), // named in a top-level comment, or in a reply whose parent named no book
  v.literal("counter"),    // a reply naming a different book than its parent comment did
  v.literal("second"),     // a reply naming the same book its parent did ("seconding this")
);

export const sourceKind = v.union(v.literal("reddit"), v.literal("archive"));

export default defineSchema({
  threads: defineTable({
    redditId: v.string(),           // base36 post id, "1wamn4b"
    title: v.string(),
    flair: v.optional(v.string()),
    author: v.optional(v.string()),
    permalink: v.string(),          // "/r/suggestmeabook/comments/…/"
    createdAt: v.number(),          // ms
    numComments: v.number(),        // as last seen on the listing
    score: v.number(),
    source: sourceKind,
    lastScannedAt: v.optional(v.number()),
    scannedComments: v.number(),    // numComments at the last full scan
    mentionCount: v.number(),
  })
    .index("by_redditId", ["redditId"])
    .index("by_createdAt", ["createdAt"]),

  books: defineTable({
    olKey: v.string(),              // "/works/OL21745884W"
    title: v.string(),
    authors: v.array(v.string()),
    coverId: v.optional(v.number()),
    firstYear: v.optional(v.number()),
    editionCount: v.optional(v.number()),
    rating: v.optional(v.number()),
    categories: v.array(v.string()),   // ids from resolve.ts CATEGORIES, up to 3
    subjects: v.array(v.string()),     // first 20 Open Library subjects, for the detail sheet
    mentionCount: v.number(),          // distinct comments naming it
    threadCount: v.number(),           // distinct threads naming it
    counterCount: v.number(),          // mentions of kind "counter"
    firstSeenAt: v.number(),           // earliest mention createdAt
    lastSeenAt: v.number(),            // latest mention createdAt
    trend7: v.number(),                // mentions in the trailing 7 days, decayed daily
    scoreSum: v.number(),              // sum of comment scores at ingest time
  })
    .index("by_olKey", ["olKey"])
    .index("by_lastSeenAt", ["lastSeenAt"])
    .index("by_mentionCount", ["mentionCount"])
    .index("by_trend7", ["trend7"])
    .searchIndex("search_title", { searchField: "title" }),

  // One row per (book, category): the category-filtered sorts read these
  // instead of scanning books and filtering an array in JS.
  shelves: defineTable({
    bookId: v.id("books"),
    category: v.string(),
    lastSeenAt: v.number(),
    mentionCount: v.number(),
    trend7: v.number(),
  })
    .index("by_book", ["bookId"])
    .index("by_cat_recent", ["category", "lastSeenAt"])
    .index("by_cat_count", ["category", "mentionCount"])
    .index("by_cat_trend", ["category", "trend7"]),

  mentions: defineTable({
    bookId: v.id("books"),
    threadId: v.id("threads"),
    commentId: v.string(),          // reddit comment id, base36
    kind: mentionKind,
    parentBookId: v.optional(v.id("books")),
    snippet: v.string(),            // the sentence around the mention, at most 240 chars
    score: v.number(),
    author: v.optional(v.string()),
    createdAt: v.number(),
    permalink: v.string(),
    confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    source: sourceKind,
  })
    .index("by_book", ["bookId", "createdAt"])
    .index("by_book_thread", ["bookId", "threadId"])
    .index("by_thread", ["threadId"])
    .index("by_comment_book", ["commentId", "bookId"]),

  // Open Library lookups are cached by normalised "title|author" so the same
  // string never costs a second request, including the misses: a string that
  // resolved to nothing last week resolves to nothing today.
  lookups: defineTable({
    key: v.string(),
    status: v.union(v.literal("hit"), v.literal("miss")),
    bookId: v.optional(v.id("books")),
    checkedAt: v.number(),
  }).index("by_key", ["key"]),

  counters: defineTable({
    key: v.string(),                // "books", "mentions", "threads", "cat:fantasy", …
    value: v.number(),
  }).index("by_key", ["key"]),

  runs: defineTable({
    kind: v.union(v.literal("scan"), v.literal("backfill"), v.literal("trend")),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    status: v.union(v.literal("running"), v.literal("ok"), v.literal("partial"), v.literal("failed"), v.literal("skipped")),
    threadsSeen: v.number(),
    threadsScanned: v.number(),
    commentsScanned: v.number(),
    candidates: v.number(),
    lookups: v.number(),
    mentionsNew: v.number(),
    booksNew: v.number(),
    note: v.optional(v.string()),
    errors: v.array(v.string()),
  }).index("by_startedAt", ["startedAt"]),

  // Small key/value state: the backfill cursor and the last OAuth token.
  kv: defineTable({
    key: v.string(),
    value: v.string(),
    expiresAt: v.optional(v.number()),
  }).index("by_key", ["key"]),
});
