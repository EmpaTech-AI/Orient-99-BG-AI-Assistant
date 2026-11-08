// Weekly catalog refresh: crawl orient99.com program pages and write data/offers.json.
//
//   npm run catalog:refresh                 normal run
//   npm run catalog:refresh -- --accept-drop   accept an offer-count drop (guard b only)
//   npm run catalog:refresh -- --all-seeds     one-off comparison: crawl the old, full seed set,
//                                              list programs the shallow rule did not find, write nothing
//
// Everything that touches the network or the clock goes through runRefresh's options, so tests
// run it with a fake fetcher and a fake sleep.
import * as fs from 'fs';
import * as path from 'path';
import type { Catalog, HotelOffer, Program } from '../../src/catalog/types';
import {
  extractProgramLinks,
  oidFromUrl,
  parseListingCards,
  parseProgramPage,
  programFromCard,
  SITE_ORIGIN,
  type ListingCard,
} from './parse';

export const USER_AGENT = 'Orient99-AxeL-catalog/1.0';
export const SITEMAP_URL = `${SITE_ORIGIN}/permalinks-sitemap.php`;
export const DEFAULT_MAX_REQUESTS = 3000;
export const DEFAULT_CONCURRENCY = 3;
export const MIN_START_GAP_MS = 1000; // per slot, start to start
export const BACKOFF_MS = [2000, 4000, 8000]; // up to 3 retries
export const MAX_RETRY_AFTER_MS = 120_000;
export const MIN_PAGES_OK_RATIO = 0.8; // guard (a)
export const MAX_OFFER_DROP_RATIO = 0.15; // guard (b)
// Guard (c). Estimates until the first full run shows the real ratios; see the engineering
// review, decision D9.
export const MIN_HOLIDAY_OFFER_YIELD = 0.9;
export const MIN_DATE_YIELD = 0.8;

export interface FetchResult {
  status: number;
  body: string;
  retryAfter?: string | null; // value of the Retry-After header, when the fetcher has it
}

export interface RefreshOptions {
  fetchPage: (url: string) => Promise<FetchResult>; // throws on a network error
  sleep: (ms: number) => Promise<void>; // all spacing and backoff go through it
  now: () => Date; // run date and runtime
  catalogPath: string;
  acceptDrop: boolean;
  maxRequests?: number; // default 3000
  concurrency?: number; // default 3
  // Optional extras (not part of the issue's minimal shape):
  allSeeds?: boolean; // one-off comparison mode, never writes
  random?: () => number; // jitter source, default Math.random
  // Hook for the later manual step: titles of the programs in the old vector store. In
  // allSeeds mode the summary lists those without a counterpart in the new catalog.
  oldStoreTitles?: string[];
}

export interface RefreshResult {
  exitCode: 0 | 1;
  summary: string;
}

// ---------------- seeds ----------------

export interface Seed {
  url: string;
  isProgram: boolean; // a view?oid= URL, fetched as a program
  shallow: boolean; // part of the D2 seed set
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|ico|pdf|css|js)$/i;

export function parseSitemapUrls(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
    // The real sitemap writes query separators percent-encoded (view%3Foid%3D123).
    out.push(m[1].replace(/&amp;/g, '&').replace(/%3F/gi, '?').replace(/%26/gi, '&').replace(/%3D/gi, '='));
  }
  return out;
}

