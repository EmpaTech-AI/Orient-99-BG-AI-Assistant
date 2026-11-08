import { search } from './search';
import { Catalog, OfferRow, SearchOffersInput } from './types';
import fixtureJson = require('./__fixtures__/catalog-small.json');

const TODAY = '2026-11-04';
const fresh = (): Catalog => JSON.parse(JSON.stringify(fixtureJson)) as Catalog;
const CATALOG = fresh();
const run = (input: SearchOffersInput, today = TODAY, opts?: { limit?: number }, catalog = CATALOG) =>
  search(catalog, input, today, opts);
const hotels = (rows: OfferRow[]) => rows.map((r) => r.hotel);

describe('search: hotel match and unmet filters', () => {
  // protects=a bus request for a hotel that only flies is reported as the transport filter, not as "no hotel"; fails_when=rows are returned or unmet_filters is anything but ["transport"]; no_claim=the agent words the handover correctly
  it('bus request for a plane-only exact hotel gives rows [] and unmet_filters ["transport"]', () => {
    const r = run({ hotel: 'Камелия Селин', transport: 'bus' });
    expect(r.match).toBe('exact');
    expect(r.hotel).toBe('KAMELYA COLLECTION SENTIDO SELIN HOTEL');
    expect(r.rows).toEqual([]);
    expect(r.total_matching).toBe(0);
    expect(r.unmet_filters).toEqual(['transport']);
  });

  // protects=an exact hotel whose departures are all past is told apart from a filter miss; fails_when=unmet_filters is anything but ["past_dates"] or a row with a 2027 date appears; no_claim=past_dates is reported for hotels with no offers at all
  it('with today 2028-01-01 an exact hotel with only 2027 departures gives ["past_dates"]', () => {
    const r = run({ hotel: 'Лонисера' }, '2028-01-01');
    expect(r.match).toBe('exact');
    expect(r.rows).toEqual([]);
    expect(r.unmet_filters).toEqual(['past_dates']);
  });

  // protects=an exact hotel match is not narrowed by the destination text (Сиде vs Анталия); fails_when=the Selin row disappears when destination is Анталия or an unrelated place; no_claim=a destination alone finds the hotel
  it('hotel "Камелия Селин" with destination "Анталия" stays exact and rows are not filtered by destination', () => {
    for (const destination of ['Анталия', 'Кемер']) {
      const r = run({ hotel: 'Камелия Селин', destination });
      expect(r.match).toBe('exact');
      expect(r.matched_by).toBe('containment');
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].hotel).toBe('KAMELYA COLLECTION SENTIDO SELIN HOTEL');
      expect(r.rows[0].destination).toBe('Сиде');
    }
  });

  // protects=two different hotel_ids with the same name are never silently merged (R2-27); fails_when=either is returned as exact or rows come back; no_claim=the agent can tell the two apart
  it('two hotel_ids with identical names give approximate and no rows', () => {
    const c = fresh();
    c.offers.push({ ...c.offers.find((o) => o.hotel_id === '3016370'), hotel_id: '3099999', program_id: '2614151' });
    const r = run({ hotel: 'Лонисера Ресорт Спа' }, TODAY, undefined, c);
    expect(r.match).toBe('approximate');
    expect(r.matched_by).toBeUndefined();
    expect(r.hotel).toBeUndefined();
    expect(r.candidates.map((x) => x.hotel)).toEqual(['LONICERA RESORT & SPA', 'LONICERA RESORT & SPA']);
    expect(r.rows).toEqual([]);
    expect(r.total_matching).toBe(0);
    expect(r.unmet_filters).toBeUndefined();
  });

  // protects=no hotel input is reported as not_requested, not as a failed match; fails_when=match is none/exact or hotel fields appear; no_claim=the catalog holds rows for other filters
  it('no hotel input gives not_requested without hotel fields', () => {
    const r = run({});
    expect(r.match).toBe('not_requested');
    expect(r).not.toHaveProperty('hotel');
    expect(r).not.toHaveProperty('candidates');
    expect(r).not.toHaveProperty('matched_by');
    expect(r).not.toHaveProperty('unmet_filters');
    expect(r.today).toBe(TODAY);
    expect(r.catalog_scraped_at).toBe('2026-11-03T08:00:00.000Z');
  });
});

describe('search: past dates, dateless rows, budget', () => {
  // protects=a departure before today is never shown (Europe/Sofia today passed in); fails_when=any row date or nearest_departure is before today, or a still-future date is lost; no_claim=today itself is a bookable day
  it('departures before today never appear in any row', () => {
    const r = run({}, '2027-06-25', { limit: Infinity });
    for (const row of r.rows) {
      expect(row.departure_dates.every((d) => d >= '2027-06-25')).toBe(true);
      if (row.nearest_departure) expect(row.nearest_departure >= '2027-06-25').toBe(true);
    }
    const plane = run({ hotel: 'Лонисера', transport: 'plane' }, '2027-06-25');
    expect(plane.rows[0].departure_dates).toEqual(['2027-06-28', '2027-09-12', '2027-09-19', '2027-10-03']);
    expect(plane.rows[0].nearest_departure).toBe('2027-06-28');
  });

  // protects=a row without dates is kept, flagged dates_unknown and ordered last even when it is the cheapest; fails_when=it sorts ahead of a dated row, loses its flag, or a dated row gets the flag; no_claim=the agent mentions the missing dates
  it('a row without dates is kept with dates_unknown and ordered last', () => {
    const r = run({ destination: 'Алания' }, TODAY, { limit: Infinity });
    const last = r.rows[r.rows.length - 1];
    expect(last.hotel).toBe('DATELESS BEACH HOTEL');
    expect(last.flags).toEqual(['dates_unknown']);
    expect(last.nearest_departure).toBeNull();
    expect(last.departure_dates).toEqual([]);
    expect(r.rows.slice(0, -1).every((x) => !x.flags.includes('dates_unknown'))).toBe(true);
    // the dateless hotel is the cheapest (300) yet still last
    expect(last.link).toContain('hid=3019001');
  });

  // protects=a budget never filters: a budget under every price still returns rows, all flagged; fails_when=rows is empty or a row lacks over_budget; no_claim=any price is within a realistic budget
  it('a budget below every price still returns rows, all flagged over_budget', () => {
    const r = run({ hotel: 'Лонисера', budget_per_person_eur: 100 });
    expect(r.rows).toHaveLength(2);
    expect(r.rows.every((x) => x.flags.includes('over_budget'))).toBe(true);
  });
});

