// ── Events and data flow ─────────────────────────────────────
// Every listener is wired here (no inline handlers). Loading functions live
// here too because each one ends in a render.

import { state, writeHash, readHash, SORTS } from './state.js';
import { listBooks, searchBooks, getBook, getCategories, getStats } from './api.js';
import { renderGrid, renderPills, renderSort, renderStats, renderDetail } from './render.js';
import { $, debounce, showToast } from './utils.js';

const PAGE = 24;

export async function loadMeta(s) {
  try {
    const [stats, categories] = await Promise.all([getStats(), getCategories()]);
    s.stats = stats;
    s.categories = categories;
  } catch (e) {
    s.error = e.message;
  }
  renderStats(s);
  renderPills(s);
}

/** (Re)load the first page for the current sort / category / query. */
export async function loadBooks(s) {
  const seq = ++s.requestSeq;
  s.loading = true;
  s.error = null;
  s.items = [];
  s.cursor = null;
  renderGrid(s);
  try {
    if (s.query) {
      const items = await searchBooks(s.query);
      if (seq !== s.requestSeq) return;
      s.items = items;
    } else {
      const page = await listBooks({ sort: s.sort, category: s.category, limit: PAGE });
      if (seq !== s.requestSeq) return;
      s.items = page.items;
      s.cursor = page.cursor;
    }
  } catch (e) {
    if (seq !== s.requestSeq) return;
    s.error = e.message;
  }
  s.loading = false;
  renderGrid(s);
}

async function loadMore(s) {
  if (!s.cursor || s.loading) return;
  const seq = s.requestSeq;
  s.loading = true;
  renderGrid(s, { append: true });
  try {
    const page = await listBooks({ sort: s.sort, category: s.category, cursor: s.cursor, limit: PAGE });
    if (seq !== s.requestSeq) return;
    s.items = s.items.concat(page.items);
    s.cursor = page.cursor;
  } catch (e) {
    showToast(e.message);
  }
  s.loading = false;
  renderGrid(s, { append: true });
}

export async function openBook(s, id) {
  s.openBookId = id;
  s.detail = null;
  writeHash(s);
  renderDetail(s);
  showModal('bookModal');
  try {
    const d = await getBook(id);
    if (s.openBookId !== id) return;
    if (!d) throw new Error('That book is no longer listed.');
    s.detail = d;
  } catch (e) {
    showToast(e.message);
    closeModal('bookModal');
    s.openBookId = null;
    writeHash(s);
    return;
  }
  renderDetail(s);
}

let lastFocus = null;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
function showModal(id) {
  const m = $(id);
  if (!m.hidden) return;
  lastFocus = document.activeElement;
  m.hidden = false;
  document.body.classList.add('modal-open');
  const dialog = m.querySelector('.modal__dialog');
  setTimeout(() => dialog.focus(), 0);
}

/** Keep Tab inside the open dialog (WCAG 2.4.3); the dialog itself is the first stop. */
function trapTab(e) {
  const open = document.querySelector('.modal:not([hidden]) .modal__dialog');
  if (!open || e.key !== 'Tab') return;
  const items = [...open.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!items.length) { e.preventDefault(); open.focus(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === open)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  else if (!open.contains(active)) { e.preventDefault(); first.focus(); }
}

function closeModal(id) {
  const m = $(id);
  if (m.hidden) return;
  m.hidden = true;
  if (!document.querySelector('.modal:not([hidden])')) document.body.classList.remove('modal-open');
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

function setSort(s, sort) {
  if (!SORTS.includes(sort) || sort === s.sort) return;
  s.sort = sort;
  renderSort(s);
  writeHash(s);
  loadBooks(s);
}

function setCategory(s, cat) {
  if (cat === s.category) return;
  s.category = cat;
  renderPills(s);
  writeHash(s);
  loadBooks(s);
}

function setQuery(s, q) {
  const next = q.trim().slice(0, 80);
  if (next === s.query) return;
  s.query = next;
  $('searchClear').hidden = !next;
  writeHash(s);
  loadBooks(s);
}

export function bindEvents(s) {
  $('sortSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (b) setSort(s, b.dataset.sort);
  });
  $('sortSeg').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = SORTS.indexOf(s.sort);
    const next = SORTS[(i + (e.key === 'ArrowRight' ? 1 : SORTS.length - 1)) % SORTS.length];
    setSort(s, next);
    $('sortSeg').querySelector(`[data-sort="${next}"]`).focus();
    e.preventDefault();
  });

  $('pills').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (b) setCategory(s, b.dataset.cat);
  });

  const input = $('searchInput');
  input.value = s.query;
  $('searchClear').hidden = !s.query;
  input.addEventListener('input', debounce(() => setQuery(s, input.value), 250));
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); setQuery(s, input.value); });
  $('searchClear').addEventListener('click', () => { input.value = ''; setQuery(s, ''); input.focus(); });

  $('more').addEventListener('click', (e) => {
    if (e.target.closest('#loadMore')) loadMore(s);
  });

  $('grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) openBook(s, b.dataset.open);
  });
  // A missing cover: Open Library answers 404 (default=false), the img fires
  // error (which does not bubble, hence capture), and the monogram shows.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.closest('.cover')) img.closest('.cover').classList.add('is-placeholder');
  }, true);

  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target.closest('[data-modal-close]')) {
        closeModal(m.id);
        if (m.id === 'bookModal') { s.openBookId = null; s.detail = null; writeHash(s); }
      }
    });
  });
  document.addEventListener('keydown', trapTab);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.modal:not([hidden])');
    if (!open) return;
    closeModal(open.id);
    if (open.id === 'bookModal') { s.openBookId = null; s.detail = null; writeHash(s); }
  });
  $('aboutBtn').addEventListener('click', () => showModal('aboutModal'));

  window.addEventListener('hashchange', () => {
    const before = { sort: s.sort, category: s.category, query: s.query, book: s.openBookId };
    readHash(s);
    if (s.sort !== before.sort) renderSort(s);
    if (s.category !== before.category) renderPills(s);
    if (s.query !== before.query) { input.value = s.query; $('searchClear').hidden = !s.query; }
    if (s.sort !== before.sort || s.category !== before.category || s.query !== before.query) loadBooks(s);
    if (s.openBookId && s.openBookId !== before.book) openBook(s, s.openBookId);
    if (!s.openBookId && before.book) closeModal('bookModal');
  });
}
