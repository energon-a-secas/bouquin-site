// One-time history seed from the Arctic Shift archive (see archive.ts),
// through the same pipeline the cron uses.
//
// A Convex action has a 10 minute ceiling and the archive wants a gentle
// pace, so the backfill is chunked: each invocation handles up to
// THREADS_PER_CHUNK threads, saves its cursor in kv, and schedules the next
// chunk. Start it with
//
//   npx convex run backfill:start '{"days": 30}'
//
// and stop it early with  npx convex run backfill:stop.

import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { fetchArchivePosts, fetchArchiveComments } from "./archive";
import { processThread, type Budget } from "./pipeline";

const THREADS_PER_CHUNK = 40;
const LOOKUPS_PER_CHUNK = 250;
const MAX_CONSECUTIVE_FAILURES = 3;

interface Progress {
  from: number;    // epoch seconds, lower bound of the window
  to: number;      // epoch seconds, upper bound
  cursor: number;  // created_utc of the last post processed
  threads: number;
  mentions: number;
  books: number;
  chunks: number;
  failures: number; // consecutive chunks that made no progress
  stopped?: boolean;
  note?: string;
}

export const start = internalAction({
  args: { days: v.number() },
  handler: async (ctx, { days }) => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - Math.floor(days * 86400);
    const progress: Progress = { from, to, cursor: from, threads: 0, mentions: 0, books: 0, chunks: 0, failures: 0 };
    await ctx.runMutation(internal.store.kvSet, { key: "backfill", value: JSON.stringify(progress) });
    await ctx.scheduler.runAfter(0, internal.backfill.chunk, {});
    return progress;
  },
});

export const stop = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("kv").withIndex("by_key", (q) => q.eq("key", "backfill")).unique();
    if (!row) return "no backfill in progress";
    const p = JSON.parse(row.value) as Progress;
    p.stopped = true;
    p.note = "stopped by operator";
    await ctx.db.patch(row._id, { value: JSON.stringify(p) });
    return `stopping after the current chunk; ${p.threads} threads done`;
  },
});

export const chunk = internalAction({
  args: {},
  handler: async (ctx) => {
    const raw = await ctx.runQuery(internal.store.kvGet, { key: "backfill" });
    if (!raw) return "no backfill state";
    const p = JSON.parse(raw) as Progress;
    if (p.stopped) return `stopped: ${p.note ?? ""}`;
    const runId = await ctx.runMutation(internal.store.openRun, {
      kind: "backfill",
      note: `chunk ${p.chunks + 1}, cursor ${new Date(p.cursor * 1000).toISOString()}`,
    });
    const totals = { threadsSeen: 0, threadsScanned: 0, commentsScanned: 0, candidates: 0, lookups: 0, mentionsNew: 0, booksNew: 0 };
    const errors: string[] = [];
    const budget: Budget = { lookupsLeft: LOOKUPS_PER_CHUNK };
    let done = false;
    let listed = 0;
    try {
      const posts = await fetchArchivePosts({ after: p.cursor, before: p.to, limit: THREADS_PER_CHUNK, sort: "asc" });
      listed = posts.length;
      totals.threadsSeen = posts.length;
      if (!posts.length) done = true;
      for (const post of posts) {
        if (budget.lookupsLeft <= 0) { errors.push("lookup budget spent; resuming from this post next chunk"); break; }
        try {
          const comments = await fetchArchiveComments(post.id);
          const s = await processThread(ctx, post, comments, "archive", budget);
          totals.threadsScanned++;
          totals.commentsScanned += s.commentsScanned;
          totals.candidates += s.candidates;
          totals.lookups += s.lookups;
          totals.mentionsNew += s.mentionsNew;
          totals.booksNew += s.booksNew;
        } catch (e) {
          errors.push(`${post.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Advance past this post either way; a same-second neighbour is
        // refetched next chunk and deduplicated by upsertThread.
        p.cursor = Math.floor(post.createdAt / 1000);
      }
      if (posts.length && posts.length < THREADS_PER_CHUNK && errors.length === 0) done = true;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    const progressed = totals.threadsScanned > 0 || (listed === 0 && errors.length === 0);
    p.failures = progressed ? 0 : p.failures + 1;
    p.threads += totals.threadsScanned;
    p.mentions += totals.mentionsNew;
    p.books += totals.booksNew;
    p.chunks++;
    if (p.failures >= MAX_CONSECUTIVE_FAILURES) {
      // A listing that keeps failing is a request we wrote wrong or an
      // archive outage; rescheduling forever would only log the same line.
      p.stopped = true;
      p.note = `halted after ${p.failures} chunks without progress: ${errors[0] ?? "unknown error"}`;
    }
    if (done) { p.stopped = true; p.note = "complete"; }
    await ctx.runMutation(internal.store.kvSet, { key: "backfill", value: JSON.stringify(p) });
    await ctx.runMutation(internal.store.closeRun, {
      runId,
      status: errors.length ? (p.stopped && !done ? "failed" : "partial") : "ok",
      ...totals,
      errors: errors.slice(0, 10),
      note: done
        ? `backfill complete: ${p.threads} threads, ${p.mentions} mentions, ${p.books} books over ${p.chunks} chunks`
        : p.stopped ? p.note : `chunk ${p.chunks} done, ${p.threads} threads so far`,
    });
    if (!p.stopped) await ctx.scheduler.runAfter(2000, internal.backfill.chunk, {});
    return { done, stopped: p.stopped, ...totals, cursor: p.cursor };
  },
});
