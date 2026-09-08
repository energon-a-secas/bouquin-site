// Resolution of an extracted candidate against Open Library search results,
// and the subject-to-category mapping. Pure functions: the fetch lives in the
// Convex action so this file runs under plain Node for the calibration harness.

import { authorSurname, titleSimilarity, type Candidate } from "./extract";

export interface OlDoc {
  key: string; // "/works/OL21745884W"
  title: string;
  author_name?: string[];
  cover_i?: number;
  first_publish_year?: number;
  subject?: string[];
  edition_count?: number;
  ratings_average?: number;
  ratings_count?: number;
}

export interface Match {
  doc: OlDoc;
  score: number;
  reason: string;
}

// Thresholds by extraction confidence. A "Title by Author" hit with a surname
// match is trusted at moderate title similarity (the author disambiguates);
// a bare line must match almost exactly and be a book with real editions.
const GATES = {
  high: { withAuthor: 0.55, withoutAuthor: 0.85, minEditions: 1 },
  medium: { withAuthor: 0.6, withoutAuthor: 0.8, minEditions: 2 },
  low: { withAuthor: 0.7, withoutAuthor: 0.9, minEditions: 2 },
} as const;

function squash(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
}

function surnameMatches(author: string | undefined, doc: OlDoc): boolean {
  if (!author) return false;
  const want = authorSurname(author);
  if (!want) return false;
  // "Leguin" vs "Le Guin", "OBrien" vs "O'Brien": compare with spacing and
  // punctuation removed, on the surname and on the whole name.
  const wantSq = squash(want);
  return (doc.author_name ?? []).some((n) => {
    const sur = squash(authorSurname(n));
    return sur === wantSq || squash(n).includes(wantSq) || squash(author).includes(sur);
  });
}

// "Nnedi Okorafor" or "John Myers Myers" extracted as a title: the candidate is
// a person, and Open Library will happily return a book whose title contains
// the name. Refuse when the candidate equals one of the result's authors.
function candidateIsAuthor(candidate: Candidate, doc: OlDoc): boolean {
  const sq = squash(candidate.title);
  return (doc.author_name ?? []).some((n) => squash(n) === sq);
}

