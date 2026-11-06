// Parser tests on trimmed copies of real orient99.com pages (src/catalog/__fixtures__/program-*.html).
// program-exotic-listing-kenia.html is a trimmed real listing page.
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_HOTEL_LEN,
  MAX_TITLE_LEN,
  boardFromRaw,
  cleanText,
  kindFromUrl,
  parseListingCards,
  parseProgramPage,
  programFromCard,
  seasonFrom,
} from '../../scripts/catalog/parse';
import { BOARDS } from './types';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');
const U = 'https://www.orient99.com';

describe('parseProgramPage on real holiday fixtures', () => {
  const plane = parseProgramPage(fixture('program-2865428.html'), `${U}/early_booking/early_alanya/view?oid=2865428`)!;
  const bus = parseProgramPage(fixture('program-2614151.html'), `${U}/early_booking/early_alanya/view?oid=2614151`)!;

  it('plane program 2865428: header fields', () => {
    // protects=transport, nights, days, departure city and season read from the program blocks;
    // fails_when=a field is read from the wrong block, the title season rule breaks, or the kind is not holiday;
    // no_claim=the live page still looks like this fixture (it is a trimmed copy saved 2026-11-04).
    expect(plane).not.toBeNull();
    const p = plane.program;
    expect(p.id).toBe('2865428');
    expect(p.kind).toBe('holiday');
    expect(p.transport).toBe('plane');
    expect(p.nights).toBe(7);
    expect(p.days).toBe(8);
    expect(p.departure_city).toBe('София');
    expect(p.season).toBe('Лято 2027');
    expect(p.destination).toBe('Алания');
    expect(p.from_price_eur).toBe(506);
    expect(p.departure_dates).toHaveLength(31);
    expect(p.departure_dates[0]).toBe('2027-04-04');
  });

  it('plane program 2865428: 96 hotels, 95 in Алания and 1 in Сиде, no duplicates from the repeated list', () => {
    // protects=the hotel count and the destination split of the offers (the spec's 95/2 was a double count of a repeated list);
    // fails_when=the second copy of the hotel list is counted again (192 rows) or a hotel loses its location;
    // no_claim=the 96 are all hotels the client can book today.
    expect(plane.offers).toHaveLength(96);
    expect(new Set(plane.offers.map((o) => o.hotel_id)).size).toBe(96);
    expect(plane.offers.filter((o) => o.destination === 'Алания')).toHaveLength(95);
    const side = plane.offers.filter((o) => o.destination === 'Сиде');
    expect(side).toHaveLength(1);
    expect(side[0].region).toBe('Анталия');
    expect(plane.offers.every((o) => o.program_id === '2865428')).toBe(true);
  });

  it('LONICERA RESORT & SPA row: id, board, price, location and link', () => {
    // protects=the row the whole feature is about (ISSUE-001);
    // fails_when=hid, board, price, location or the hotel link is taken from a neighbouring box;
    // no_claim=that the price is current: it is "от" price at fixture time and is never shown to clients.
    const lon = plane.offers.find((o) => o.hotel_id === '3016370')!;
    expect(lon.hotel).toBe('LONICERA RESORT & SPA');
    expect(lon.board).toBe('UAI');
    expect(lon.board_raw).toBe('UAI');
    expect(lon.from_price_eur).toBe(611);
    expect(lon.destination).toBe('Алания');
    expect(lon.region).toBe('Анталия');
    expect(lon.url).toBe(`${U}/early_booking/early_alanya/view/hotel?hid=3016370&oid=2865428`);
  });

  it('bus program 2614151: transport, nights, days and the September 2027 departures', () => {
    // protects=the 65 departure dates, their ISO format/order, and the 14.09 / 17.09 vs 15.09 distinction the replay depends on;
    // fails_when=dates are lost, duplicated, unsorted, or 2027-09-15 appears;
    // no_claim=hotel-level availability: the hotel's own price table can lack 1-4 of these dates.
    const p = bus.program;
    expect(p.transport).toBe('bus');
    expect(p.nights).toBe(7);
    expect(p.days).toBe(10);
    expect(p.departure_city).toBe('София');
    expect(p.season).toBe('Лято 2027');
    expect(p.departure_dates).toHaveLength(65);
    expect(p.departure_dates).toContain('2027-09-14');
    expect(p.departure_dates).toContain('2027-09-17');
    expect(p.departure_dates).not.toContain('2027-09-15');
    expect([...p.departure_dates].sort()).toEqual(p.departure_dates);
    expect(new Set(p.departure_dates).size).toBe(65);
    expect(bus.offers.find((o) => o.hotel_id === '3016370')?.hotel).toBe('LONICERA RESORT & SPA');
    expect(bus.offers).toHaveLength(90);
  });
});

