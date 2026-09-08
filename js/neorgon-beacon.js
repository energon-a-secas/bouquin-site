/* ══════════════════════════════════════════════════════════════
   Neorgon Beacon Kit: beacon.js
   A dimmed bottom-left control that lets a visitor report a correction.
   Canonical source: packages/neorgon-ui/beacon/
   Vendored per site as js/neorgon-beacon.js. Do not edit copies.

   Classic script, not an ES module, loaded with `defer`. Half the fleet has
   no module setup at all, and the sweep that vendors this has to be a
   one-liner on every site including the single-file ones.

   No dependencies, no network request, and no form. The widget is a flag
   plus context capture: it opens Balise's own report page with
   {v, site, url, target} in the URL fragment and the visitor writes there,
   same-origin (CONTRACTS.md D1 and C1.3). It never emits the three fields a
   person types, which is why nothing anyone types can land in a URL, in
   browser history, or in an access log on either side.

   Namespace note (PLAN.md F1): the header kit loads Cloudflare Insights,
   also called a beacon (`beacon.min.js`, `data-cf-beacon`), in all 68
   vendored copies. Everything here is `neo-beacon-*` in CSS,
   `neorgon-beacon.*` on disk and `NeoBeacon` in JS. The attribute is
   `data-beacon-target`, never `data-beacon`.
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__neoBeaconInit) return;
  window.__neoBeaconInit = true;

  var VERSION = '1.0.0';
  var REPORT_URL = 'https://balise.neorgon.com/report/';

  /* CONTRACTS.md C1 lengths, restated as numbers rather than imported,
     because this file ships to sixty repos with no build step. A change here
     is a contract change and goes through delivery-lead. */
  var MAX_URL = 512;
  var MAX_KIND = 32;
  var MAX_ID = 128;
  var MAX_LABEL = 120;

  function meta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return el && el.content ? el.content.trim() : '';
  }

  var SITE = meta('beacon-site');

  /* ── Target resolution (C1.1), first hit wins ───────────────────────
     1. a resolveTarget the host site registered on window.NeoBeacon
     2. the nearest [data-beacon-target] ancestor, parsed as "kind:id"
     3. null, and the report is page level

     Step 3 is a requirement, not a fallback. A site that drops this kit in
     with no markup changes gets working page-level reports, which is what
     makes the fleet sweep a one-liner. ──────────────────────────────── */
  function trunc(value, max) {
    var s = value == null ? '' : String(value).trim();
    return s.length > max ? s.slice(0, max) : s;
  }

  function shape(t) {
    if (!t || !t.id) return null;
    /* Case is the one thing normalised here. C1 spells target.kind
       lowercase, and a site that writes "Concept:cool" means the same
       vocabulary word. Everything else is passed through as authored: the
       Worker owns validation (C1.2), and a widget that quietly repaired a
       malformed id would hide the site's bug instead of surfacing it. */
    return {
      kind: trunc(t.kind || 'item', MAX_KIND).toLowerCase(),
      id: trunc(t.id, MAX_ID),
      label: trunc(t.label || t.id, MAX_LABEL)
    };
  }

  function resolveTarget(node) {
    var hook = window.NeoBeacon && window.NeoBeacon.resolveTarget;
    if (typeof hook === 'function') {
      var hooked = null;
      try {
        hooked = hook(node);
      } catch (err) {
        /* A hook that throws is the site's bug, said out loud. Resolution
           then continues to step 2: the documented order, not a rescue. */
        if (window.console) console.error('[beacon] resolveTarget threw', err);
      }
      var shaped = shape(hooked);
      if (shaped) return shaped;
    }

    var host = node && node.closest ? node.closest('[data-beacon-target]') : null;
    if (host) {
      var raw = (host.getAttribute('data-beacon-target') || '').trim();
      if (raw) {
        /* A single flat "kind:id" string on purpose. JSON in an HTML
           attribute breaks on a quote in the label. */
        var cut = raw.indexOf(':');
        var fromAttr = shape({
          kind: cut > 0 ? raw.slice(0, cut) : 'item',
          id: cut > 0 ? raw.slice(cut + 1) : raw,
          label: host.getAttribute('data-beacon-label') || host.textContent || ''
        });
        if (fromAttr) return fromAttr;
      }
    }

    return null;
  }

  /* ── What the visitor was looking at ────────────────────────────────
     The beacon is a fixed control in a corner, so by the time it is
     activated it is itself the focused element. Track the last thing the
     person touched or focused outside the widget and resolve against that.
     Both events, because plenty of reportable things in this fleet are
     cards and table rows that never take focus. ────────────────────── */
  var lastContext = null;
  var link = null;

  function remember(e) {
    var t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest('.neo-beacon-link')) return;
    lastContext = t;
  }

  /* ── The hand-off URL ───────────────────────────────────────────────
     {v, site, url, target} and nothing else. C1.3: the visitor has typed
     nothing at this point, and the widget has no field for them to type
     into. Balise's page adds the rest, same-origin. ─────────────────── */
  function href() {
    return REPORT_URL + '#' + encodeURIComponent(JSON.stringify({
      v: 1,
      site: SITE,
      url: trunc(location.href, MAX_URL),
      target: resolveTarget(lastContext || document.body)
    }));
  }

  /* Recomputed at every activation path rather than on every interaction on
     the page: pointerdown precedes click, auxclick and contextmenu, and
     focus precedes Enter, so the href is current by the time anything can
     act on it and no cost lands on ordinary browsing. */
  function refresh() {
    if (link) link.href = href();
  }

  function open(context) {
    if (context) lastContext = context;
    var url = href();
    if (link) link.href = url;
    window.open(url, '_blank', 'noopener');
  }

  /* ── Activation ─────────────────────────────────────────────────────
     window.open runs synchronously here so the user gesture that permits
     opening a tab is still live (D1).

     The control is a real <a> carrying the same URL, and that is the answer
     to a blocked popup. window.open with 'noopener' returns null whether the
     tab opened or the browser refused it, so nothing here can branch on the
     outcome and any message claiming success would be a guess. What the
     widget can guarantee is that a refusal leaves something to act on: the
     browser shows its own blocked-popup indicator, and the link is still on
     screen, still addressed to the same report, still activatable by a
     second click, by the keyboard, or by "open in new tab".

     A modified or non-primary activation is not intercepted at all, so
     cmd-click, ctrl-click, shift-click and middle click reach the href
     through the browser's own path. ─────────────────────────────────── */
  function onClick(e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    /* Built before the default is suppressed: if this throws, the error
       reaches the console and the anchor's own navigation still carries the
       person to the report page with the URL it last held. */
    var url = href();
    link.href = url;
    e.preventDefault();
    window.open(url, '_blank', 'noopener');
  }

  /* ── The control ────────────────────────────────────────────────── */
  function buildLink() {
    var a = document.createElement('a');
    a.className = 'neo-beacon-link';
    a.id = 'neo-beacon-link';
    a.target = '_blank';
    /* noreferrer as well as noopener. It strips the Referer header, so the
       host page URL reaches Balise only inside the fragment, which no server
       is ever sent. Without it that same URL lands in an access log. */
    a.rel = 'noopener noreferrer';
    a.title = 'Report a correction';
    a.setAttribute('aria-label', 'Report a correction, opens Balise in a new tab');

    var ns = 'http://www.w3.org/2000/svg';
    var icon = document.createElementNS(ns, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.7');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('aria-hidden', 'true');

    var core = document.createElementNS(ns, 'circle');
    core.setAttribute('cx', '12');
    core.setAttribute('cy', '12');
    core.setAttribute('r', '2.6');
    core.setAttribute('fill', 'currentColor');
    core.setAttribute('stroke', 'none');
    icon.appendChild(core);

    ['M16.6 7.4a6.5 6.5 0 0 1 0 9.2', 'M7.4 16.6a6.5 6.5 0 0 1 0-9.2',
     'M19.4 4.6a10.5 10.5 0 0 1 0 14.8', 'M4.6 19.4a10.5 10.5 0 0 1 0-14.8'
    ].forEach(function (d) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      icon.appendChild(p);
    });

    a.appendChild(icon);

    /* No inline handlers anywhere in this kit. pointerenter is here so the
       browser's own status-bar preview names the real destination before the
       person commits to it, which is half the value of shipping a link. */
    a.addEventListener('pointerenter', refresh);
    a.addEventListener('pointerdown', refresh);
    a.addEventListener('focus', refresh);
    a.addEventListener('contextmenu', refresh);
    a.addEventListener('click', onClick);

    document.body.appendChild(a);
    return a;
  }

  /* ── Init ───────────────────────────────────────────────────────── */
  function init() {
    if (meta('beacon') === 'off') return;

    if (!SITE) {
      /* No site id means no valid report under C1, so nothing is drawn. Said
         out loud rather than guessed from the hostname: sync-beacon.sh writes
         this tag, and a missing one means the sweep did not finish here. */
      if (window.console) {
        console.warn('[beacon] no <meta name="beacon-site">, widget not shown. ' +
          'Run packages/neorgon-ui/sync-beacon.sh --to <this site>.');
      }
      return;
    }

    document.addEventListener('focusin', remember, true);
    document.addEventListener('pointerdown', remember, true);
    link = buildLink();
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  var api = window.NeoBeacon || {};
  api.version = VERSION;
  api.open = open;
  /* Left alone if the host already assigned one before this script ran. */
  if (typeof api.resolveTarget !== 'function') api.resolveTarget = null;
  window.NeoBeacon = api;
})();
