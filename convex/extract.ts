// Book-mention extraction from Reddit comment markdown.
//
// Pure functions, no Convex imports, so the same file runs under plain Node
// for the sample-corpus harness. The extractor is deliberately a recall-first
// pass: every candidate it emits still has to survive Open Library resolution
// (resolve.ts) before it becomes a book, so a false positive here costs one
// cached lookup, not a wrong card.
//
// Measured on 481 live r/suggestmeabook comments (2026-09-08): "Title by
// Author" appears in 36% of bodies, a bare short line in 24%, markdown
// emphasis in 6%, the old {{goodreads bot}} braces in under 1%. The sub no
// longer runs that bot, so braces are handled but not relied on.

export type Confidence = "high" | "medium" | "low";
export type Source = "by" | "brace" | "emphasis" | "link" | "bare";

export interface Candidate {
  title: string;
  author?: string;
  series: boolean;
  confidence: Confidence;
  source: Source;
  raw: string;
}

const CONNECTORS = new Set([
  "of", "the", "a", "an", "and", "in", "on", "at", "to", "for", "from", "with",
  "&", "or", "by", "is", "vs", "de", "la", "le", "du", "del", "von", "van", "y",
  "el", "los", "las", "das", "der", "die", "et", "i", "ii", "iii", "iv", "v",
]);

const AUTHOR_PARTICLES = new Set([
  "de", "van", "von", "le", "la", "du", "der", "da", "di", "y", "del", "den", "ter", "af", "bin", "ibn", "mc", "st.",
]);

// "stand by me", "by the way", "by far", "by then": a capitalised token after
// "by" that is not a person. Lowercased for comparison.
const NOT_AUTHORS = new Set([
  "me", "you", "him", "her", "them", "us", "it", "the", "then", "now", "far",
  "far.", "way", "myself", "yourself", "itself", "themselves", "default", "hand",
  "heart", "chance", "accident", "design", "night", "day", "morning", "any",
  "all", "no", "that", "this", "these", "those", "which", "what", "who", "whom",
  "reading", "read", "looking", "going", "being", "having", "one", "two", "one.",
  "op", "the", "next", "last", "today", "tomorrow", "yesterday", "same",
  "author", "authors", "someone", "anyone", "everyone", "nobody", "amazon",
  "google", "reddit", "goodreads", "storygraph", "chatgpt",
]);

const SERIES_WORDS = /\s+(series|trilogy|saga|quartet|quintet|duology|sequence|cycle|books?|novels?|chronicles)\s*$/i;

const GENERIC_TITLES = new Set([
  "this", "that", "same", "yes", "no", "anything", "everything", "nothing",
  "thanks", "thank you", "agreed", "agree", "seconded", "second this", "op",
  "edit", "update", "spoiler", "lol", "haha", "the bible", "bible", "reddit",
  "goodreads", "amazon", "kindle", "audible", "libby", "google", "wikipedia",
  "any", "all", "none", "both", "either", "neither", "ok", "okay", "sure",
  "same here", "me too", "this one", "that one", "the author", "the book",
  "the series", "the sequel", "the first one", "the second one",
]);

const BOOK_LINK_HOSTS = /goodreads\.com|amazon\.|storygraph\.com|openlibrary\.org|bookshop\.org|wikipedia\.org|audible\.|barnesandnoble\.com|kobo\.com|librarything\.com/i;