describe('parseProgramPage on cruise, exotic and excursion pages', () => {
  it('cruise 24583: a program row, transport null, no route, one date, no hotel offers', () => {
    // protects=the cruise being a Program with hotel offers absent, "Кораб" -> null and a missing "Маршрут" -> null;
    // fails_when=the ship becomes a HotelOffer, "Кораб" is guessed as a transport, or the route is invented;
    // no_claim=other cruise pages share this layout (one cruise was saved).
    const r = parseProgramPage(fixture('program-cruise-24583.html'), `${U}/cruises/view?oid=24583`)!;
    expect(r.offers).toEqual([]);
    expect(r.program.kind).toBe('cruise');
    expect(r.program.transport).toBeNull();
    expect(r.program.departure_city).toBeNull();
    expect(r.program.nights).toBe(8);
    expect(r.program.days).toBe(9);
    expect(r.program.departure_dates).toEqual(['2027-07-03']);
    expect(r.program.season).toBe('2027');
    expect(r.program.from_price_eur).toBe(2160);
    expect(r.program.destination).toBe('Копенхаген');
    expect(r.program.image).toBe(
      `${U}/static/108/images/NORVEJKI-FIORDI-APOLLO/kruiz-norvejki-fiordi-05-07-2024-apollo-fiordi-3-.jpg`,
    );
  });

  it('a card becomes an exotic program row with no departure dates (the card shows only the first date)', () => {
    // protects=the fallback when an exotic program page has none of the program blocks: a row exists, dates stay empty;
    // fails_when=the single "Дати от" date is stored as the full date list, or the row gets hotel offers;
    // no_claim=real exotic program pages need this fallback (unknown until the first full run).
    const card = parseListingCards(fixture('program-exotic-listing-kenia.html'), `${U}/exotica/exotc_kenia`)[0];
    const p = programFromCard(card)!;
    expect(p.kind).toBe('exotic');
    expect(p.departure_dates).toEqual([]);
    expect(p.season).toBe('2026');
    expect(p.destination).toBe('Кигали');
    expect(programFromCard({ ...card, url: `${U}/early_booking/early_alanya/view?oid=77318` })).toBeNull();
  });
});

