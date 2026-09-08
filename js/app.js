// ── Entry point ──────────────────────────────────────────────
// Reads the hash, loads the header stats and category pills, then the first
// page of books, and reopens a book if the URL names one.

import { state, readHash } from './state.js';
import { renderSort, renderPills, renderStats } from './render.js';
import { bindEvents, loadMeta, loadBooks, openBook } from './events.js';

async function init() {
  readHash(state);
  renderSort(state);
  renderStats(state);
  renderPills(state);
  bindEvents(state);
  await Promise.all([loadMeta(state), loadBooks(state)]);
  if (state.openBookId) openBook(state, state.openBookId);
}

init();