export function buildSeeds(sitemapUrls: string[], allSeeds: boolean): Seed[] {
  const byUrl = new Map<string, Seed>();
  const add = (url: string, isProgram: boolean, shallow: boolean) => {
    if (!byUrl.has(url)) byUrl.set(url, { url, isProgram, shallow });
  };
  add(`${SITE_ORIGIN}/`, false, true); // the homepage
  for (const raw of sitemapUrls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.hostname !== 'www.orient99.com') continue;
    let segments: string[];
    try {
      segments = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase());
    } catch {
      continue;
    }
    if (segments.length === 0) continue; // homepage already added
    if (IMAGE_EXT.test(u.pathname)) continue;
    if (u.pathname.includes('/reservation_calc.html')) continue;
    if (/\/(view\/)?hotel(\.html)?$/.test(u.pathname)) continue; // hotel pages are never fetched
    if (
      segments.some((s) => s === 'hotels' || s === 'каталог-хотели' || s.startsWith('хотели-в-'))
    ) {
      continue;
    }
    u.hash = '';
    const oid = u.searchParams.get('oid');
    const isProgram = /\/view(\.html)?$/.test(u.pathname) && !!oid && /^\d+$/.test(oid);
    if (isProgram) {
      add(`${SITE_ORIGIN}${u.pathname}?oid=${oid}`, true, true); // every view?oid URL is a seed
    } else {
      const shallow = segments.length <= 2;
      if (shallow || allSeeds) add(u.toString(), false, shallow);
    }
  }
  return [...byUrl.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

// ---------------- stable writer (D5) ----------------

function compareIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    if (a.length !== b.length) return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// Keys in the order of types.ts.
function orderedProgram(p: Program): Program {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    url: p.url,
    destination: p.destination,
    transport: p.transport,
    departure_city: p.departure_city,
    nights: p.nights,
    days: p.days,
    departure_dates: [...p.departure_dates],
    season: p.season,
    image: p.image,
    from_price_eur: p.from_price_eur,
  };
}

function orderedOffer(o: HotelOffer): HotelOffer {
  return {
    program_id: o.program_id,
    hotel_id: o.hotel_id,
    hotel: o.hotel,
    destination: o.destination,
    region: o.region,
    board: o.board,
    board_raw: o.board_raw,
    from_price_eur: o.from_price_eur,
    url: o.url,
    image: o.image,
  };
}

/**
 * Layout of data/offers.json: programs sorted by id, offers by (program_id, hotel_id), keys in the
 * order of types.ts, one JSON object per line inside the arrays, LF line endings, trailing newline.
 * The same catalog always gives the same bytes, and one changed offer changes one line.
 */
export function serializeCatalog(catalog: Catalog): string {
  const programs = [...catalog.programs].sort((a, b) => compareIds(a.id, b.id)).map(orderedProgram);
  const offers = [...catalog.offers]
    .sort((a, b) => compareIds(a.program_id, b.program_id) || compareIds(a.hotel_id, b.hotel_id))
    .map(orderedOffer);
  const lines = (items: unknown[]) =>
    items.length === 0 ? '[]' : `[\n${items.map((i) => `    ${JSON.stringify(i)}`).join(',\n')}\n  ]`;
  return (
    '{\n' +
    `  "version": ${JSON.stringify(catalog.version)},\n` +
    `  "scraped_at": ${JSON.stringify(catalog.scraped_at)},\n` +
    `  "source": ${JSON.stringify(catalog.source)},\n` +
    `  "programs": ${lines(programs)},\n` +
    `  "offers": ${lines(offers)}\n` +
    '}\n'
  );
}

export function writeCatalogFile(catalogPath: string, catalog: Catalog): void {
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  const tmp = `${catalogPath}.tmp`;
  fs.writeFileSync(tmp, serializeCatalog(catalog), { encoding: 'utf8' });
  fs.renameSync(tmp, catalogPath);
}

function readCommitted(catalogPath: string): { catalog: Catalog | null; note: string | null } {
  if (!fs.existsSync(catalogPath)) return { catalog: null, note: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    if (parsed && parsed.version === 1 && Array.isArray(parsed.offers) && Array.isArray(parsed.programs)) {
      return { catalog: parsed as Catalog, note: null };
    }
    return { catalog: null, note: 'committed file has an unexpected shape; treated as absent' };
  } catch {
    return { catalog: null, note: 'committed file is not valid JSON; treated as absent' };
  }
}

// ---------------- scheduler ----------------

class CapReached extends Error {}

interface Slot {
  lastStart: number; // ms since epoch of the last request start in this slot
}

interface Ctx {
  opts: RefreshOptions;
  maxRequests: number;
  concurrency: number;
  requests: number;
  retries: number;
  bytes: number;
  capHit: boolean;
  random: () => number;
  slots: Slot[]; // persistent across phases, so the 1 s gap holds from the sitemap request on
}