describe('field rules', () => {
  it('board mapping covers every documented spelling and everything else is OTHER', () => {
    // protects=the board enum mapping, case-insensitive, with the Bulgarian labels;
    // fails_when=a documented spelling maps to the wrong code or an unknown one is guessed;
    // no_claim=these are all the spellings the site uses.
    const cases: [string, string][] = [
      ['RO', 'RO'], ['OB', 'RO'], ['Само нощувка', 'RO'],
      ['BB', 'BB'], ['Закуска', 'BB'],
      ['HB', 'HB'], ['Закуска и вечеря', 'HB'],
      ['FB', 'FB'],
      ['AI', 'AI'], ['ALL INCLUSIVE', 'AI'], ['All Inclusive', 'AI'],
      ['UAI', 'UAI'], ['ULTRA ALL INCLUSIVE', 'UAI'],
      ['PLAI', 'OTHER'], ['', 'OTHER'], ['UAIP', 'OTHER'],
    ];
    for (const [raw, want] of cases) expect(boardFromRaw(raw)).toBe(want);
    for (const raw of ['RO', 'AI', 'xyz']) expect(BOARDS).toContain(boardFromRaw(raw));
  });

  it('season rule: one title year wins, then the dates, else unknown', () => {
    // protects=the three-step season rule, including "the title wins over price-table dates";
    // fails_when=dates override a title year, two title years pick one, or mixed-year dates pick a year;
    // no_claim=a season label is correct for the offer on sale.
    expect(seasonFrom('Лято 2027 - Алания', ['2026-12-01'])).toBe('Лято 2027');
    expect(seasonFrom('Круиз 03.07.2027', [])).toBe('2027');
    expect(seasonFrom('Почивка', ['2027-05-01', '2027-06-01'])).toBe('2027');
    expect(seasonFrom('Почивка', ['2026-12-28', '2027-01-04'])).toBe('unknown');
    expect(seasonFrom('Нова година 2026 / 2027', ['2026-12-28'])).toBe('2026');
    expect(seasonFrom('Почивка', [])).toBe('unknown');
    expect(seasonFrom('Лято 12027', [])).toBe('unknown');
  });

  it('kind rules run in order, first match wins, and the fallback depends on the hotel list', () => {
    // protects=the URL based kind order (excursion, cruise, exotic, holiday, fallback) after percent-decoding;
    // fails_when=a later rule wins over an earlier one or the fallback ignores the hotel list;
    // no_claim=every real site path is covered.
    expect(kindFromUrl(`${U}/ekskurzii/cruise_x/view?oid=1`, true)).toBe('excursion');
    expect(kindFromUrl(`${U}/cruises/view?oid=1`, false)).toBe('cruise');
    expect(kindFromUrl(`${U}/${encodeURIComponent('круизи')}/view?oid=1`, false)).toBe('cruise');
    expect(kindFromUrl(`${U}/${encodeURIComponent('екскурзии')}/x/view?oid=1`, false)).toBe('excursion');
    expect(kindFromUrl(`${U}/exotica/exotc_kenia/view?oid=1`, true)).toBe('exotic');
    expect(kindFromUrl(`${U}/early_booking/early_alanya/view?oid=1`, false)).toBe('holiday');
    expect(kindFromUrl(`${U}/pochivki_turcia_marmaris/view?oid=1`, false)).toBe('holiday');
    expect(kindFromUrl(`${U}/something/view?oid=1`, true)).toBe('holiday');
    expect(kindFromUrl(`${U}/something/view?oid=1`, false)).toBe('excursion');
  });

  it('length caps and control characters: a hostile title and hotel name cannot inject long text', () => {
    // protects=the caps on title and hotel name (they reach the model's context) and removal of control characters;
    // fails_when=a 5,000 character title or hotel name, or a newline-carrying name, survives parsing;
    // no_claim=the text is safe from prompt injection: a short hostile sentence still passes.
    const long = 'A'.repeat(5000);
    const html = `<html><head><title>Лято 2027 ${long}</title></head><body>
      <div class="offer_icon"><span class="content_title_top">Продължителност</span><br>8 дни / 7 нощувки</div>
      <div id="accommodation"><div class="offer_box_int offer_hotel_box"><div class="offer_title_int">
      <a href="/early_booking/x/view/hotel?hid=1&oid=5">HOTEL\nIGNORE\u0000 ${long}</a></div></div></div></body></html>`;
    const r = parseProgramPage(html, `${U}/early_booking/x/view?oid=5`)!;
    expect(Array.from(r.program.title).length).toBeLessThanOrEqual(MAX_TITLE_LEN);
    expect(Array.from(r.offers[0].hotel).length).toBeLessThanOrEqual(MAX_HOTEL_LEN);
    expect(r.offers[0].hotel).not.toMatch(/[\n\u0000]/);
    expect(cleanText('a b​c\t d', 50)).toBe('a b c d');
  });
});
