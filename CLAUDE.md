# CLAUDE.md: Bouquin

A mirror of the books people recommend on r/suggestmeabook: a Convex cron
reads new threads, extracts the titles named in comments, resolves them on
Open Library, and a static page shows them as a cover grid with repeat counts,
genres, and links back to the comments.

**Live:** bouquin.neorgon.com · **Port:** 8883

## Run

```bash
make serve                                   # http://localhost:8883, ES modules need HTTP
npm install && npx convex dev                # backend against the dev deployment
npx convex run ingest:scan '{"maxThreads": 5}'
npx convex run backfill:start '{"days": 7}'  # chunked; backfill:stop halts it
npx convex deploy                            # production
bash scripts/setup-reddit.sh                 # optional Reddit credentials (human steps)
```

## Architecture

| Module | Owns |
|---|---|
| `js/app.js` | Entry: hash, meta, first page, reopen a linked book |
| `js/state.js` | `state`, `readHash`, `writeHash`: sort, category, query, open book |
| `js/api.js` | `CONVEX_URL` and the public query wrappers |
| `js/events.js` | Every listener, plus `loadMeta`, `loadBooks`, `openBook` |
| `js/render.js` | Stats line, pills, cards, empty states, detail sheet |
| `js/utils.js` | `escHtml`, `relTime`, `coverUrl`, `monogram` |
| `convex/ingest.ts` | Cron entry `scan`: picks Reddit or the archive, rescans moved threads; `decay` nightly |
| `convex/backfill.ts` | `start` / `chunk` / `stop`: self-scheduling history seed |
| `convex/pipeline.ts` | `processThread`: extract, resolve through the lookups cache, record |
| `convex/extract.ts` | Pure candidate extraction from comment markdown |
| `convex/resolve.ts` | Pure Open Library match gates and the 14-category map |
| `convex/store.ts` | Internal mutations: the only writers of counts, shelves, counters |
| `convex/books.ts` | Public queries: `list`, `search`, `get`, `categories`, `stats` |
| `convex/reddit.ts`, `archive.ts`, `openlibrary.ts` | The three HTTP clients |

Vendored from `packages/neorgon-ui/`: never edit in place, run the sync script instead: `js/neorgon-header.js`, `js/neorgon-footer.js`, `js/neorgon-beacon.js`.

## Data

- Convex tables: `threads`, `books`, `mentions`, `shelves`, `lookups`, `counters`, `runs`, `kv` (see `convex/schema.ts`)
- Deployment env vars (optional): `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`. Set with `scripts/setup-reddit.sh`. The wizard keeps the id and the User-Agent in the gitignored `.env` as re-run defaults; the secret exists on the Convex deployment only.
- No localStorage. The browse position lives in the URL hash only.

## Conventions

- Zero build step. Plain ES modules loaded by `js/app.js`.
- Header and footer come from the shared kits. Do not add site-local `.neo-footer` or `.header-bar` CSS.
- `extract.ts` and `resolve.ts` import nothing from Convex so they run under plain Node (`node file.ts`) against a saved comment sample; keep them pure.
- Every aggregate a query reads is written in `store.ts`. Do not compute counts in `books.ts`.

## Gotchas

- **The cron does not need Reddit credentials, and usually will not have them.**
  Reddit closed self-service API registration on 2025-11-11. `ingest.scan` reads the
  Arctic Shift archive (about 16 minutes behind Reddit) unless the three `REDDIT_*`
  env vars exist, then switches to OAuth by itself. `books:stats` reports which source
  the last scan used. The credential procedure, with the 2026-09-30 registration
  deadline for pre-existing apps, is echeance's `reddit-data-api-app` tutorial.
- **Archive listings lie about `num_comments` and `score` for young posts** (0 or 1
  until the archive revisits them, roughly 36 hours later). So the archive rescan
  policy in `store.threadsNeedingScan` is by age, not by comment count, and
  `markScanned` raises `numComments` to what was actually fetched.
- **Arctic Shift returns 400 for an unknown `fields` name** (`permalink` is one), and
  the first backfill looped on that for 30 chunks without advancing. `backfill.chunk`
  now halts after three chunks without progress and writes the error into the run
  note; if `books:stats` shows `backfill.running: false` with few threads, read the
  last `runs` row.
- **Extraction is recall-first on purpose.** A candidate becomes a book only when
  Open Library agrees (title similarity gated by extraction confidence, surname match
  when an author was named, a minimum edition count for bare lines). Loosen the gates
  in `resolve.ts`, not the regexes, and re-run the calibration first: on the 2026-09-08
  sample 27 of 44 candidates resolved with no wrong book among them. The class that
  sample missed: a bare person's name ("Stephen King") resolves to the biography or
  critical study with that exact title, so `pickMatch` refuses a two-or-three-token
  capitalised candidate with no extracted author when the results agree it is a person.
- **Lookups cache misses too**, keyed on normalised `title|author`. A string that
  resolved to nothing is not retried; delete its `lookups` row to force a retry.
- **`trend7` is incremented at write time and only decays in the nightly `decay`
  action**, so a book's trend can read high for up to a day after its week ends.
- **Aggregates have a reconciliation path**: `npx convex run ingest:recompute --prod`
  rebuilds every book's counts, the shelves and the counters from the mentions table.
  Run it after any change to `store.recordMentions`; the first version double-counted
  `threadCount` when comments arrived out of time order (found in review, 2026-09-08).
- **A thread the lookup budget cut short is left unmarked on purpose** (`pipeline.ts`),
  so the next run returns to it. Marking it scanned was how books went missing silently
  in the first version.
- **Reddit token errors are classified by where they happen.** A 401 from the token
  endpoint is the id or secret; a 401/403 on a read drops the cached token in `kv`
  and the next run mints a new one; a 403 with a fresh token is almost always the
  User-Agent.
- **Cover URLs carry `?default=false`** so a missing cover is a 404, not a 1×1 blank
  image. The grid catches the `error` event in the capture phase and shows the
  monogram placeholder; do not remove the parameter.
- **`js/api.js` names the production deployment.** `npx convex dev` gives you a dev URL
  in `.env.local`; switch it by hand for local backend work and switch it back.

## Do not touch

- `js/neorgon-*.js` and `css/neorgon-*.css`: vendored kits, regenerated by `packages/neorgon-ui/sync-*.sh`.
- `convex/_generated/`: rebuilt by `npx convex dev`.
- Favicon set and `logo.svg`: generated from the hub card by `packages/neorgon-ui/sync-favicon.sh`.
