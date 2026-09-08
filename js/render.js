// ── Rendering ─────────────────────────────────────────────────
// Pure DOM output from state. No fetching, no listeners (events.js owns those).

import { $, escHtml, relTime, coverUrl, plural, monogram, isoOrEmpty, redditUrl, openLibraryUrl } from './utils.js';

const CATEGORY_LABELS = {
  fantasy: 'Fantasy', scifi: 'Sci-fi', mystery: 'Mystery & thriller', horror: 'Horror', romance: 'Romance',
  historical: 'Historical', literary: 'Literary fiction', classics: 'Classics', ya: 'Young adult',
  nonfiction: 'Nonfiction', humor: 'Humor', graphic: 'Comics & graphic', poetry: 'Poetry', short: 'Short stories',
};

export function categoryLabel(id) {
  return CATEGORY_LABELS[id] || id;
}

export function renderStats(s) {
  const el = $('stats');
  const st = s.stats;
  if (!st) { el.textContent = ''; return; }
  if (!st.books) {
    el.innerHTML = '<span>No books yet.</span> <span class="muted">The first scan runs within 30 minutes of deployment.</span>';
    return;
  }
  const via = st.lastScan && st.lastScan.source ? (st.lastScan.source === 'reddit' ? ' via Reddit' : ' via the archive') : '';
  const updated = st.lastIngestAt ? `updated ${relTime(st.lastIngestAt)}${via}` : 'first scan pending';
  const backfill = st.backfill && st.backfill.running ? ` · <span class="live-dot" aria-hidden="true"></span>backfilling history, ${st.backfill.threads.toLocaleString()} threads so far` : '';
  el.innerHTML = `<strong>${plural(st.books, 'book')}</strong> from ${plural(st.mentions, 'mention')} across ${plural(st.threads, 'thread')} · ${escHtml(updated)}${backfill}`;
}