function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.min(Number(v) * 1000, MAX_RETRY_AFTER_MS);
  const when = Date.parse(v);
  if (Number.isFinite(when)) return Math.min(Math.max(when - nowMs, 0), MAX_RETRY_AFTER_MS);
  return null;
}

/** One logical page fetch: spacing, cap, and retries (network error, 429, 5xx). Every attempt counts. */
async function fetchWithRetry(ctx: Ctx, slot: Slot, url: string): Promise<{ status: number; body: string }> {
  const { opts } = ctx;
  for (let attempt = 0; ; attempt++) {
    const gap = opts.now().getTime() - slot.lastStart;
    if (gap < MIN_START_GAP_MS) await opts.sleep(MIN_START_GAP_MS - gap);
    if (ctx.capHit || ctx.requests >= ctx.maxRequests) {
      ctx.capHit = true;
      throw new CapReached();
    }
    ctx.requests++;
    slot.lastStart = opts.now().getTime();

    let res: FetchResult | null = null;
    try {
      res = await opts.fetchPage(url);
      ctx.bytes += res.body ? res.body.length : 0;
    } catch {
      res = null; // network error
    }
    const retryable = res === null || res.status === 429 || res.status >= 500;
    if (!retryable) return { status: res.status, body: res.body };
    if (attempt >= BACKOFF_MS.length) {
      return res ? { status: res.status, body: res.body } : { status: 0, body: '' };
    }
    ctx.retries++;
    const fromHeader = res ? parseRetryAfter(res.retryAfter, opts.now().getTime()) : null;
    const wait = Math.max(BACKOFF_MS[attempt], fromHeader ?? 0) + Math.floor(ctx.random() * 500);
    await opts.sleep(wait);
  }
}

/** Runs `work` for every item with `concurrency` slots. Results keep the item order. */
async function pool<T, R>(ctx: Ctx, items: T[], work: (item: T, slot: Slot) => Promise<R>): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    ctx.slots.map(async (slot) => {
      while (!ctx.capHit) {
        const i = next++;
        if (i >= items.length) return;
        try {
          results[i] = await work(items[i], slot);
        } catch (e) {
          if (e instanceof CapReached) return;
          throw e;
        }
      }
    }),
  );
  return results;
}

// ---------------- helpers for the summary ----------------

function sofiaDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return m;
}

function fmtCounts(m: Map<string, number>): string {
  if (m.size === 0) return 'none';
  return [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, n]) => `${k}=${n}`)
    .join(', ');
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a (0 of 0)' : `${((100 * n) / d).toFixed(1)}% (${n} of ${d})`;
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// ---------------- the run ----------------

interface ProgramResult {
  status: number;
  parsed: ReturnType<typeof parseProgramPage>;
}

