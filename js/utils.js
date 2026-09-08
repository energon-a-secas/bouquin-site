// ── Shared utilities ─────────────────────────────────────────
// Small, pure helper functions used across multiple modules.

/** Cached element lookup by ID. */
const _els = {};
export function $(id) {
  return _els[id] || (_els[id] = document.getElementById(id));
}

/** Escape HTML special characters. */
export function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Show a temporary toast notification. */
let _toastTimer = null;
export function showToast(msg) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 2000);
}

/** Simple debounce. */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** "3h ago", "2d ago", "Mar 4". Dates older than ~60 days show the date. */
export function relTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  const date = new Date(ms);
  const opts = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

/** Open Library cover URL. default=false turns a missing cover into a 404 the img can react to. */
export function coverUrl(coverId, size = 'M') {
  return coverId ? `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg?default=false` : null;
}

export function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Two-letter monogram for a cover placeholder: "The Bone People" -> "BP". */
export function monogram(title) {
  const words = String(title).replace(/^(the|a|an)\s+/i, '').split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => w[0]).join('');
  return (letters || String(title).slice(0, 2)).toUpperCase();
}
