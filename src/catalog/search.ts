// Deterministic offer search over a Catalog. Pure: the caller passes the catalog
// and today's date (Europe/Sofia, yyyy-mm-dd); nothing here reads a disk or a clock.
import {
  BOARDS,
  Catalog,
  HotelOffer,
  OfferFlag,
  OfferRow,
  Program,
  PROGRAM_KINDS,
  SearchOffersError,
  SearchOffersInput,
  SearchOffersResult,
  TRANSPORTS,
} from './types';
import { ALIASES, HotelRef, destinationWords, keyTokens, matchHotel } from './match';

const DEFAULT_LIMIT = 8;
const DATE_WINDOW = 12;
const DAY_MS = 86_400_000;

// ---- validation (D4: the tool never throws on bad input) ----

export type ValidationResult = { ok: true; input: SearchOffersInput } | { ok: false; error: SearchOffersError };

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return NaN;
}

export function validateInput(raw: unknown): ValidationResult {
  if (raw === undefined || raw === null) return { ok: true, input: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: { error: 'invalid_input', fields: ['input'] } };
  }
  const src = raw as Record<string, unknown>;
  const bad: string[] = [];
  const input: SearchOffersInput = {};
  const given = (k: string) => src[k] !== undefined && src[k] !== null && src[k] !== '';

  for (const k of ['hotel', 'destination'] as const) {
    if (!given(k)) continue;
    if (typeof src[k] !== 'string') bad.push(k);
    else if ((src[k] as string).trim()) input[k] = (src[k] as string).trim();
  }

  const oneOf = <T extends string>(k: string, allowed: readonly T[]): T | undefined => {
    if (!given(k)) return undefined;
    if (typeof src[k] === 'string' && (allowed as readonly string[]).includes(src[k] as string)) return src[k] as T;
    bad.push(k);
    return undefined;
  };
  const transport = oneOf('transport', TRANSPORTS);
  if (transport) input.transport = transport;
  const board = oneOf('board', BOARDS.filter((b) => b !== 'OTHER') as SearchOffersInput['board'][]);
  if (board) input.board = board;
  const kind = oneOf('kind', PROGRAM_KINDS);
  if (kind) input.kind = kind;

  const whole = (k: 'season_year' | 'month' | 'nights', min: number, max: number) => {
    if (!given(k)) return;
    const n = toNumber(src[k]);
    if (Number.isInteger(n) && n >= min && n <= max) input[k] = n;
    else bad.push(k);
  };
  whole('season_year', 2000, 2100);
  whole('month', 1, 12);
  whole('nights', 1, 365);

  if (given('budget_per_person_eur')) {
    const n = toNumber(src['budget_per_person_eur']);
    if (Number.isFinite(n) && n >= 0) input.budget_per_person_eur = n;
    else bad.push('budget_per_person_eur');
  }

  if (given('departure_date')) {
    if (typeof src['departure_date'] === 'string' && isRealDate(src['departure_date'].trim())) {
      input.departure_date = src['departure_date'].trim();
    } else bad.push('departure_date');
  }

  if (bad.length) return { ok: false, error: { error: 'invalid_input', fields: bad } };
  return { ok: true, input };
}

// ---- dates ----

const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};
const daysBetween = (a: string, b: string): number => Math.abs(dayNumber(a) - dayNumber(b));
const pad = (n: number) => String(n).padStart(2, '0');

function monthRange(year: number, month: number): { first: string; last: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { first: `${year}-${pad(month)}-01`, last: `${year}-${pad(month)}-${pad(lastDay)}` };
}

function targetMonth(input: SearchOffersInput, today: string): { first: string; last: string } | null {
  if (!input.month) return null;
  if (input.season_year) return monthRange(input.season_year, input.month);
  const [ty, tm] = today.split('-').map(Number);
  // The current month still has days left (today counts), so month >= current month is this year.
  return monthRange(input.month >= tm ? ty : ty + 1, input.month);
}

// distance in days from a date to the closed interval [first, last]
function distanceTo(date: string, first: string, last: string): number {
  if (date < first) return daysBetween(date, first);
  if (date > last) return daysBetween(date, last);
  return 0;
}

// `inside` dates first (date order, at most 12), then filled with the closest others.
function windowAround(future: string[], first: string, last: string): string[] {
  const inside = future.filter((d) => d >= first && d <= last);
  if (inside.length >= DATE_WINDOW) return inside.slice(0, DATE_WINDOW);
  const others = future
    .filter((d) => d < first || d > last)
    .sort((a, b) => distanceTo(a, first, last) - distanceTo(b, first, last) || (a < b ? -1 : 1));
  return [...inside, ...others.slice(0, DATE_WINDOW - inside.length)].sort();
}

// ---- rows ----

