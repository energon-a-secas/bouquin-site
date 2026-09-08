// ── State ─────────────────────────────────────────────────────
// One shared object. The browse position (sort, category, query, open book)
// also lives in the URL hash so a view can be shared; nothing is written to
// localStorage: there is no per-visitor data here.

export const SORTS = ['newest', 'trending', 'most'];

export const state = {
  sort: 'newest',
  category: 'all',
  query: '',
  items: [],
  cursor: null,
  loading: false,
  error: null,
  categories: [],
  stats: null,
  openBookId: null,
  detail: null,
  requestSeq: 0,
};

/** Read sort / category / query / book out of the hash. */
export function readHash(s) {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const sort = params.get('sort');
  s.sort = sort && SORTS.includes(sort) ? sort : 'newest';
  const cat = params.get('cat');
  s.category = cat && /^[a-z]+$/.test(cat) ? cat : 'all';
  const q = params.get('q');
  s.query = q ? q.slice(0, 80) : '';
  const book = params.get('book');
  s.openBookId = book && /^[a-z0-9]+$/.test(book) ? book : null;
}

/** Write the browse position back into the hash without a history entry. */
export function writeHash(s) {
  const params = new URLSearchParams();
  if (s.sort !== 'newest') params.set('sort', s.sort);
  if (s.category !== 'all') params.set('cat', s.category);
  if (s.query) params.set('q', s.query);
  if (s.openBookId) params.set('book', s.openBookId);
  const next = params.toString();
  const url = next ? `#${next}` : location.pathname + location.search;
  if ((location.hash.replace(/^#/, '') || '') !== next) history.replaceState(null, '', url);
}