// "Stephen King" or "Agatha Christie" as a whole comment names an author,
// not a book, and a title-scoped search returns the biography or the critical
// study with that exact title. Two or three capitalised tokens, no author
// extracted, and the results agree it is a person: refuse the whole candidate.
function looksLikePersonName(title: string): boolean {
  const tokens = title.trim().split(/\s+/);
  if (tokens.length < 2 || tokens.length > 3) return false;
  return tokens.every((t) => /^\p{Lu}[\p{L}'’.-]*$/u.test(t) && !/^(The|A|An|Of|And|In|On|To|For)$/.test(t));
}

function resultsSayPerson(title: string, docs: OlDoc[]): boolean {
  const sq = squash(title);
  let byThem = 0;
  let aboutThem = 0;
  for (const doc of docs) {
    if ((doc.author_name ?? []).some((n) => squash(n) === sq)) byThem++;
    const subj = (doc.subject ?? []).map((x) => x.toLowerCase());
    if (squash(doc.title) === sq && subj.some((x) => /biograph|criticism|interpretation|interviews/.test(x))) aboutThem++;
  }
  return byThem >= 1 || aboutThem >= 1;
}

export function pickMatch(candidate: Candidate, docs: OlDoc[]): Match | null {
  const gate = GATES[candidate.confidence];
  if (!candidate.author && looksLikePersonName(candidate.title) && resultsSayPerson(candidate.title, docs)) return null;
  let best: Match | null = null;
  for (const doc of docs) {
    if (!doc.title) continue;
    if (candidateIsAuthor(candidate, doc)) continue;
    const sim = titleSimilarity(candidate.title, doc.title);
    const authorOk = surnameMatches(candidate.author, doc);
    const editions = doc.edition_count ?? 0;
    let pass = false;
    let reason = "";
    if (candidate.author) {
      if (authorOk && sim >= gate.withAuthor) { pass = true; reason = `author+title ${sim.toFixed(2)}`; }
      else if (!authorOk && sim >= 0.95 && candidate.confidence !== "low") { pass = true; reason = `exact title, author differs ${sim.toFixed(2)}`; }
    } else if (sim >= gate.withoutAuthor) {
      pass = true; reason = `title ${sim.toFixed(2)}`;
    }
    if (!pass || editions < gate.minEditions) continue;
    // Prefer: author match, then similarity, then popularity.
    const score = (authorOk ? 1 : 0) * 10 + sim * 5 + Math.log10(1 + editions) + (doc.cover_i ? 0.5 : 0);
    if (!best || score > best.score) best = { doc, score, reason };
  }
  return best;
}

// Small fixed taxonomy: the site filters by these, so they must stay few and
// stable. Order matters only for ties. Subject strings from Open Library are
// noisy ("nyt:hardcover-fiction=2021-05-23"), so matching is substring-based
// on the lowercased subject.
export const CATEGORIES: { id: string; label: string; keys: string[] }[] = [
  { id: "fantasy", label: "Fantasy", keys: ["fantasy", "magic", "dragons", "wizards", "witches", "fairy tales", "romantasy"] },
  { id: "scifi", label: "Sci-fi", keys: ["science fiction", "sci-fi", "scifi", "space", "dystopia", "time travel", "aliens", "post-apocalyptic", "apocalyptic", "cyberpunk", "robots"] },
  { id: "mystery", label: "Mystery & thriller", keys: ["mystery", "detective", "thriller", "suspense", "crime", "murder", "espionage", "spy", "noir"] },
  { id: "horror", label: "Horror", keys: ["horror", "ghost", "haunted", "gothic", "vampires", "zombies", "occult"] },
  { id: "romance", label: "Romance", keys: ["romance", "love stories", "love story", "romantic"] },
  { id: "historical", label: "Historical", keys: ["historical fiction", "world war", "medieval", "victorian", "regency", "ancient", "civil war"] },
  { id: "literary", label: "Literary fiction", keys: ["literary fiction", "literary", "domestic fiction", "psychological fiction", "family life", "coming of age", "bildungsroman"] },
  { id: "classics", label: "Classics", keys: ["classic", "classics", "classic literature", "19th century", "18th century"] },
  { id: "ya", label: "Young adult", keys: ["young adult", "juvenile fiction", "teen", "teenage", "children's fiction", "juvenile literature"] },
  { id: "nonfiction", label: "Nonfiction", keys: ["nonfiction", "non-fiction", "biography", "memoir", "autobiography", "essays", "history", "science", "philosophy", "psychology", "self-help", "self help", "business", "economics", "politics", "true crime", "travel", "nature", "religion", "sociology", "mathematics", "physics", "medicine", "journalism", "personal growth", "conduct of life"] },
  { id: "humor", label: "Humor", keys: ["humor", "humour", "comedy", "satire", "comic", "funny"] },
  { id: "graphic", label: "Comics & graphic", keys: ["comics", "graphic novel", "graphic novels", "manga"] },
  { id: "poetry", label: "Poetry", keys: ["poetry", "poems"] },
  { id: "short", label: "Short stories", keys: ["short stories", "short story", "anthology", "anthologies"] },
];

export function categorise(subjects: string[] | undefined): string[] {
  if (!subjects?.length) return [];
  const hits = new Map<string, number>();
  const lower = subjects.slice(0, 80).map((s) => s.toLowerCase());
  for (const cat of CATEGORIES) {
    let n = 0;
    for (const s of lower) for (const k of cat.keys) if (s.includes(k)) { n++; break; }
    if (n) hits.set(cat.id, n);
  }
  // "Fiction" tags outnumber everything and "nonfiction" substring-matches
  // "fiction" nowhere, but "history" matches "historical fiction": if any
  // fiction genre hit, drop nonfiction unless it clearly dominates.
  const fictionIds = ["fantasy", "scifi", "mystery", "horror", "romance", "historical", "literary", "classics", "ya", "humor", "graphic", "short"];
  const fictionTotal = fictionIds.reduce((a, id) => a + (hits.get(id) ?? 0), 0);
  const nf = hits.get("nonfiction") ?? 0;
  if (nf && fictionTotal && nf < fictionTotal * 2) hits.delete("nonfiction");
  if (nf && lower.some((s) => s === "fiction" || s.startsWith("fiction,")) && nf < 3) hits.delete("nonfiction");
  return [...hits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => id);
}

export function coverUrl(coverId: number | undefined, size: "S" | "M" | "L" = "M"): string | null {
  return coverId ? `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg` : null;
}
