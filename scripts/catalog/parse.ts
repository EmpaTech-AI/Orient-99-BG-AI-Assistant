// Pure functions: orient99.com HTML -> catalog records. No network, no disk.
//
// Structure facts (checked on saved pages, 2026-11-05):
//  - program data sits in `.offer_icon` blocks, each with a `.content_title_top` label
//    (Локация / Транспорт / Продължителност / Дати на отпътуване / Маршрут);
//  - the hotel list is `#accommodation .offer_hotel_box`; the same boxes can appear a second
//    time further down the page, so rows are de-duplicated by hid;
//  - a hotel box holds the name, `.location_int`, `.food_text`, `.price_int` and a hotel link;
//  - a cruise page lists the ship as one hotel-like box; exotic destination (listing) pages hold
//    only cards (`.offer_box_int` without `offer_hotel_box`) that link to `view?oid=` pages.
import * as cheerio from 'cheerio';
import type {
  Board,
  HotelOffer,
  Program,
  ProgramKind,
  Transport,
} from '../../src/catalog/types';

export const SITE_ORIGIN = 'https://www.orient99.com';

// Length caps: scraped text reaches the model's context, so a hostile page must not be able to
// inject long text through a title or a hotel name.
export const MAX_TITLE_LEN = 200;
export const MAX_HOTEL_LEN = 120;
export const MAX_PLACE_LEN = 80;
export const MAX_BOARD_RAW_LEN = 40;
export const MAX_URL_LEN = 500;

export function cleanText(input: string | undefined | null, max: number): string {
  if (!input) return '';
  // eslint-disable-next-line no-control-regex
  const flat = input
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? chars.slice(0, max).join('').trim() : flat;
}

// ---------- small pure helpers ----------

export function absoluteUrl(href: string | undefined, base = SITE_ORIGIN): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    const s = u.toString();
    return s.length > MAX_URL_LEN ? null : s;
  } catch {
    return null;
  }
}

export function oidFromUrl(url: string): string | null {
  const m = /[?&]oid=(\d+)/.exec(url);
  return m ? m[1] : null;
}

export function kindFromUrl(url: string, hasHotelList: boolean): ProgramKind {
  let path = url;
  try {
    path = decodeURIComponent(new URL(url, SITE_ORIGIN).pathname).toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  if (path.includes('ekskurzii') || path.includes('екскурзии')) return 'excursion';
  if (path.includes('cruise') || path.includes('круиз')) return 'cruise';
  if (path.includes('exotica') || path.includes('екзотични')) return 'exotic';
  if (path.includes('early_booking') || path.includes('pochivki') || path.includes('holiday')) {
    return 'holiday';
  }
  return hasHotelList ? 'holiday' : 'excursion';
}

export function boardFromRaw(rawIn: string): Board {
  const raw = rawIn.replace(/\s+/g, ' ').trim().toUpperCase();
  switch (raw) {
    case 'RO':
    case 'OB':
    case 'САМО НОЩУВКА':
      return 'RO';
    case 'BB':
    case 'ЗАКУСКА':
      return 'BB';
    case 'HB':
    case 'ЗАКУСКА И ВЕЧЕРЯ':
      return 'HB';
    case 'FB':
      return 'FB';
    case 'AI':
    case 'ALL INCLUSIVE':
      return 'AI';
    case 'UAI':
    case 'ULTRA ALL INCLUSIVE':
      return 'UAI';
    default:
      return 'OTHER';
  }
}

export function transportFromRaw(raw: string | null): Transport | null {
  if (!raw) return null;
  const t = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  if (t === 'самолет') return 'plane';
  if (t === 'автобус') return 'bus';
  if (t === 'собствен транспорт') return 'own';
  return null; // "Кораб" and anything unknown
}

export function seasonFrom(title: string, departureDates: string[]): string {
  const years = new Set<string>();
  for (const m of title.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)) years.add(m[1]);
  if (years.size === 1) {
    const [y] = [...years];
    return /лято\s+20\d{2}/i.test(title) ? `Лято ${y}` : y;
  }
  // No year, or several distinct years, in the title: use the dates when they share one year.
  const dateYears = new Set(departureDates.map((d) => d.slice(0, 4)));
  if (dateYears.size === 1) return [...dateYears][0];
  return 'unknown';
}

function parseIsoDates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(\d{2})\.(\d{2})\.(\d{4})/g)) {
    const [, dd, mm, yyyy] = m;
    const d = Number(dd);
    const mo = Number(mm);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const iso = `${yyyy}-${mm}-${dd}`;
    const check = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) continue;
    out.add(iso);
  }
  return [...out].sort();
}