describe('search: departure_date, month, season_year', () => {
  // protects=an exact day that is not a departure returns the nearest real departures, centred on that day; fails_when=2027-09-15 appears, nearest is not 2027-09-14, or 2027-09-17 is missing; no_claim=other programs with the same date
  it('departure_date 2027-09-15 on program 2614151 gives nearest 2027-09-14 with 09-14 and 09-17 in the window', () => {
    const r = run({ hotel: 'Лонисера', transport: 'bus', departure_date: '2027-09-15' });
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row.link).toContain('oid=2614151');
    expect(row.nearest_departure).toBe('2027-09-14');
    expect(row.departure_dates).toHaveLength(12);
    expect(row.departure_dates).toContain('2027-09-14');
    expect(row.departure_dates).toContain('2027-09-17');
    expect(row.departure_dates).not.toContain('2027-09-15');
    expect([...row.departure_dates].sort()).toEqual(row.departure_dates);
  });

  // protects=month 9 with season 2027 starts at the first September departure and shows every September departure; fails_when=nearest is in August, or a September date is missing from the window; no_claim=the window is ideal for a client who named an exact day
  it('month 9 with season_year 2027 on program 2614151', () => {
    const r = run({ hotel: 'Лонисера', transport: 'bus', month: 9, season_year: 2027 });
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    const september = ['2027-09-03', '2027-09-06', '2027-09-10', '2027-09-14', '2027-09-17', '2027-09-20', '2027-09-24', '2027-09-27', '2027-09-30'];
    expect(row.nearest_departure).toBe('2027-09-03');
    expect(row.nearest_departure.startsWith('2027-08')).toBe(false);
    expect(row.departure_dates).toEqual(['2027-08-27', '2027-08-30', ...september, '2027-10-03']);
    for (const d of september) expect(row.departure_dates).toContain(d);
  });

  // protects=month alone is resolved relative to today: 11 is this November, 9 is next September; fails_when=month 11 matches November 2027 only, or month 9 matches a 2026 date; no_claim=the target month is stated back to the client
  it('with today 2026-11-04 month 11 targets November 2026 and month 9 targets September 2027', () => {
    const nov = run({ month: 11 }, TODAY, { limit: Infinity });
    expect(nov.total_matching).toBe(1);
    expect(nov.rows[0].title).toContain('Истанбул');
    expect(nov.rows[0].nearest_departure).toBe('2026-11-20');
    expect(nov.rows[0].departure_dates).toEqual(['2026-11-20', '2026-11-28', '2027-11-10']);
    const sep = run({ month: 9 }, TODAY, { limit: Infinity });
    expect(sep.total_matching).toBe(14);
    expect(sep.rows.every((x) => x.nearest_departure.startsWith('2027-09'))).toBe(true);
  });

  // protects=a row without dates fails a month filter but passes a season_year filter through its season text; fails_when=the dateless hotel appears for month 4, or is missing for season_year 2027; no_claim=the dateless row really departs in that month
  it('a row without dates fails a month filter and passes season_year by its season', () => {
    const month = run({ destination: 'Алания', month: 4, season_year: 2027 }, TODAY, { limit: Infinity });
    expect(hotels(month.rows)).not.toContain('DATELESS BEACH HOTEL');
    expect(month.rows.length).toBeGreaterThan(0);
    const year = run({ destination: 'Алания', season_year: 2027 }, TODAY, { limit: Infinity });
    expect(hotels(year.rows)).toContain('DATELESS BEACH HOTEL');
    const other = run({ destination: 'Алания', season_year: 2028 }, TODAY, { limit: Infinity });
    expect(other.rows).toEqual([]);
  });
});

describe('search: limit, filters, output shape', () => {
  // protects=the tool returns at most 8 rows while total_matching counts all; the oracle gets everything with Infinity; fails_when=more than 8 rows by default, a wrong total, or a truncated Infinity result; no_claim=8 is the right size for a chat reply
  it('default limit is 8 with the full total; limit Infinity returns all', () => {
    const def = run({});
    expect(def.rows).toHaveLength(8);
    expect(def.total_matching).toBe(17);
    const all = run({}, TODAY, { limit: Infinity });
    expect(all.rows).toHaveLength(17);
    expect(all.total_matching).toBe(17);
  });

  // protects=no amount is ever returned (design R2-24); fails_when=any key at any depth contains "price", including the internal ordering price; no_claim=prices are absent from the model's text reply
  it('no key anywhere in the result contains "price"', () => {
    const results = [run({}, TODAY, { limit: Infinity }), run({ hotel: 'Лонисера', budget_per_person_eur: 100 }), run({ hotel: 'Камелия' })];
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, child] of Object.entries(v)) {
          keys.push(k);
          walk(child);
        }
      }
    };
    results.forEach(walk);
    expect(keys.length).toBeGreaterThan(50);
    expect(keys.filter((k) => /price/i.test(k))).toEqual([]);
  });
});
