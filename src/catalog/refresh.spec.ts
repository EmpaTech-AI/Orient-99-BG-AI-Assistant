// runRefresh: guards, scheduler, writer. A fake site stands in for orient99.com; nothing here
// touches the network. Time is virtual where spacing matters.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildSeeds,
  parseSitemapUrls,
  runRefresh,
  serializeCatalog,
  type FetchResult,
  type RefreshOptions,
} from '../../scripts/catalog/refresh';
import type { Catalog } from './types';

const ORIGIN = 'https://www.orient99.com';
const NOW = new Date('2026-11-05T10:00:00Z');

// ---------- fake site ----------

interface FakeProgram {
  oid: number;
  hotels: number;
  status?: number; // non-200 -> the page is that error
  dates?: string[]; // ISO; default one 2027 date; [] -> no dates block
  html?: string; // full override
  hotelsMarkup?: boolean; // false -> a page with no hotel rows
}

const dmy = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)} г.`;

function programHtml(p: FakeProgram): string {
  const dates = p.dates ?? ['2027-06-01'];
  const boxes =
    p.hotelsMarkup === false
      ? ''
      : Array.from({ length: p.hotels }, (_, i) => {
          const hid = p.oid * 100 + i;
          return `<div class="offer_box_int offer_hotel_box"><div class="offer_title_int"><a href="/early_booking/e/view/hotel?hid=${hid}&amp;oid=${p.oid}">HOTEL ${p.oid}-${i}</a></div>
<div class="location_int">Алания, Анталия</div><span class="food_text">Вид хранене: AI</span>
<div class="price_int"><div>от <span>500</span> €</div></div></div>`;
        }).join('\n');
  return `<html><head><title>Алания - Лято 2027 програма ${p.oid}</title></head><body>