interface Candidate {
  program: Program;
  offer: HotelOffer | null;
  future: string[]; // future departures, ascending
}

function mostCommon(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  for (const [v, n] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (best === null || n > counts.get(best)) best = v;
  }
  return best;
}

function buildHotelRefs(offers: HotelOffer[]): HotelRef[] {
  const byId = new Map<string, HotelOffer[]>();
  for (const o of offers) {
    const list = byId.get(o.hotel_id);
    if (list) list.push(o);
    else byId.set(o.hotel_id, [o]);
  }
  return [...byId].map(([hotel_id, list]) => ({
    hotel_id,
    hotel: list[0].hotel,
    destination: mostCommon(list.map((o) => o.destination)),
    region: mostCommon(list.map((o) => o.region)),
  }));
}

function inYear(d: string, year: number): boolean {
  return d.startsWith(`${year}-`);
}

export function search(
  catalog: Catalog,
  input: SearchOffersInput,
  today: string,
  opts?: { limit?: number },
): SearchOffersResult {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const programs = new Map(catalog.programs.map((p) => [p.id, p]));
  const keyCache = new Map<string, string[]>();
  const keysOf = (text: string): string[] => {
    let k = keyCache.get(text);
    if (!k) {
      k = keyTokens(text, ALIASES);
      keyCache.set(text, k);
    }
    return k;
  };

  // All rows before any filter: one per hotel offer, one per program without hotel offers.
  const withOffers = new Set(catalog.offers.map((o) => o.program_id));
  const all: Candidate[] = [];
  for (const o of catalog.offers) {
    const program = programs.get(o.program_id);
    if (program) all.push({ program, offer: o, future: program.departure_dates.filter((d) => d >= today) });
  }
  for (const p of catalog.programs) {
    if (!withOffers.has(p.id)) all.push({ program: p, offer: null, future: p.departure_dates.filter((d) => d >= today) });
  }

  const destinationPasses = (c: Candidate): boolean => {
    if (!input.destination) return true;
    const want = keysOf(input.destination);
    if (want.length === 0) return true;
    const fields = c.offer ? [c.offer.destination, c.offer.region, c.program.title] : [c.program.title];
    return fields.some((f) => {
      if (!f) return false;
      const have = new Set(keysOf(f));
      return want.every((t) => have.has(t));
    });
  };

  // ---- hotel match ----
  let match: SearchOffersResult['match'] = 'not_requested';
  let matchedBy: SearchOffersResult['matched_by'];
  let hotelName: string | undefined;
  let candidates: SearchOffersResult['candidates'];
  let exactId: string | undefined;

  if (input.hotel) {
    const refs = buildHotelRefs(catalog.offers);
    const words = destinationWords(refs, ALIASES);
    let result = matchHotel(input.hotel, refs, ALIASES, words);
    if (input.destination) {
      const inDestination = new Set(all.filter((c) => c.offer && destinationPasses(c)).map((c) => c.offer.hotel_id));
      const subset = refs.filter((r) => inDestination.has(r.hotel_id));
      const narrowed = matchHotel(input.hotel, subset, ALIASES, words);
      result = narrowed.match === 'none' ? result : narrowed;
    }
    match = result.match;
    if (result.match === 'exact') {
      matchedBy = result.matched_by;
      hotelName = result.hotel;
      exactId = result.hotel_id;
    } else if (result.match === 'approximate') {
      candidates = result.candidates.map((c) => ({ hotel: c.hotel, destination: c.destination }));
    }
  }

  const base = (extra: Partial<SearchOffersResult>): SearchOffersResult => ({
    match,
    ...(matchedBy ? { matched_by: matchedBy } : {}),
    ...(hotelName ? { hotel: hotelName } : {}),
    ...(candidates ? { candidates } : {}),
    rows: [],
    total_matching: 0,
    today,
    catalog_scraped_at: catalog.scraped_at,
    ...extra,
  });

  if (input.hotel && match !== 'exact') return base({});

  // ---- scope, past dates, filters ----
  const scoped = exactId ? all.filter((c) => c.offer && c.offer.hotel_id === exactId) : all.filter(destinationPasses);
  // Rows that had dates but have none left are dropped; rows without any dates stay.
  const alive = scoped.filter((c) => c.program.departure_dates.length === 0 || c.future.length > 0);

  const month = targetMonth(input, today);
  const filters: Record<string, (c: Candidate) => boolean> = {};
  if (input.transport) filters.transport = (c) => c.program.transport === input.transport;
  if (input.season_year) {
    const y = input.season_year;
    filters.season_year = (c) =>
      c.program.departure_dates.length > 0 ? c.future.some((d) => inYear(d, y)) : c.program.season.includes(String(y));
  }
  if (month) filters.month = (c) => c.future.some((d) => d >= month.first && d <= month.last);
  if (input.nights) filters.nights = (c) => c.program.nights === input.nights;
  if (input.board) filters.board = (c) => c.offer !== null && c.offer.board === input.board;
  if (input.kind) filters.kind = (c) => c.program.kind === input.kind;

  const passing = alive.filter((c) => Object.values(filters).every((f) => f(c)));

  // ---- rows ----
  const rows = passing.map((c) => ({ c, row: toRow(c, input, month) }));
  rows.sort((x, y) => compareRows(x, y, input));
  const total = rows.length;
  // _price orders rows only; the tool never returns an amount (design R2-24).
  const out: OfferRow[] = rows.slice(0, limit).map(({ row }) => {
    const { _price, ...visible } = row;
    return visible;
  });

  const result = base({ rows: out, total_matching: total });
  if (exactId) {
    result.unmet_filters = total > 0 ? [] : unmetFilters(scoped.length > 0 && alive.length === 0, alive, filters);
  }
  return result;
}