export async function runRefresh(opts: RefreshOptions): Promise<RefreshResult> {
  const started = opts.now();
  const ctx: Ctx = {
    opts,
    maxRequests: opts.maxRequests ?? DEFAULT_MAX_REQUESTS,
    concurrency: Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY),
    requests: 0,
    retries: 0,
    bytes: 0,
    capHit: false,
    random: opts.random ?? Math.random,
    slots: [],
  };
  ctx.slots = Array.from({ length: ctx.concurrency }, () => ({ lastStart: -Infinity }));
  const allSeeds = !!opts.allSeeds;
  const lines: string[] = [];
  const problems: string[] = []; // each one blocks the write
  const finish = (exit: 0 | 1): RefreshResult => {
    const secs = Math.round((opts.now().getTime() - started.getTime()) / 1000);
    const head = [
      `requests=${ctx.requests} (cap ${ctx.maxRequests}), retries=${ctx.retries}, bytes~${ctx.bytes}, runtime=${secs}s`,
    ];
    return { exitCode: exit, summary: [...head, ...lines].join('\n') };
  };
  const capResult = (): RefreshResult => {
    lines.push(`REFUSED: request cap of ${ctx.maxRequests} reached; nothing written`);
    return finish(1);
  };

  // 1. sitemap
  const [sitemapRes] = await pool(ctx, [SITEMAP_URL], (u, slot) => fetchWithRetry(ctx, slot, u));
  if (ctx.capHit) return capResult();
  if (!sitemapRes || sitemapRes.status !== 200) {
    lines.push(`REFUSED: sitemap unavailable (status ${sitemapRes?.status ?? 'none'}); nothing written`);
    return finish(1);
  }
  const seeds = buildSeeds(parseSitemapUrls(sitemapRes.body), allSeeds);
  const listingSeeds = seeds.filter((s) => !s.isProgram);
  lines.push(
    `seeds=${seeds.length} (listing ${listingSeeds.length}, program ${seeds.length - listingSeeds.length})` +
      (allSeeds ? ' [--all-seeds comparison mode: nothing will be written]' : ''),
  );

  // 2. listing seeds
  const listingResults = await pool(ctx, listingSeeds, async (seed, slot) => {
    const res = await fetchWithRetry(ctx, slot, seed.url);
    if (res.status !== 200) return { status: res.status, links: [] as string[], cards: [] as ListingCard[] };
    return {
      status: res.status,
      links: extractProgramLinks(res.body, seed.url),
      cards: parseListingCards(res.body, seed.url),
    };
  });
  if (ctx.capHit) return capResult();
  const listingBySeed = new Map<string, (typeof listingResults)[number]>();
  listingSeeds.forEach((s, i) => listingBySeed.set(s.url, listingResults[i]));

  // 3. claim program URLs in seed order: the first URL in crawl order wins for an oid
  const claims = new Map<string, { url: string; viaShallow: boolean }>();
  const listingLinked = new Set<string>();
  const cards = new Map<string, ListingCard>();
  const claim = (oid: string, url: string, shallow: boolean) => {
    const c = claims.get(oid);
    if (!c) claims.set(oid, { url, viaShallow: shallow });
    else if (shallow) c.viaShallow = true;
  };
  for (const seed of seeds) {
    if (seed.isProgram) {
      const oid = oidFromUrl(seed.url);
      if (oid) claim(oid, seed.url, seed.shallow);
      continue;
    }
    const res = listingBySeed.get(seed.url);
    if (!res || res.status !== 200) continue;
    for (const link of res.links) {
      const oid = oidFromUrl(link);
      if (!oid) continue;
      listingLinked.add(oid);
      claim(oid, link, seed.shallow);
    }
    for (const card of res.cards) if (!cards.has(card.id)) cards.set(card.id, card);
  }

  // 4. program pages, each oid once
  const oids = [...claims.keys()];
  const programResults = await pool<string, ProgramResult>(ctx, oids, async (oid, slot) => {
    const url = claims.get(oid)!.url;
    const res = await fetchWithRetry(ctx, slot, url);
    if (res.status !== 200) return { status: res.status, parsed: null };
    let parsed: ReturnType<typeof parseProgramPage> = null;
    try {
      parsed = parseProgramPage(res.body, url);
    } catch {
      parsed = null;
    }
    return { status: res.status, parsed };
  });
  if (ctx.capHit) return capResult();

  const programs: Program[] = [];
  const offers: HotelOffer[] = [];
  const cardOnly = new Set<string>();
  const deepOnly: Program[] = [];
  let pagesOk = 0;
  let listingLinkedFetched = 0;
  let listingLinkedOk = 0;
  oids.forEach((oid, i) => {
    const r = programResults[i];
    if (!r) return;
    const linked = listingLinked.has(oid);
    if (linked) {
      listingLinkedFetched++;
      if (r.status === 200) listingLinkedOk++;
    }
    if (r.status === 200) pagesOk++;
    let program: Program | null = null;
    if (r.parsed) {
      program = r.parsed.program;
      offers.push(...r.parsed.offers);
    } else if (r.status === 200 && cards.has(oid)) {
      program = programFromCard(cards.get(oid)!);
      if (program) cardOnly.add(oid);
    }
    if (program) {
      programs.push(program);
      if (!claims.get(oid)!.viaShallow) deepOnly.push(program);
    }
  });

  // guard (a)
  const pagesRatio = listingLinkedFetched === 0 ? 0 : listingLinkedOk / listingLinkedFetched;
  lines.push(`guard a: listing-linked program pages with HTTP 200: ${pct(listingLinkedOk, listingLinkedFetched)} (min ${MIN_PAGES_OK_RATIO * 100}%)`);
  if (listingLinkedFetched === 0 || pagesRatio < MIN_PAGES_OK_RATIO) {
    problems.push('guard a: too few listing-linked program pages returned HTTP 200');
  }

  // guard (c), on the programs before expired ones are dropped
  const holidays = programs.filter((p) => p.kind === 'holiday');
  const holidaysWithOffers = holidays.filter((p) => offers.some((o) => o.program_id === p.id)).length;
  // Excursion pages carry an empty "Дати на отпътуване" block in the served HTML (the dates are
  // drawn by a script), so they never have dates and stay out of the date guard.
  const dated = programs.filter((p) => p.kind !== 'excursion');
  const withDates = dated.filter((p) => p.departure_dates.length > 0).length;
  const offerYield = holidays.length === 0 ? 0 : holidaysWithOffers / holidays.length;
  const dateYield = dated.length === 0 ? 0 : withDates / dated.length;
  lines.push(`guard c: holiday programs with at least one offer: ${pct(holidaysWithOffers, holidays.length)} (min ${MIN_HOLIDAY_OFFER_YIELD * 100}%)`);
  lines.push(`guard c: programs (excursions excluded) with at least one departure date: ${pct(withDates, dated.length)} (min ${MIN_DATE_YIELD * 100}%)`);
  if (holidays.length === 0 || offerYield < MIN_HOLIDAY_OFFER_YIELD) {
    problems.push('guard c: too few holiday programs yield an offer (--accept-drop does not override this)');
  }
  if (dated.length === 0 || dateYield < MIN_DATE_YIELD) {
    problems.push('guard c: too few programs yield a departure date (--accept-drop does not override this)');
  }

  // drop programs whose departures are all in the past; keep programs with no dates
  const today = sofiaDate(opts.now());
  const keepIds = new Set<string>();
  const keptPrograms = programs.filter((p) => {
    const keep = p.departure_dates.length === 0 || p.departure_dates.some((d) => d >= today);
    if (keep) keepIds.add(p.id);
    return keep;
  });
  const keptOffers = offers.filter((o) => keepIds.has(o.program_id));
  const droppedExpired = programs.length - keptPrograms.length;

  // guard (b)
  const committed = readCommitted(opts.catalogPath);
  if (committed.note) lines.push(`note: ${committed.note}`);
  if (committed.catalog) {
    const before = committed.catalog.offers.length;
    const after = keptOffers.length;
    const drop = before === 0 ? 0 : (before - after) / before;
    lines.push(`guard b: offers ${before} -> ${after} (${(drop * 100).toFixed(1)}% drop, max ${MAX_OFFER_DROP_RATIO * 100}%)`);
    if (drop > MAX_OFFER_DROP_RATIO) {
      if (opts.acceptDrop) lines.push('guard b: drop accepted (--accept-drop)');
      else problems.push('guard b: offers dropped more than 15% below the committed file (use --accept-drop to accept)');
    }
  } else {
    lines.push('guard b: skipped (no committed catalog, first run)');
  }

  // summary
  const byDest = (items: HotelOffer[], progs: Map<string, Program>) =>
    countBy(items, (o) => o.destination ?? progs.get(o.program_id)?.destination ?? 'unknown');
  const newProgramMap = new Map(keptPrograms.map((p) => [p.id, p]));
  lines.push(`programs=${keptPrograms.length} (dropped as expired: ${droppedExpired}, from listing cards only: ${cardOnly.size}), offers=${keptOffers.length}`);
  lines.push(`programs by kind: ${fmtCounts(countBy(keptPrograms, (p) => p.kind))}`);
  lines.push(`season counts: ${fmtCounts(countBy(keptPrograms, (p) => p.season))}`);
  lines.push(`program pages with HTTP 200: ${pagesOk} of ${oids.length}`);
  if (committed.catalog) {
    const oldProgs = new Map(committed.catalog.programs.map((p) => [p.id, p]));
    const oldKey = new Set(committed.catalog.offers.map((o) => `${o.program_id}|${o.hotel_id}`));
    const newKey = new Set(keptOffers.map((o) => `${o.program_id}|${o.hotel_id}`));
    const addedProgs = keptPrograms.filter((p) => !oldProgs.has(p.id));
    const removedProgs = committed.catalog.programs.filter((p) => !newProgramMap.has(p.id));
    const addedOffers = keptOffers.filter((o) => !oldKey.has(`${o.program_id}|${o.hotel_id}`));
    const removedOffers = committed.catalog.offers.filter((o) => !newKey.has(`${o.program_id}|${o.hotel_id}`));
    lines.push(`added programs: ${addedProgs.length} (${fmtCounts(countBy(addedProgs, (p) => p.destination ?? 'unknown'))})`);
    lines.push(`removed programs: ${removedProgs.length} (${fmtCounts(countBy(removedProgs, (p) => p.destination ?? 'unknown'))})`);
    lines.push(`added offers: ${addedOffers.length} (${fmtCounts(byDest(addedOffers, newProgramMap))})`);
    lines.push(`removed offers: ${removedOffers.length} (${fmtCounts(byDest(removedOffers, oldProgs))})`);
  }

  if (allSeeds) {
    lines.push(`comparison: programs found only through deep seeds (not by the shallow rule): ${deepOnly.length}`);
    for (const p of deepOnly) lines.push(`  deep-only: ${p.id} ${p.kind} ${p.url} | ${p.title}`);
    if (opts.oldStoreTitles) {
      const have = keptPrograms.map((p) => normalizeTitle(p.title));
      const missing = opts.oldStoreTitles.filter((t) => {
        const n = normalizeTitle(t);
        return n && !have.some((h) => h === n || h.includes(n) || n.includes(h));
      });
      lines.push(`old-store programs without a counterpart: ${missing.length}`);
      for (const t of missing) lines.push(`  no counterpart: ${t}`);
    } else {
      lines.push('old-store coverage: not checked (pass oldStoreTitles to runRefresh; manual step for the first full run)');
    }
    lines.push('--all-seeds is a comparison: nothing written');
    return finish(problems.length > 0 ? 1 : 0);
  }

  if (problems.length > 0) {
    for (const p of problems) lines.push(`REFUSED: ${p}`);
    lines.push('data file untouched');
    return finish(1);
  }

  const catalog: Catalog = {
    version: 1,
    scraped_at: opts.now().toISOString(),
    source: 'https://www.orient99.com',
    programs: keptPrograms,
    offers: keptOffers,
  };
  writeCatalogFile(opts.catalogPath, catalog);
  lines.push(`written: ${opts.catalogPath}`);
  return finish(0);
}

// ---------------- CLI ----------------

async function main(): Promise<void> {
  // Loaded here so that importing runRefresh in tests never touches axios.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const axios = require('axios').default ?? require('axios');
  const args = process.argv.slice(2);
  const catalogArg = args.find((a) => a.startsWith('--catalog='));
  const catalogPath = catalogArg
    ? path.resolve(catalogArg.slice('--catalog='.length))
    : path.resolve(__dirname, '../../data/offers.json');

  const result = await runRefresh({
    fetchPage: async (url: string) => {
      const res = await axios.get(url, {
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(d: unknown) => d],
        timeout: 30_000,
        maxContentLength: 30 * 1024 * 1024,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' },
      });
      const ra = res.headers?.['retry-after'];
      return {
        status: res.status,
        body: typeof res.data === 'string' ? res.data : String(res.data ?? ''),
        retryAfter: typeof ra === 'string' ? ra : null,
      };
    },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    catalogPath,
    acceptDrop: args.includes('--accept-drop'),
    allSeeds: args.includes('--all-seeds'),
  });
  console.log(result.summary);
  process.exit(result.exitCode);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