<div class="offer_icon"><span class="content_title_top">Транспорт</span><br>Самолет</div>
<div class="offer_icon"><span class="content_title_top">Продължителност</span><br>8 дни / 7 нощувки</div>
${dates.length ? `<div class="offer_icon"><span class="content_title_top">Дати на отпътуване</span><br>${dates.map((d) => `<span>${dmy(d)},</span>`).join('')}</div>` : ''}
<div id="accommodation">${boxes}</div></body></html>`;
}

interface Site {
  fetchPage: (url: string) => Promise<FetchResult>;
  calls: string[];
}

function makeSite(
  programs: FakeProgram[],
  extra: {
    deep?: { path: string; oids: number[] }; // a 3-segment listing page linked from the sitemap
    fetchHook?: (url: string, n: number) => Promise<FetchResult | undefined> | FetchResult | undefined;
  } = {},
): Site {
  const byUrl = new Map<string, FakeProgram>();
  const programUrl = (p: FakeProgram) => `${ORIGIN}/early_booking/early_a/view?oid=${p.oid}`;
  programs.forEach((p) => byUrl.set(programUrl(p), p));
  const links = (oids: number[]) =>
    oids.map((o) => `<a href="/early_booking/early_a/view?oid=${o}">p</a>`).join('');
  const deepUrl = extra.deep ? `${ORIGIN}${extra.deep.path}` : null;
  const calls: string[] = [];
  const fetchPage = async (url: string): Promise<FetchResult> => {
    calls.push(url);
    const hooked = extra.fetchHook ? await extra.fetchHook(url, calls.length) : undefined;
    if (hooked) return hooked;
    if (url === `${ORIGIN}/permalinks-sitemap.php`) {
      return {
        status: 200,
        body: `<urlset><url><loc>${ORIGIN}/early_booking</loc></url>${
          deepUrl ? `<url><loc>${deepUrl}</loc></url>` : ''
        }</urlset>`,
      };
    }
    if (url === `${ORIGIN}/`) return { status: 200, body: '<html></html>' };
    if (url === `${ORIGIN}/early_booking`) {
      return { status: 200, body: `<html>${links(programs.map((p) => p.oid))}</html>` };
    }
    if (deepUrl && url === deepUrl) return { status: 200, body: `<html>${links(extra.deep!.oids)}</html>` };
    const p = byUrl.get(url);
    if (p) {
      if (p.status && p.status !== 200) return { status: p.status, body: 'error' };
      return { status: 200, body: p.html ?? programHtml(p) };
    }
    // programs reachable only through the deep listing
    const m = /oid=(\d+)$/.exec(url);
    if (m && extra.deep?.oids.includes(Number(m[1]))) return { status: 200, body: programHtml({ oid: Number(m[1]), hotels: 2 }) };
    return { status: 404, body: 'not found' };
  };
  return { fetchPage, calls };
}

const range = (n: number, start = 1000) => Array.from({ length: n }, (_, i) => start + i);
const uniform = (n: number, hotels: number): FakeProgram[] => range(n).map((oid) => ({ oid, hotels }));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-refresh-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function opts(site: Site, over: Partial<RefreshOptions> = {}): RefreshOptions {
  return {
    fetchPage: site.fetchPage,
    sleep: async () => undefined,
    now: () => NOW,
    catalogPath: path.join(dir, 'offers.json'),
    acceptDrop: false,
    random: () => 0,
    ...over,
  };
}

const readBytes = (p: string) => fs.readFileSync(p);

// ---------- guards ----------

describe('runRefresh first run and guard (a)', () => {
  it('first run with every page at 200 writes the catalog (guard b skipped)', async () => {
    // protects=a first run (no committed file) writing a valid version-1 catalog with the crawled rows;
    // fails_when=guard (b) blocks a first run, or the written file lacks programs/offers/version/scraped_at;
    // no_claim=real network behaviour.
    const site = makeSite(uniform(10, 5));
    const r = await runRefresh(opts(site));
    expect(r.exitCode).toBe(0);
    const cat = JSON.parse(fs.readFileSync(path.join(dir, 'offers.json'), 'utf8')) as Catalog;
    expect(cat.version).toBe(1);
    expect(cat.scraped_at).toBe('2026-11-05T10:00:00.000Z');
    expect(cat.programs).toHaveLength(10);
    expect(cat.offers).toHaveLength(50);
    expect(r.summary).toContain('guard b: skipped');
    expect(r.summary).toMatch(/requests=\d+/);
    expect(r.summary).toMatch(/runtime=\d+s/);
  });

  it('79% of listing-linked program pages at 200 refuses and leaves the file byte-identical; 80% passes', async () => {
    // protects=guard (a): the committed file is untouched when too many program pages fail;
    // fails_when=a 79% run writes, or the 80% boundary run is refused;
    // no_claim=the failing pages are really the site's fault.
    const file = path.join(dir, 'offers.json');
    await runRefresh(opts(makeSite(uniform(100, 1))));
    const before = readBytes(file);
    const bad = uniform(100, 1).map((p, i) => (i < 21 ? { ...p, status: 404 } : p));
    const r = await runRefresh(opts(makeSite(bad), { acceptDrop: true }));
    expect(r.exitCode).toBe(1);
    expect(r.summary).toContain('79.0% (79 of 100)');
    expect(r.summary).toContain('guard a');
    expect(readBytes(file).equals(before)).toBe(true);

    const edge = uniform(100, 1).map((p, i) => (i < 20 ? { ...p, status: 404 } : p));
    const ok = await runRefresh(opts(makeSite(edge), { acceptDrop: true }));
    expect(ok.exitCode).toBe(0);
    expect(ok.summary).toContain('80.0% (80 of 100)');
  });
});

describe('runRefresh guard (b) offer drop', () => {
  async function committedWith100Offers() {
    const file = path.join(dir, 'offers.json');
    await runRefresh(opts(makeSite(uniform(20, 5))));
    return { file, before: readBytes(file) };
  }

  it('a 16% offer drop refuses and leaves the file byte-identical; 15% passes', async () => {
    // protects=guard (b) at its boundary (> 15% refuses);
    // fails_when=84 offers against 100 are written, or 85 against 100 is refused;
    // no_claim=season-aware comparison (TODO T3): the guard compares raw counts.
    const { file, before } = await committedWith100Offers();
    const r = await runRefresh(opts(makeSite(uniform(12, 7))));
    expect(r.exitCode).toBe(1);
    expect(r.summary).toContain('guard b: offers 100 -> 84 (16.0% drop');
    expect(readBytes(file).equals(before)).toBe(true);
    const edge = await runRefresh(opts(makeSite(uniform(17, 5))));
    expect(edge.exitCode).toBe(0);
    expect(edge.summary).toContain('100 -> 85 (15.0% drop');
  });

  it('acceptDrop lets a 16% drop write the file', async () => {
    // protects=--accept-drop overriding guard (b);
    // fails_when=the drop is refused with acceptDrop, or the file keeps the old rows;
    // no_claim=acceptDrop overrides guard (c): see the yield tests.
    const { file, before } = await committedWith100Offers();
    const r = await runRefresh(opts(makeSite(uniform(12, 7)), { acceptDrop: true }));
    expect(r.exitCode).toBe(0);
    expect(r.summary).toContain('drop accepted');
    expect(readBytes(file).equals(before)).toBe(false);
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog).offers).toHaveLength(84);
  });
});

describe('runRefresh request cap', () => {

  it('reaching the cap leaves an existing file byte-identical', async () => {
    // protects=the committed catalog surviving a capped run;
    // fails_when=the old file is overwritten or truncated;
    // no_claim=atomic writes under a crash (the writer uses tmp + rename, untested here).
    const file = path.join(dir, 'offers.json');
    await runRefresh(opts(makeSite(uniform(10, 1))));
    const before = readBytes(file);
    const r = await runRefresh(opts(makeSite(uniform(100, 1)), { maxRequests: 50 }));
    expect(r.exitCode).toBe(1);
    expect(readBytes(file).equals(before)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe('runRefresh guard (c) yield', () => {
  const holiday = (n: number, mk: (i: number) => Partial<FakeProgram>): FakeProgram[] =>
    range(n).map((oid, i) => ({ oid, hotels: 3, ...mk(i) }));

  it('fewer than 90% of holiday programs with an offer refuses, even with acceptDrop and on a first run', async () => {
    // protects=guard (c) offer yield: pages that load (200) but whose hotel markup changed stop the write;
    // fails_when=85% yield writes, acceptDrop overrides it, or exactly 90% is refused;
    // no_claim=the 90% threshold is right (estimate until the first full run).
    const noHotels = holiday(100, (i) => (i < 15 ? { hotelsMarkup: false } : {}));
    const r = await runRefresh(opts(makeSite(noHotels), { acceptDrop: true }));
    expect(r.exitCode).toBe(1);
    expect(r.summary).toContain('85.0% (85 of 100)');
    expect(r.summary).toContain('guard c: too few holiday programs yield an offer');
    expect(fs.existsSync(path.join(dir, 'offers.json'))).toBe(false);

    const edge = holiday(100, (i) => (i < 10 ? { hotelsMarkup: false } : {}));
    const ok = await runRefresh(opts(makeSite(edge)));
    expect(ok.exitCode).toBe(0);
    expect(ok.summary).toContain('90.0% (90 of 100)');
  });

  it('pages that load but have a changed layout (no program blocks at all) are refused', async () => {
    // protects=the redesign case: all 200, nothing parseable, first run (guard b has nothing to compare);
    // fails_when=an empty catalog is written;
    // no_claim=a redesign that keeps the block labels but moves the hotel list is caught only through the offer yield.
    const html = '<html><body><div class="new-layout">Алания</div></body></html>';
    const redesign = uniform(20, 2).map((p) => ({ ...p, html }));
    const r = await runRefresh(opts(makeSite(redesign)));
    expect(r.exitCode).toBe(1);
    expect(r.summary).toContain('guard c');
    expect(fs.existsSync(path.join(dir, 'offers.json'))).toBe(false);
  });
});

describe('runRefresh content rules', () => {
});

// ---------- seeds (D2) ----------

describe('seeds', () => {
  const sitemap = [
    '/', '/early_booking', '/pochivki_turcia_marmaris', '/early_booking/early_alanya',
    '/early_booking/early_alanya/view?oid=7',
    '/early_booking/early_kusadasi/prog-slug/marti-beach', // deep hotel page
    '/hotels', '/хотели-в-турция', '/' + encodeURIComponent('каталог-хотели'),
    '/early_booking/early_alanya/view/hotel?hid=1&oid=7',
    '/reservation_calc.html', '/images/a.jpg',
    '/air_x/view%3Foid%3D55', // the real sitemap percent-encodes the query separators
    '/new_year/hotel%3Fhid%3D1%26oid%3D2', // hotel page in the old URL style
  ];
  const xml = `<urlset>${sitemap.map((p) => `<url><loc>${p.startsWith('/хотели') ? ORIGIN + '/' + encodeURIComponent(p.slice(1)) : ORIGIN + p}</loc></url>`).join('')}</urlset>`;

  it('shallow seeds: homepage, listing URLs with at most 2 segments and every view?oid; exclusions applied', () => {
    // protects=the D2 seed rule and the exclusions (hotel catalog, hotel pages, images, reservation_calc);
    // fails_when=a 3-segment listing page, a hotel catalog page or a view/hotel URL becomes a seed;
    // no_claim=the 497 count on the real sitemap (the real sitemap was not crawled by this test).
    const seeds = buildSeeds(parseSitemapUrls(xml), false).map((s) => s.url.replace(ORIGIN, ''));
    expect(seeds).toEqual([
      '/',
      '/air_x/view?oid=55',
      '/early_booking',
      '/early_booking/early_alanya',
      '/early_booking/early_alanya/view?oid=7',
      '/pochivki_turcia_marmaris',
    ]);
  });
});

// ---------- scheduler ----------

function virtualTime() {
  let t = NOW.getTime();
  const sleepers: { wake: number; resolve: () => void }[] = [];
  const sleepCalls: number[] = [];
  return {
    now: () => new Date(t),
    ms: () => t,
    sleepCalls,
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      return new Promise<void>((resolve) => sleepers.push({ wake: t + ms, resolve }));
    },
    // Runs `p` to the end, advancing the clock to the earliest sleeper whenever everything is blocked.
    async drive<T>(p: Promise<T>): Promise<T> {
      let done = false;
      p.then(() => (done = true), () => (done = true));
      while (!done) {
        await new Promise((r) => setImmediate(r));
        if (done) break;
        if (sleepers.length) {
          sleepers.sort((a, b) => a.wake - b.wake);
          const s = sleepers.shift()!;
          t = Math.max(t, s.wake);
          s.resolve();
        }
      }
      return p;
    },
  };
}

describe('scheduler', () => {
  it('at most 3 requests in flight, and any 4 consecutive starts are at least 1000 ms apart', async () => {
    // protects=concurrency 3 and the 1 s start-to-start gap per slot (so at most 3 starts per second);
    // fails_when=a 4th request runs at once, any slot starts twice within 1000 ms, or the crawl is serialised (throughput check);
    // no_claim=real server-side timing: the clock and the fetcher are virtual.
    const vt = virtualTime();
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];
    const site = makeSite(uniform(30, 1));
    const fetchPage = async (url: string) => {
      starts.push(vt.ms());
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await vt.sleep(400); // the request takes 400 virtual ms
      inFlight--;
      return site.fetchPage(url);
    };
    const r = await vt.drive(runRefresh(opts({ ...site, fetchPage }, { sleep: vt.sleep, now: vt.now })));
    expect(r.exitCode).toBe(0);
    expect(maxInFlight).toBe(3);
    // starts[0] is the sitemap (a lone request); the rest run in the pool.
    const sorted = [...starts].sort((a, b) => a - b);
    for (let i = 0; i + 3 < sorted.length; i++) expect(sorted[i + 3] - sorted[i]).toBeGreaterThanOrEqual(1000);
    // 30 programs + sitemap + homepage + listing = 33 requests, 3 slots, 1 s each: about 11 s, not 33 s.
    expect(sorted[sorted.length - 1] - sorted[0]).toBeLessThan(14_000);
  });

  it('retries 429 and 5xx, honoring Retry-After over a shorter backoff, plus jitter', async () => {
    // protects=Retry-After being honored (30 s beats the 2 s backoff) and the jitter being added;
    // fails_when=the wait is shorter than the header, the header is ignored, or no jitter is added;
    // no_claim=the HTTP-date form of Retry-After (not tested).
    const vt = virtualTime();
    const site = makeSite(uniform(10, 1));
    let hits = 0;
    const fetchPage = async (url: string): Promise<FetchResult> => {
      if (url.endsWith('oid=1002')) {
        hits++;
        if (hits === 1) return { status: 429, body: '', retryAfter: '30' };
        if (hits === 2) return { status: 503, body: '' };
      }
      return site.fetchPage(url);
    };
    const r = await vt.drive(runRefresh(opts({ ...site, fetchPage }, { sleep: vt.sleep, now: vt.now, random: () => 0.5 })));
    expect(r.exitCode).toBe(0);
    expect(hits).toBe(3);
    const waits = vt.sleepCalls.filter((ms) => ms >= 2000);
    expect(waits).toEqual([30_250, 4250]);
  });
});

// ---------- stable writer (D5) ----------

describe('stable writer', () => {
  const base = (): Catalog => ({
    version: 1,
    scraped_at: '2026-11-05T10:00:00.000Z',
    source: 'https://www.orient99.com',
    programs: [
      { id: '10', kind: 'holiday', title: 'Б', url: `${ORIGIN}/a/view?oid=10`, destination: 'Алания', transport: 'plane', departure_city: 'София', nights: 7, days: 8, departure_dates: ['2027-06-01', '2027-06-08'], season: 'Лято 2027', image: null, from_price_eur: 500 },
      { id: '9', kind: 'cruise', title: 'А', url: `${ORIGIN}/c/view?oid=9`, destination: null, transport: null, departure_city: null, nights: null, days: null, departure_dates: [], season: 'unknown', image: null, from_price_eur: null },
    ],
    offers: [
      { program_id: '10', hotel_id: '200', hotel: 'B HOTEL', destination: 'Алания', region: 'Анталия', board: 'AI', board_raw: 'AI', from_price_eur: 600, url: `${ORIGIN}/h?hid=200&oid=10`, image: null },
      { program_id: '10', hotel_id: '30', hotel: 'A HOTEL', destination: 'Алания', region: 'Анталия', board: 'UAI', board_raw: 'UAI', from_price_eur: 611, url: `${ORIGIN}/h?hid=30&oid=10`, image: null },
      { program_id: '9', hotel_id: '1', hotel: 'C', destination: null, region: null, board: 'OTHER', board_raw: '', from_price_eur: null, url: `${ORIGIN}/h?hid=1&oid=9`, image: null },
    ],
  });

  it('writing the same catalog twice, from shuffled input, gives identical bytes in id order', () => {
    // protects=deterministic output regardless of crawl order (D5);
    // fails_when=two serialisations differ, or the order is by string instead of numeric id;
    // no_claim=a Windows and a Unix machine agree on the bytes of a written file (only the string is compared; LF is asserted).
    const a = serializeCatalog(base());
    const shuffled = base();
    shuffled.programs.reverse();
    shuffled.offers.reverse();
    expect(serializeCatalog(shuffled)).toBe(a);
    expect(a.indexOf('"id":"9"')).toBeLessThan(a.indexOf('"id":"10"'));
    expect(a.indexOf('"hotel_id":"1"')).toBeLessThan(a.indexOf('"hotel_id":"30"'));
    expect(a.indexOf('"hotel_id":"30"')).toBeLessThan(a.indexOf('"hotel_id":"200"'));
  });

  it('changing one offer changes exactly one line', () => {
    // protects=the weekly diff showing only what changed on the site;
    // fails_when=a one-offer change touches more than one line;
    // no_claim=reordering never changes the line count (sorting is by id).
    const a = serializeCatalog(base()).split('\n');
    const changed = base();
    changed.offers[1].from_price_eur = 640;
    const b = serializeCatalog(changed).split('\n');
    expect(b).toHaveLength(a.length);
    expect(b.filter((l, i) => l !== a[i])).toHaveLength(1);
  });
});
