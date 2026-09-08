// The cron entry point. Two sources, one pipeline:
//
//   reddit   when REDDIT_CLIENT_ID / _SECRET / _USER_AGENT are set on the
//            deployment: the official Data API over app-only OAuth, live
//            scores and comment counts, 100 requests/minute.
//   archive  otherwise: the Arctic Shift archive (see archive.ts), about a
//            quarter of an hour behind Reddit, no credential needed.
//
// Reddit closed self-service API registration on 2025-11-11, so a fresh
// deployment normally starts on the archive and upgrades itself the moment
// the env vars land (scripts/setup-reddit.sh). The books:stats query reports
// which source the last run used.

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { credsFromEnv, fetchToken, fetchNewPosts, fetchThreadComments, MAX_THREADS_PER_SCAN, type RedditPost } from "./reddit";
import { fetchArchivePosts, fetchArchiveComments } from "./archive";
import { processThread, type Budget, type ThreadStats } from "./pipeline";

const LOOKUPS_PER_SCAN = 150;          // Open Library requests one run may make
const ARCHIVE_WINDOW_H = 72;           // how far back the archive listing looks
const ARCHIVE_THREADS_PER_SCAN = 30;

const ZERO = { threadsSeen: 0, threadsScanned: 0, commentsScanned: 0, candidates: 0, lookups: 0, mentionsNew: 0, booksNew: 0 };

export const scan = internalAction({
  args: { maxThreads: v.optional(v.number()), force: v.optional(v.union(v.literal("reddit"), v.literal("archive"))) },
  handler: async (ctx, { maxThreads, force }) => {
    const creds = credsFromEnv();
    const source: "reddit" | "archive" = force ?? (creds ? "reddit" : "archive");
    if (source === "reddit" && !creds) throw new Error("force=reddit but the Reddit env vars are not set");
    const runId = await ctx.runMutation(internal.store.openRun, { kind: "scan", note: `source ${source}` });
    const errors: string[] = [];
    const totals = { ...ZERO };
    try {
      let token: string | null = null;
      let posts: RedditPost[];
      if (source === "reddit" && creds) {
        // Reuse a token across runs; Reddit issues 24h app-only tokens.
        token = await ctx.runQuery(internal.store.kvGet, { key: "reddit_token" });
        if (!token) {
          const minted = await fetchToken(creds);
          token = minted.token;
          await ctx.runMutation(internal.store.kvSet, { key: "reddit_token", value: token, expiresAt: minted.expiresAt - 5 * 60 * 1000 });
        }
        posts = await fetchNewPosts(token, creds.userAgent, 100);
      } else {
        posts = await fetchArchivePosts({ after: Math.floor(Date.now() / 1000) - ARCHIVE_WINDOW_H * 3600, limit: 100, sort: "desc" });
      }
      totals.threadsSeen = posts.length;
      const byId = new Map(posts.map((p) => [p.id, p]));
      const wanted: string[] = await ctx.runQuery(internal.store.threadsNeedingScan, {
        source,
        posts: posts.map((p) => ({ redditId: p.id, numComments: p.numComments, createdAt: p.createdAt })),
        max: maxThreads ?? (source === "reddit" ? MAX_THREADS_PER_SCAN : ARCHIVE_THREADS_PER_SCAN),
      });
      const budget: Budget = { lookupsLeft: LOOKUPS_PER_SCAN };
      for (const redditId of wanted) {
        if (budget.lookupsLeft <= 0) { errors.push(`lookup budget spent before ${redditId}; it stays queued`); break; }
        try {
          let post = byId.get(redditId)!;
          let comments;
          if (source === "reddit" && creds && token) {
            ({ post, comments } = await fetchThreadComments(redditId, token, creds.userAgent));
          } else {
            comments = await fetchArchiveComments(redditId);
            // The archive's num_comments lags; what we fetched is the truth we have.
            post = { ...post, numComments: Math.max(post.numComments, comments.length) };
          }
          const s: ThreadStats = await processThread(ctx, post, comments, source, budget);
          totals.threadsScanned++;
          totals.commentsScanned += s.commentsScanned;
          totals.candidates += s.candidates;
          totals.lookups += s.lookups;
          totals.mentionsNew += s.mentionsNew;
          totals.booksNew += s.booksNew;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${redditId}: ${msg}`);
          if (/reddit 40[13]/.test(msg)) {
            // A dead token: drop it so the next run mints a fresh one.
            await ctx.runMutation(internal.store.kvSet, { key: "reddit_token", value: "", expiresAt: 0 });
            break;
          }
          if (/429/.test(msg)) break;
        }
      }
      await ctx.runMutation(internal.store.closeRun, {
        runId, status: errors.length ? "partial" : "ok", ...totals, errors: errors.slice(0, 10), note: `source ${source}`,
      });
      return { status: errors.length ? ("partial" as const) : ("ok" as const), source, ...totals, errors };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/token/.test(msg)) await ctx.runMutation(internal.store.kvSet, { key: "reddit_token", value: "", expiresAt: 0 });
      await ctx.runMutation(internal.store.closeRun, { runId, status: "failed", ...totals, errors: [msg, ...errors].slice(0, 10), note: `source ${source}` });
      return { status: "failed" as const, source, error: msg };
    }
  },
});

// Nightly trend decay, paged so a large table never exceeds one mutation.
export const decay = internalAction({
  args: {},
  handler: async (ctx) => {
    const runId = await ctx.runMutation(internal.store.openRun, { kind: "trend" });
    let cursor: string | null = null;
    let touched = 0;
    for (let i = 0; i < 200; i++) {
      const r: { done: boolean; cursor: string | null; touched: number } = await ctx.runMutation(internal.store.decayTrends, { cursor: cursor ?? undefined, batch: 50 });
      touched += r.touched;
      if (r.done) break;
      cursor = r.cursor;
    }
    await ctx.runMutation(internal.store.closeRun, {
      runId, status: "ok", ...ZERO, note: `trend7 recomputed on ${touched} book(s)`, errors: [],
    });
  },
});
