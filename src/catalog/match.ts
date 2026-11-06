// Hotel name matching: a phonetic key over Bulgarian and Latin spellings, and a
// matcher that never guesses between two hotels. Pure: no disk, no clock.
// tsconfig has no esModuleInterop, so a default import of JSON is undefined at runtime.
import defaultAliases = require('./aliases.json');

export const ALIASES: Record<string, string> = defaultAliases;

export interface HotelRef {
  hotel_id: string;
  hotel: string;
  destination: string | null;
  region: string | null;
}

export interface MatchResult {
  match: 'exact' | 'approximate' | 'none';
  matched_by?: 'containment' | 'key' | 'alias';
  hotel_id?: string;
  hotel?: string;
  candidates?: { hotel_id: string; hotel: string; destination: string | null }[];
}

const TURKISH: Record<string, string> = {
  Ö: 'O', ö: 'o', Ü: 'U', ü: 'u', İ: 'I', ı: 'i', Ş: 'S', ş: 's', Ç: 'C', ç: 'c', Ğ: 'G', ğ: 'g',
};

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};

const DROPPED = new Set(['AND', 'I', 'HOTEL', 'HOTELS', 'OTEL']);

const GENERIC_NORMALISE: Record<string, string> = {
  RESORT: 'RESORT', RISORT: 'RESORT', RESORTS: 'RESORT',
  SPA: 'SPA',
  CLUB: 'CLUB', KLUB: 'CLUB',
  BEACH: 'BEACH', BEAKH: 'BEACH', BIKH: 'BEACH', BIK: 'BEACH',
};
const GENERIC_KEYS = new Set(Object.values(GENERIC_NORMALISE));