function parseInt10(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseDuration(text: string): { days: number | null; nights: number | null } {
  const both = /(\d+)\s*(?:дни|ден|дн\.?)\s*\/\s*(\d+)\s*нощ/i.exec(text);
  if (both) return { days: parseInt10(both[1]), nights: parseInt10(both[2]) };
  const daysOnly = /(\d+)\s*(?:дни|ден|дн\.?)/i.exec(text);
  return { days: daysOnly ? parseInt10(daysOnly[1]) : null, nights: null };
}

function parsePrice(text: string): number | null {
  // "от 611 €", "Цена от: 506 €", with an optional space as thousands separator.
  const m = /(\d[\d\s]*)/.exec(text.replace(/ /g, ' '));
  if (!m) return null;
  const n = Number.parseInt(m[1].replace(/\s+/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function splitLocation(raw: string): { destination: string | null; region: string | null } {
  const parts = cleanText(raw, MAX_PLACE_LEN * 2)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    destination: parts[0] ? cleanText(parts[0], MAX_PLACE_LEN) : null,
    region: parts[1] ? cleanText(parts[1], MAX_PLACE_LEN) : null,
  };
}

function imageUrl(src: string | undefined): string | null {
  if (!src) return null;
  // The site sometimes writes "…/images/https://host/…": keep the inner absolute URL.
  const inner = src.lastIndexOf('https://');
  const candidate = inner > 0 ? src.slice(inner) : src;
  if (/px\.gif/i.test(candidate)) return null;
  return absoluteUrl(candidate);
}

function mostCommon(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && v < best)) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

// ---------- program page ----------

interface Blocks {
  [label: string]: string;
}

function readBlocks($: cheerio.CheerioAPI): Blocks {
  const blocks: Blocks = {};
  $('.offer_icon').each((_, el) => {
    const label = cleanText($(el).find('.content_title_top').first().text(), 40);
    if (!label || label in blocks) return;
    const clone = $(el).clone();
    clone.find('.content_title_top').remove();
    blocks[label] = clone.text();
  });
  return blocks;
}

export interface ParsedProgram {
  program: Program;
  offers: HotelOffer[];
}

interface HotelBox {
  hotel_id: string;
  hotel: string;
  destination: string | null;
  region: string | null;
  board_raw: string;
  from_price_eur: number | null;
  url: string;
  image: string | null;
}

function readHotelBoxes($: cheerio.CheerioAPI): HotelBox[] {
  const scope = $('#accommodation .offer_hotel_box');
  const boxes = scope.length > 0 ? scope : $('.offer_hotel_box');
  const seen = new Set<string>();
  const out: HotelBox[] = [];
  boxes.each((_, el) => {
    const box = $(el);
    const link = box.find('.offer_title_int a').first();
    const href = link.attr('href') ?? box.find('a[href*="hid="]').first().attr('href');
    const hid = href ? /[?&]hid=(\d+)/.exec(href)?.[1] : undefined;
    const url = absoluteUrl(href);
    if (!hid || !url || seen.has(hid)) return;
    const name = cleanText(link.text() || link.attr('title'), MAX_HOTEL_LEN);
    if (!name) return;
    seen.add(hid);
    const { destination, region } = splitLocation(box.find('.location_int').first().text());
    const boardRaw = cleanText(
      box.find('.food_text').first().text().replace(/Вид хранене:?/i, ''),
      MAX_BOARD_RAW_LEN,
    );
    const priceText = box.find('.price_int').first().text();
    out.push({
      hotel_id: hid,
      hotel: name,
      destination,
      region,
      board_raw: boardRaw,
      from_price_eur: /от/i.test(priceText) ? parsePrice(priceText) : null,
      url,
      image: imageUrl(
        box.find('.offer_img_int img').first().attr('data-src') ??
          box.find('.offer_img_int img').first().attr('src'),
      ),
    });
  });
  return out;
}

/**
 * Parses one program page. Returns null when the page is not a program (no "Продължителност"
 * and no "Дати на отпътуване" block), so listing pages and error pages never become rows.
 */
export function parseProgramPage(html: string, url: string): ParsedProgram | null {
  const $ = cheerio.load(html);
  const blocks = readBlocks($);
  if (!('Продължителност' in blocks) && !('Дати на отпътуване' in blocks)) return null;

  const id = oidFromUrl(url) ?? oidFromUrl($('meta[property="og:url"]').attr('content') ?? '');
  if (!id) return null;

  const title = cleanText(
    $('title').first().text() || $('meta[property="og:title"]').attr('content') || $('h1').first().text(),
    MAX_TITLE_LEN,
  );
  if (!title) return null;

  const boxes = readHotelBoxes($);
  const kind = kindFromUrl(url, boxes.length > 0);
  const { days, nights } = parseDuration(blocks['Продължителност'] ?? '');
  const departureDates = parseIsoDates(blocks['Дати на отпътуване'] ?? '');
  const route = cleanText(blocks['Маршрут'], 200);
  const departureCity = route
    ? cleanText(route.split(/\s+-\s+|\s*[–—]\s*/)[0], MAX_PLACE_LEN) || null
    : null;
  const locationBlock = splitLocation(blocks['Локация'] ?? '');

  // Only holiday programs carry hotel rows. A cruise page lists the ship as one hotel-like box;
  // that stays a program row.
  const hotelRows = kind === 'holiday' ? boxes : [];
  const offers: HotelOffer[] = hotelRows.map((b) => ({
    program_id: id,
    hotel_id: b.hotel_id,
    hotel: b.hotel,
    destination: b.destination,
    region: b.region,
    board: boardFromRaw(b.board_raw),
    board_raw: b.board_raw,
    from_price_eur: b.from_price_eur,
    url: b.url,
    image: b.image,
  }));

  const destination =
    offers.length > 0
      ? mostCommon(offers.map((o) => o.destination)) ?? locationBlock.destination
      : locationBlock.destination;

  const programImage =
    (offers.length > 0 ? offers[0].image : null) ??
    imageUrl($('meta[property="og:image"]').attr('content')) ??
    (boxes[0]?.image ?? null);

  const priceBlock = $('#content_price').text();
  const program: Program = {
    id,
    kind,
    title,
    url,
    destination,
    transport: transportFromRaw(blocks['Транспорт'] ? cleanText(blocks['Транспорт'], 60) : null),
    departure_city: departureCity,
    nights,
    days,
    departure_dates: departureDates,
    season: seasonFrom(title, departureDates),
    image: programImage,
    from_price_eur: /\d/.test(priceBlock) ? parsePrice(priceBlock) : null,
  };
  return { program, offers };
}

// ---------- listing pages ----------

/** Absolute program URLs (`…/view?oid=N`, not `view/hotel`) in page order, one per oid. */
export function extractProgramLinks(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: string[] = [];
  $('a[href]').each((_, el) => {
    const abs = absoluteUrl($(el).attr('href'), pageUrl);
    if (!abs) return;
    let u: URL;
    try {
      u = new URL(abs);
    } catch {
      return;
    }
    if (u.hostname !== 'www.orient99.com' && u.hostname !== 'orient99.com') return;
    if (!/\/view(\.html)?$/.test(u.pathname)) return; // excludes /view/hotel
    const oid = u.searchParams.get('oid');
    if (!oid || !/^\d+$/.test(oid) || seen.has(oid)) return;
    seen.add(oid);
    out.push(`${SITE_ORIGIN}${u.pathname}?oid=${oid}`);
  });
  return out;
}

export interface ListingCard {
  id: string;
  url: string;
  title: string;
  location: string | null;
  transport: Transport | null;
  days: number | null;
  nights: number | null;
  image: string | null;
  from_price_eur: number | null;
}

/**
 * Cards on listing pages (cruise, excursion, exotic) that link to a program page. Used only as a
 * fallback when the program page itself has none of the program blocks.
 */
export function parseListingCards(html: string, pageUrl: string): ListingCard[] {
  const $ = cheerio.load(html);
  const out: ListingCard[] = [];
  const seen = new Set<string>();
  $('.offer_box_int').each((_, el) => {
    const box = $(el);
    if (box.hasClass('offer_hotel_box')) return;
    const link = box.find('.offer_title_int a').first();
    const url = absoluteUrl(link.attr('href'), pageUrl);
    const id = url ? oidFromUrl(url) : null;
    if (!url || !id || seen.has(id) || /\/view\/hotel/.test(url)) return;
    const title = cleanText(link.text() || link.attr('title'), MAX_TITLE_LEN);
    if (!title) return;
    seen.add(id);
    const icon = box.find('.transport_int i').first().attr('class') ?? '';
    const dur = parseDuration(box.find('.days_int').first().text());
    const priceText = box.find('.price_int').first().text();
    out.push({
      id,
      url: `${SITE_ORIGIN}${new URL(url).pathname}?oid=${id}`,
      title,
      location: cleanText(box.find('.location_int').first().text(), MAX_PLACE_LEN * 2) || null,
      transport: /fa-plane/.test(icon) ? 'plane' : /fa-bus/.test(icon) ? 'bus' : null,
      days: dur.days,
      nights: dur.nights,
      image: imageUrl(box.find('.offer_img_int img').first().attr('data-src')),
      from_price_eur: /от/i.test(priceText) ? parsePrice(priceText) : null,
    });
  });
  return out;
}

/**
 * A program row built from a listing card. Departure dates stay empty: the card shows only the
 * first date ("Дати от:"), and a partial list would read as the full list.
 */
export function programFromCard(card: ListingCard): Program | null {
  const kind = kindFromUrl(card.url, false);
  if (kind === 'holiday') return null;
  return {
    id: card.id,
    kind,
    title: card.title,
    url: card.url,
    destination: card.location ? splitLocation(card.location).destination : null,
    transport: card.transport,
    departure_city: null,
    nights: card.nights,
    days: card.days,
    departure_dates: [],
    season: seasonFrom(card.title, []),
    image: card.image,
    from_price_eur: card.from_price_eur,
  };
}