function isCapitalised(token: string): boolean {
  const first = token.replace(/^[("'“‘*_[]+/, "").charAt(0);
  return /[A-ZÀ-ÝÆØÞ0-9]/.test(first);
}

function cleanTitle(raw: string): { title: string; series: boolean } | null {
  let t = raw
    .replace(/[*_~`]+/g, "")
    .replace(/^[\s"'“‘(\[{:,.;-]+|[\s"'”’)\]}:,.;!?-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // A trailing "(2019)" or "(Book 1)" is edition noise, not title.
  t = t.replace(/\s*\((?:\d{4}|book \d+|#\d+|vol\.? ?\d+)\)\s*$/i, "").trim();
  // "The Martian's" -> possessive of a title in running prose, drop the 's.
  t = t.replace(/['’]s$/, "").trim();
  let series = false;
  if (SERIES_WORDS.test(t)) {
    series = true;
    t = t.replace(SERIES_WORDS, "").trim();
  }
  if (!t) return null;
  const words = t.split(" ");
  if (words.length > 12) return null;
  if (t.length < 2 || t.length > 90) return null;
  if (GENERIC_TITLES.has(t.toLowerCase())) return null;
  // A single lowercase common word is not a title ("anything by Backman").
  if (words.length === 1 && !isCapitalised(t) && t.length < 6) return null;
  return { title: t, series };
}

function cleanAuthor(raw: string): string | null {
  const tokens: string[] = [];
  for (const tok of raw.replace(/[*_~`]+/g, "").trim().split(/\s+/)) {
    if (!tok) continue;
    const low = tok.toLowerCase();
    // "BK Borison. It’s": a token ending in a full stop closes the name,
    // unless it is an initial (J.K.) or a suffix (Jr.).
    const isInitial = /^\p{L}\.(?:\p{L}\.)*$/u.test(tok);
    const isSuffix = /^(jr|sr|phd|md)\.?$/i.test(tok);
    const stripped = tok.replace(/[,;:!?)\]]+$/g, "");
    if (/['’]s$/i.test(stripped) && !/^[oOdD]['’]/.test(stripped)) break; // It’s, He’s (but O'Brien passes)
    if (AUTHOR_PARTICLES.has(low) || isInitial || isSuffix || isCapitalised(stripped)) {
      tokens.push(isInitial || isSuffix ? stripped : stripped.replace(/\.$/, ""));
      if (/[.,;:!?)\]]$/.test(tok) && !isInitial) break;
      continue;
    }
    break;
  }
  if (!tokens.length || tokens.length > 4) return null;
  if (NOT_AUTHORS.has(tokens[0].toLowerCase().replace(/\.$/, ""))) return null;
  // A lone particle or initial is not an author.
  if (tokens.length === 1 && (AUTHOR_PARTICLES.has(tokens[0].toLowerCase()) || tokens[0].length < 3)) return null;
  return tokens.join(" ");
}

// Walk backwards from " by " to find where the title starts: keep tokens while
// they look like title words, stop at sentence punctuation or a lowercase
// non-connector word ("I loved The Martian by" -> "The Martian").
const ABBREV = /\b(Mrs|Mr|Ms|Dr|St|Jr|Sr|Prof|Mt|vs|No)\./g;

