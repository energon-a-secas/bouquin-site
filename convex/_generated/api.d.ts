/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as archive from "../archive.js";
import type * as backfill from "../backfill.js";
import type * as books from "../books.js";
import type * as crons from "../crons.js";
import type * as extract from "../extract.js";
import type * as ingest from "../ingest.js";
import type * as openlibrary from "../openlibrary.js";
import type * as pipeline from "../pipeline.js";
import type * as reddit from "../reddit.js";
import type * as resolve from "../resolve.js";
import type * as store from "../store.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  archive: typeof archive;
  backfill: typeof backfill;
  books: typeof books;
  crons: typeof crons;
  extract: typeof extract;
  ingest: typeof ingest;
  openlibrary: typeof openlibrary;
  pipeline: typeof pipeline;
  reddit: typeof reddit;
  resolve: typeof resolve;
  store: typeof store;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