function unmetFilters(onlyPast: boolean, alive: Candidate[], filters: Record<string, (c: Candidate) => boolean>): string[] {
  if (onlyPast) return ['past_dates'];
  const active = Object.keys(filters);
  const alone = active.filter((name) => alive.filter(filters[name]).length === 0);
  return alone.length > 0 ? alone : active;
}

function toRow(c: Candidate, input: SearchOffersInput, month: { first: string; last: string } | null): OfferRow & { _price: number | null } {
  const { program, offer, future } = c;
  let nearest: string | null = null;
  let dates: string[] = [];

  if (future.length > 0) {
    if (input.departure_date) {
      const target = input.departure_date;
      const byDistance = [...future].sort((a, b) => daysBetween(a, target) - daysBetween(b, target) || (a < b ? -1 : 1));
      nearest = byDistance[0];
      dates = byDistance.slice(0, DATE_WINDOW).sort();
    } else if (month) {
      nearest = future.find((d) => d >= month.first && d <= month.last) ?? null;
      dates = windowAround(future, month.first, month.last);
    } else if (input.season_year) {
      const range = { first: `${input.season_year}-01-01`, last: `${input.season_year}-12-31` };
      nearest = future.find((d) => d >= range.first && d <= range.last) ?? null;
      dates = windowAround(future, range.first, range.last);
    } else {
      nearest = future[0];
      dates = future.slice(0, DATE_WINDOW);
    }
  }

  const price = offer ? offer.from_price_eur : program.from_price_eur;
  const flags: OfferFlag[] = [];
  if (input.budget_per_person_eur !== undefined && price !== null && price > input.budget_per_person_eur) flags.push('over_budget');
  if (program.departure_dates.length === 0) flags.push('dates_unknown');

  return {
    kind: program.kind,
    title: program.title,
    hotel: offer ? offer.hotel : null,
    destination: offer ? offer.destination : program.destination,
    transport: program.transport,
    departure_city: program.departure_city,
    nights: program.nights,
    days: program.days,
    nearest_departure: nearest,
    departure_dates: dates,
    board: offer ? offer.board : null,
    season: program.season,
    image: (offer && offer.image) || program.image,
    link: offer ? offer.url : program.url,
    flags,
    _price: price,
  };
}

function cmp<T>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRows(
  x: { c: Candidate; row: OfferRow & { _price: number | null } },
  y: { c: Candidate; row: OfferRow & { _price: number | null } },
  input: SearchOffersInput,
): number {
  const a = x.row;
  const b = y.row;
  // 1. nearest departure (or distance to the requested date); rows without dates last
  if ((a.nearest_departure === null) !== (b.nearest_departure === null)) return a.nearest_departure === null ? 1 : -1;
  if (a.nearest_departure !== null) {
    const k = input.departure_date
      ? daysBetween(a.nearest_departure, input.departure_date) - daysBetween(b.nearest_departure, input.departure_date)
      : cmp(a.nearest_departure, b.nearest_departure);
    if (k !== 0) return k;
  }
  // 2. within budget before over budget
  if (input.budget_per_person_eur !== undefined) {
    const k = Number(a.flags.includes('over_budget')) - Number(b.flags.includes('over_budget'));
    if (k !== 0) return k;
  }
  // 3. lower price first, null last
  if ((a._price === null) !== (b._price === null)) return a._price === null ? 1 : -1;
  if (a._price !== null && a._price !== b._price) return a._price - b._price;
  // 4. hotel name, 5. program id
  return cmp(a.hotel ?? '', b.hotel ?? '') || cmp(x.c.program.id, y.c.program.id) || cmp(x.c.offer?.hotel_id ?? '', y.c.offer?.hotel_id ?? '');
}