function titleBefore(text: string): { title: string; weak: boolean } | null {
  const protectedText = text.replace(ABBREV, "$1․"); // one-dot leader, restored below
  const segment = (protectedText.split(/[.;!?\n]|(?<=\s)[-–—](?=\s)/).pop() ?? "").replace(/․/g, ".");
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    const bare = tok.replace(/^[("'“‘*_[]+|[)"'”’*_\]:,]+$/g, "");
    const low = bare.toLowerCase();
    const opensEmphasis = /^[*_"“‘'(]/.test(tok);
    const seriesWord = /^(series|trilogy|saga|quartet|quintet|duology|sequence|cycle|books?|novels?|chronicles)$/i.test(low);
    const hyphenName = /^[\p{L}]+-\p{Lu}[\p{L}]*$/u.test(bare); // al-Sirafi
    if (isCapitalised(bare) || CONNECTORS.has(low) || seriesWord || hyphenName || /^\d+$/.test(bare) || /^[\p{L}]+['’][\p{L}]+$/u.test(bare)) {
      kept.unshift(bare);
      if (opensEmphasis && kept.length > 0) break; // an opening * or quote marks the start
      if (/[,:]$/.test(tok) && kept.length > 1) { kept.shift(); break; } // "…, Title by" is a boundary only if we already have words after it
      continue;
    }
    break;
  }
  // Leading connectors that are not articles are prose ("and The Martian").
  while (kept.length && CONNECTORS.has(kept[0].toLowerCase()) && !/^(the|a|an)$/i.test(kept[0])) kept.shift();
  if (kept.length && kept.some(isCapitalised)) return { title: kept.join(" "), weak: false };
  // Lowercase titles ("All the lonely people by Mike Gayle") are only trusted
  // when the whole line before "by" is the title: short, and at line start.
  const lineStart = segment.trim();
  const lineTokens = lineStart.split(/\s+/).filter(Boolean);
  if (lineTokens.length >= 1 && lineTokens.length <= 7 && /^[\p{Lu}]/u.test(lineStart) && segment.length === (text.split("\n").pop() ?? "").replace(ABBREV, "$1․").split(/[.;!?]|(?<=\s)[-–—](?=\s)/).pop()?.replace(/․/g, ".").length) {
    return { title: lineStart, weak: true };
  }
  return null;
}

function normaliseMarkdown(body: string): { text: string; links: { text: string; url: string }[] } {
  const links: { text: string; url: string }[] = [];
  let text = body.replace(/\\([*_~`\\[\]()#>{}])/g, "$1"); // unescape reddit's \* etc.
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x200B;/g, "");
  text = text.replace(/\[([^\]\n]{1,120})\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => {
    links.push({ text: t, url: u });
    return t;
  });
  text = text.replace(/https?:\/\/\S+/g, " ");
  text = text.replace(/^>.*$/gm, ""); // quoted text is someone else's words
  text = text.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, ""); // list bullets
  return { text, links };
}

export function extractCandidates(body: string | null | undefined): Candidate[] {
  if (!body) return [];
  const trimmed = body.trim();
  if (!trimmed || trimmed === "[removed]" || trimmed === "[deleted]") return [];
  const { text, links } = normaliseMarkdown(trimmed);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (c: Omit<Candidate, "series"> & { series?: boolean }) => {
    const cleaned = cleanTitle(c.title);
    if (!cleaned) return;
    const key = cleaned.title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...c, title: cleaned.title, series: cleaned.series || !!c.series });
  };

  // 1. {{Title by Author}} / {Title by Author}: the old bot syntax, still used by habit.
  for (const m of text.matchAll(/\{\{?([^{}\n]{3,120}?)\}?\}/g)) {
    const inner = m[1];
    const by = inner.match(/^(.+?)\s+by\s+(.+)$/i);
    if (by) {
      const author = cleanAuthor(by[2]);
      push({ title: by[1], author: author ?? undefined, confidence: "high", source: "brace", raw: m[0] });
    } else {
      push({ title: inner, confidence: "medium", source: "brace", raw: m[0] });
    }
  }

  // 2. "Title by Author": the dominant pattern.
  const NAME = "(?:\\p{Lu}[\\p{L}'’-]*\\.?|\\p{L}\\.(?:\\p{L}\\.)*|de|van|von|le|la|du|der|da|di|del)";
  const byRe = new RegExp(`\\bby\\s+(${NAME}(?:\\s+${NAME}){0,3})`, "gu");
  for (const m of text.matchAll(byRe)) {
    const author = cleanAuthor(m[1]);
    if (!author) continue;
    const before = text.slice(0, m.index);
    const found = titleBefore(before);
    if (!found) continue;
    push({ title: found.title, author, confidence: found.weak ? "medium" : "high", source: "by", raw: `${found.title} by ${author}` });
  }

  // 2b. "Title - Author" and "Title (Author)": the list-row shapes.
  const PERSON = "\\p{Lu}[\\p{L}'’.-]*(?:\\s+(?:\\p{Lu}[\\p{L}'’.-]*|\\p{L}\\.(?:\\p{L}\\.)*|de|van|von|le|la|du|der)){1,2}";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.length > 120 || /\bby\b/i.test(t)) continue;
    let m = t.match(new RegExp(`^(.{2,70}?)\\s+[-–—:]\\s+(${PERSON})\\s*[^\\p{L}\\d]*$`, "u"));
    if (!m) m = t.match(new RegExp(`^(.{2,70}?)\\s*\\((${PERSON})\\)\\s*[^\\p{L}\\d]*$`, "u"));
    if (!m) continue;
    const author = cleanAuthor(m[2]);
    if (!author || !lineLooksLikeTitle(m[1])) continue;
    push({ title: m[1], author, confidence: "high", source: "by", raw: t });
  }

  // 3. Markdown links to a book page: the link text is the title.
  for (const l of links) {
    if (!BOOK_LINK_HOSTS.test(l.url)) continue;
    if (/^(here|this|link|goodreads|amazon|source)$/i.test(l.text.trim())) continue;
    push({ title: l.text, confidence: "medium", source: "link", raw: l.text });
  }

  // 4. Emphasis: *Title*, **Title**, _Title_ with no author nearby.
  for (const m of text.matchAll(/(\*\*|\*|__|_)([^*_\n]{3,80}?)\1/g)) {
    const inner = m[2].trim();
    if (inner.split(/\s+/).length > 12) continue;
    if (!/[A-ZÀ-Ý]/.test(inner)) continue; // emphasis used for stress, not a title
    push({ title: inner, confidence: "medium", source: "emphasis", raw: m[0] });
  }

  // 5. Bare lines: a whole comment (or list line) that is just a title.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const wholeIsShort = lines.length === 1 && text.trim().length <= 70;
  for (const line of lines) {
    if (line.length > 70) continue;
    if (/[.!?]$/.test(line) && !/\b(jr|sr|dr|mr|mrs|ms|st)\.$/i.test(line)) continue;
    if (/\bby\b/i.test(line)) continue; // the by-pattern owns these
    if (/\b(i|i'm|i’m|my|you|your|he|she|we|they|it's|it’s|was|were|is|are|have|has|had|would|could|should|if|but|because|so|just|really|also|maybe|anything|something|everything)\b/i.test(line)) {
      // prose, unless it is one of the multi-line list rows that carry a
      // trailing aside after a dash: "The Sound of Gravel - one of the best…"
      const dash = line.split(/\s[-–—:]\s/)[0];
      if (dash === line) continue;
      if (dash.length < 4 || dash.length > 60) continue;
      if (!lineLooksLikeTitle(dash)) continue;
      push({ title: dash, confidence: "low", source: "bare", raw: line });
      continue;
    }
    if (!lineLooksLikeTitle(line)) continue;
    push({ title: line, confidence: wholeIsShort ? "low" : "low", source: "bare", raw: line });
  }

  return out;
}

function lineLooksLikeTitle(line: string): boolean {
  const cleaned = line.replace(/[*_~`"“”'‘’]+/g, "").replace(/[\p{Extended_Pictographic}️]/gu, "").trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length < 1 || tokens.length > 10) return false;
  const content = tokens.filter((t) => !CONNECTORS.has(t.toLowerCase()));
  if (!content.length) return false;
  const caps = content.filter(isCapitalised).length;
  if (caps / content.length < 0.6) return false;
  if (GENERIC_TITLES.has(cleaned.toLowerCase())) return false;
  // One capitalised word alone is too ambiguous ("Malazan" is fine, "Yes" is not),
  // require at least 5 letters for single tokens.
  if (tokens.length === 1 && cleaned.length < 5) return false;
  return true;
}

// Normalise a title for cache keys and fuzzy comparison.
export function normaliseTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function authorSurname(author: string): string {
  const parts = author.replace(/[.,]/g, " ").trim().split(/\s+/).filter((p) => !AUTHOR_PARTICLES.has(p.toLowerCase()));
  return (parts[parts.length - 1] ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

// Token-set similarity, 0..1. A candidate title that is a prefix of the
// resolved title ("Dune" vs "Dune Messiah") scores lower than an exact hit.
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normaliseTitle(a).split(" ").filter(Boolean));
  const tb = new Set(normaliseTitle(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = inter / union;
  const containment = inter / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment * 0.85);
}