export function renderSort(s) {
  document.querySelectorAll('#sortSeg [data-sort]').forEach((b) => {
    const on = b.dataset.sort === s.sort;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
}

export function renderPills(s) {
  const el = $('pills');
  const total = s.stats ? s.stats.books : 0;
  const pills = [{ id: 'all', label: 'All', count: total }, ...s.categories];
  el.innerHTML = pills.map((c) => `
    <button type="button" class="pill${c.id === s.category ? ' is-active' : ''}" data-cat="${escHtml(c.id)}" aria-pressed="${c.id === s.category}">
      ${escHtml(c.label)}${c.count ? ` <span class="pill__n">${c.count.toLocaleString()}</span>` : ''}
    </button>`).join('');
}

function coverMarkup(b, size, cls) {
  const url = coverUrl(b.coverId, size);
  const ph = `<span class="cover__ph" aria-hidden="true"><span class="cover__mono">${escHtml(monogram(b.title))}</span><span class="cover__title">${escHtml(b.title)}</span></span>`;
  if (!url) return `<span class="${cls} is-placeholder">${ph}</span>`;
  return `<span class="${cls}"><img src="${url}" alt="" loading="lazy" decoding="async" width="180" height="270">${ph}</span>`;
}

export function renderCard(b) {
  const cats = b.categories.slice(0, 2).map((c) => `<span class="chip">${escHtml(categoryLabel(c))}</span>`).join('');
  const iso = isoOrEmpty(b.lastSeenAt);
  const seen = iso ? `<time datetime="${iso}">${relTime(b.lastSeenAt)}</time>` : '';
  const trend = b.trend7 >= 3 ? `<span class="book__trend" title="${b.trend7} mentions this week">▲ ${b.trend7} this week</span>` : '';
  return `
  <article class="book" data-id="${escHtml(b.id)}">
    <button type="button" class="book__open" data-open="${escHtml(b.id)}" aria-label="Open ${escHtml(b.title)}">
      ${coverMarkup(b, 'M', 'cover')}
      <span class="book__count" title="Named in ${plural(b.mentionCount, 'comment')} across ${plural(b.threadCount, 'thread')}">×${b.mentionCount}</span>
    </button>
    <div class="book__meta">
      <h3 class="book__title"><button type="button" class="book__titlebtn" data-open="${escHtml(b.id)}">${escHtml(b.title)}</button></h3>
      <p class="book__author">${escHtml(b.authors.join(', ')) || '<span class="muted">Unknown author</span>'}</p>
      <p class="book__foot">${cats}${seen}</p>
      ${trend}
    </div>
  </article>`;
}

export function renderGrid(s, { append = false } = {}) {
  const grid = $('grid');
  grid.setAttribute('aria-busy', s.loading ? 'true' : 'false');
  if (s.loading && !append && !s.items.length) {
    grid.innerHTML = Array.from({ length: 12 }, () => '<div class="book book--skeleton" aria-hidden="true"><span class="cover skeleton"></span><span class="skeleton line"></span><span class="skeleton line line--short"></span></div>').join('');
    renderMore(s);
    return;
  }
  if (!s.loading && !s.items.length) {
    grid.innerHTML = `<div class="empty">${emptyCopy(s)}</div>`;
    renderMore(s);
    return;
  }
  if (append) {
    const start = grid.querySelectorAll('.book').length;
    grid.insertAdjacentHTML('beforeend', s.items.slice(start).map(renderCard).join(''));
  } else {
    grid.innerHTML = s.items.map(renderCard).join('');
  }
  renderMore(s);
}

function emptyCopy(s) {
  if (s.error) return `<strong>Could not load books.</strong><br><span class="muted">${escHtml(s.error)}</span>`;
  if (s.query) return `<strong>No titles match “${escHtml(s.query)}”.</strong><br><span class="muted">Search matches book titles; try a shorter word, or clear the search.</span>`;
  if (s.category !== 'all') return `<strong>Nothing in ${escHtml(categoryLabel(s.category))} yet.</strong><br><span class="muted">Categories come from Open Library subjects and fill in as threads are read.</span>`;
  return `<strong>Nothing yet.</strong><br><span class="muted">Bouquin reads r/suggestmeabook every 30 minutes. The first books appear after the first scan.</span>`;
}

export function renderMore(s) {
  const el = $('more');
  if (s.query) { el.innerHTML = ''; return; }
  if (s.cursor) {
    el.innerHTML = `<button type="button" class="btn btn--secondary" id="loadMore"${s.loading ? ' disabled' : ''}>${s.loading ? 'Loading…' : 'Show more'}</button>`;
  } else if (s.items.length) {
    el.innerHTML = `<p class="muted end">That is every book${s.category !== 'all' ? ` in ${escHtml(categoryLabel(s.category))}` : ''}.</p>`;
  } else {
    el.innerHTML = '';
  }
}

const KIND_LABEL = { suggestion: 'suggested', counter: 'instead', second: 'seconded' };

export function renderDetail(s) {
  const body = $('bookDetail');
  const d = s.detail;
  if (!d) {
    body.innerHTML = '<div class="detail detail--loading"><span class="skeleton cover"></span><div><span class="skeleton line"></span><span class="skeleton line line--short"></span></div></div>';
    $('bookModalTitle').textContent = 'Loading…';
    return;
  }
  $('bookModalTitle').textContent = d.title;
  const year = d.firstYear ? `<span>${d.firstYear}</span>` : '';
  const rating = d.rating ? `<span title="Open Library average rating">★ ${d.rating.toFixed(1)}</span>` : '';
  const cats = d.categories.map((c) => `<span class="chip">${escHtml(categoryLabel(c))}</span>`).join('');
  const first = d.firstSeenAt ? relTime(d.firstSeenAt) : '';
  const counter = d.counterCount ? ` · ${plural(d.counterCount, 'counter-suggestion')}` : '';
  const mentions = d.mentions.map((m) => {
    const threadHref = m.thread ? redditUrl(m.thread.permalink) : '';
    const thread = m.thread
      ? `${threadHref ? `<a class="mention__thread" href="${escHtml(threadHref)}" target="_blank" rel="noopener noreferrer">` : '<span class="mention__thread">'}${escHtml(m.thread.title)}${threadHref ? '</a>' : '</span>'}${m.thread.flair ? ` <span class="mention__flair">${escHtml(m.thread.flair)}</span>` : ''}`
      : '<span class="mention__thread muted">thread unavailable</span>';
    const commentHref = redditUrl(m.permalink);
    const kind = m.kind === 'counter' && m.insteadOf
      ? `<span class="kind kind--counter">instead of ${escHtml(m.insteadOf)}</span>`
      : `<span class="kind kind--${m.kind}">${KIND_LABEL[m.kind] || m.kind}</span>`;
    return `
    <li class="mention">
      <div class="mention__head">${thread}</div>
      <blockquote class="mention__quote">${escHtml(m.snippet)}</blockquote>
      <p class="mention__meta">${kind}${m.author ? ` · u/${escHtml(m.author)}` : ''} · ↑${m.score} · ${relTime(m.createdAt)}${commentHref ? ` · <a href="${escHtml(commentHref)}" target="_blank" rel="noopener noreferrer">comment ↗</a>` : ''}</p>
    </li>`;
  }).join('');
  body.innerHTML = `
  <div class="detail">
    ${coverMarkup(d, 'L', 'cover cover--lg')}
    <div class="detail__body">
      <p class="detail__authors">${escHtml(d.authors.join(', ')) || '<span class="muted">Unknown author</span>'}</p>
      <p class="detail__facts">${[year, rating].filter(Boolean).join(' · ')}</p>
      <p class="detail__cats">${cats}</p>
      <p class="detail__counts">Named in <strong>${plural(d.mentionCount, 'comment')}</strong> across ${plural(d.threadCount, 'thread')}${counter}${first ? ` · first seen ${first}` : ''}${d.trend7 ? ` · ${d.trend7} this week` : ''}</p>
      <p class="detail__links">${openLibraryUrl(d.olKey) ? `<a class="btn btn--ghost btn--sm" href="${escHtml(openLibraryUrl(d.olKey))}" target="_blank" rel="noopener noreferrer">Open Library ↗</a> ` : ''}<a class="btn btn--ghost btn--sm" href="https://www.reddit.com/r/suggestmeabook/search/?q=${encodeURIComponent('"' + d.title + '"')}&restrict_sr=1" target="_blank" rel="noopener noreferrer">Search the sub ↗</a></p>
    </div>
  </div>
  <h3 class="detail__h">Where it was named</h3>
  <ol class="mentions">${mentions || '<li class="muted">No mentions recorded.</li>'}</ol>`;
}