function foldTurkish(text: string): string {
  return text.replace(/[ÖöÜüİıŞşÇçĞğ]/g, (c) => TURKISH[c]);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyAliases(lower: string, aliases: Record<string, string>): { text: string; used: boolean } {
  let used = false;
  const keys = Object.keys(aliases);
  if (keys.length === 0) return { text: lower, used };
  const lowered: Record<string, string> = {};
  for (const k of keys) lowered[k.toLowerCase()] = aliases[k];
  const alternation = Object.keys(lowered).map(escapeRe).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${alternation})(?![\\p{L}\\p{N}])`, 'gu');
  const text = lower.replace(re, (w) => {
    used = true;
    return lowered[w];
  });
  return { text, used };
}

function rewriteToken(raw: string): string {
  let t = raw.replace(/PH/g, 'F');
  t = t.replace(/C(?=[EIY])/g, 'S').replace(/[CKQ]/g, 'K');
  t = t.replace(/[YIJ]/g, 'I').replace(/W/g, 'V').replace(/Z/g, 'S');
  t = t.replace(/(.)\1+/g, '$1');
  if (t.length > 3 && t.endsWith('E')) t = t.slice(0, -1);
  return t;
}

export interface KeyDetail {
  tokens: string[];
  aliasUsed: boolean;
}

// keyTokens plus whether an alias replaced a word (matchHotel reports that).
export function keyTokensDetailed(text: string, aliases: Record<string, string> = ALIASES): KeyDetail {
  const folded = foldTurkish(text || '').toLowerCase();
  const { text: aliased, used } = applyAliases(folded, aliases);
  let latin = '';
  for (const ch of aliased) latin += TRANSLIT[ch] ?? ch;
  const cleaned = latin.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const tokens: string[] = [];
  if (cleaned) {
    for (const raw of cleaned.split(' ')) {
      if (/^[0-9]+$/.test(raw)) continue; // digits only, including star tokens like 5*
      const t = rewriteToken(raw);
      if (!t || DROPPED.has(t)) continue;
      tokens.push(GENERIC_NORMALISE[t] ?? t);
    }
  }
  return { tokens, aliasUsed: used };
}

// Key steps 1 and 3-8.
export function keyTokens(text: string, aliases: Record<string, string> = ALIASES): string[] {
  return keyTokensDetailed(text, aliases).tokens;
}

// Key step 2: the main name, plus the "(EX. ...)" name when there is one. Other
// parenthesised text is dropped.
export function hotelNames(name: string): string[] {
  const raw = name || '';
  const ex = /\(\s*ex\b\.?\s*([^)]*)\)/i.exec(raw);
  const main = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const names = [main];
  if (ex && ex[1].trim()) names.push(ex[1].trim());
  return names;
}

export function destinationWords(hotels: HotelRef[], aliases: Record<string, string> = ALIASES): Set<string> {
  const words = new Set<string>();
  for (const h of hotels) {
    for (const place of [h.destination, h.region]) {
      if (place) for (const t of keyTokens(place, aliases)) words.add(t);
    }
  }
  return words;
}

function isGeneric(t: string): boolean {
  return GENERIC_KEYS.has(t);
}

function distinctive(tokens: string[], destWords: Set<string>): Set<string> {
  const dist = new Set(tokens.filter((t) => !isGeneric(t) && !destWords.has(t)));
  if (dist.size === 0) {
    // Place-only name (SIDE RESORT, KEMER BEACH RESORT): its place words identify it.
    for (const t of tokens) if (!isGeneric(t) && destWords.has(t)) dist.add(t);
  }
  return dist;
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
}

interface Variant {
  dist: Set<string>;
  generic: Set<string>;
}

interface Entry {
  ref: HotelRef;
  variants: Variant[];
}

function buildEntries(hotels: HotelRef[], aliases: Record<string, string>, destWords: Set<string>): Entry[] {
  const byId = new Map<string, Entry>();
  for (const ref of hotels) {
    let entry = byId.get(ref.hotel_id);
    if (!entry) {
      entry = { ref, variants: [] };
      byId.set(ref.hotel_id, entry);
    }
    for (const name of hotelNames(ref.hotel)) {
      const tokens = keyTokens(name, aliases);
      entry.variants.push({ dist: distinctive(tokens, destWords), generic: new Set(tokens.filter(isGeneric)) });
    }
  }
  return [...byId.values()];
}

function score(e: Entry, qd: Set<string>): { exact: number; fuzzy: number } {
  let best = { exact: 0, fuzzy: 0 };
  for (const v of e.variants) {
    let exact = 0;
    let fuzzy = 0;
    for (const q of qd) {
      if (v.dist.has(q)) exact++;
      else if ([...v.dist].some((t) => withinOneEdit(q, t))) fuzzy++;
    }
    if (exact > best.exact || (exact === best.exact && fuzzy > best.fuzzy)) best = { exact, fuzzy };
  }
  return best;
}

// Step 7: shared exact tokens, then shared fuzzy tokens, then the name; at most 5.
function candidateList(entries: Entry[], qd: Set<string>): MatchResult['candidates'] {
  const scored = entries.map((e) => ({ e, s: score(e, qd) }));
  scored.sort(
    (x, y) =>
      y.s.exact - x.s.exact ||
      y.s.fuzzy - x.s.fuzzy ||
      (x.e.ref.hotel < y.e.ref.hotel ? -1 : x.e.ref.hotel > y.e.ref.hotel ? 1 : 0) ||
      (x.e.ref.hotel_id < y.e.ref.hotel_id ? -1 : x.e.ref.hotel_id > y.e.ref.hotel_id ? 1 : 0),
  );
  return scored
    .slice(0, 5)
    .map(({ e }) => ({ hotel_id: e.ref.hotel_id, hotel: e.ref.hotel, destination: e.ref.destination }));
}

export function matchHotel(
  query: string,
  hotels: HotelRef[],
  aliases: Record<string, string> = ALIASES,
  destWords?: Set<string>,
): MatchResult {
  const words = destWords ?? destinationWords(hotels, aliases);
  const { tokens, aliasUsed } = keyTokensDetailed(query, aliases);
  const qd = new Set(tokens.filter((t) => !isGeneric(t) && !words.has(t)));
  const qg = new Set(tokens.filter(isGeneric));
  if (qd.size === 0) for (const t of tokens) if (!isGeneric(t) && words.has(t)) qd.add(t);
  if (qd.size === 0) return { match: 'none' };

  const entries = buildEntries(hotels, aliases, words);
  const hasAll = (needed: Set<string>, have: Set<string>) => [...needed].every((t) => have.has(t));

  // A: hotels with a name variant whose distinctive tokens contain every Q_d token.
  let a = new Map<Entry, Variant[]>();
  for (const e of entries) {
    const vs = e.variants.filter((v) => hasAll(qd, v.dist));
    if (vs.length) a.set(e, vs);
  }
  if (qg.size > 0) {
    const narrowed = new Map<Entry, Variant[]>();
    for (const [e, vs] of a) {
      const keep = vs.filter((v) => hasAll(qg, v.generic));
      if (keep.length) narrowed.set(e, keep);
    }
    if (narrowed.size > 0) a = narrowed;
  }

  const exact = (e: Entry, by: 'containment' | 'key'): MatchResult => ({
    match: 'exact',
    matched_by: aliasUsed ? 'alias' : by,
    hotel_id: e.ref.hotel_id,
    hotel: e.ref.hotel,
  });

  if (a.size === 1) return exact([...a.keys()][0], 'containment');
  if (a.size > 1) {
    const b = [...a].filter(([, vs]) => vs.some((v) => v.dist.size === qd.size)).map(([e]) => e);
    if (b.length === 1) return exact(b[0], 'key');
    return { match: 'approximate', candidates: candidateList([...a.keys()], qd) };
  }

  const near = entries.filter((e) => {
    const s = score(e, qd);
    return s.exact + s.fuzzy > 0;
  });
  if (near.length === 0) return { match: 'none' };
  return { match: 'approximate', candidates: candidateList(near, qd) };
}
