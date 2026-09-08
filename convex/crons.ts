import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Reddit budget per scan: 1 token (cached 24h) + 1 listing + at most 25
// thread reads, against a 100 requests/minute allowance. Every 30 minutes
// keeps a new thread's first rescan within the window its comments arrive.
crons.interval("scan r/suggestmeabook", { minutes: 30 }, internal.ingest.scan, {});

// trend7 counts mentions in the trailing 7 days; writes increment it and
// this pass lets it decay.
crons.daily("decay trends", { hourUTC: 4, minuteUTC: 15 }, internal.ingest.decay, {});

export default crons;
