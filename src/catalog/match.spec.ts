import { ALIASES, HotelRef, hotelNames, matchHotel } from './match';
import hotels = require('./__fixtures__/hotel-names.json');

const HOTELS = hotels as HotelRef[];
const ids = (name: string) => HOTELS.filter((h) => h.hotel === name).map((h) => h.hotel_id);

describe('matchHotel: the 10 fixed cases', () => {
  const cases: [string, string, 'containment' | 'key' | 'alias', string][] = [
    ['Лонисера', 'LONICERA RESORT & SPA', 'key', '1'],
    ['Лонисера Ресорт спа Алания', 'LONICERA RESORT & SPA', 'containment', '2'],
    ['Lonicera resort and spa', 'LONICERA RESORT & SPA', 'containment', '3'],
    ['Камелия Селин', 'KAMELYA COLLECTION SENTIDO SELIN HOTEL', 'containment', '4'],
    ['Утопия Ризорт', 'UTOPIA RESORT & RESIDENCE', 'containment', '6'],
    ['Клеопатра Бийч', 'KLEOPATRA BEACH', 'key', '7'],
    ['Хайдарпаша Палас', 'HAYDARPASHA PALACE', 'containment', '8'],
    ['Юстиниано Клуб Парк Конти', 'JUSTINIANO CLUB PARK CONTI', 'containment', '9'],
    ['Озкаймак Инджекум', 'OZKAYMAK INCEKUM', 'alias', '10'],
  ];

  // protects=the hotel the client named is the hotel returned, with the rule that decided it; fails_when=a wrong hotel, an approximate result instead of exact, or the wrong matched_by comes back; no_claim=the live catalog has the same names
  it.each(cases)('query %s -> exact %s by %s (case %s)', (query, hotel, by) => {
    const r = matchHotel(query, HOTELS, ALIASES);
    expect(r.match).toBe('exact');
    expect(r.matched_by).toBe(by);
    expect(r.hotel).toBe(hotel);
    expect(r.hotel_id).toBe(ids(hotel)[0]);
  });

  // protects=a brand shared by 4 hotels is never presented as one of them; fails_when=Камелия returns exact, or the Selin hotel is missing from the candidates; no_claim=candidate order is the best possible order for a client
  it('case 5: Камелия is approximate and lists the Selin hotel among the candidates', () => {
    const r = matchHotel('Камелия', HOTELS, ALIASES);
    expect(r.match).toBe('approximate');
    expect(r.matched_by).toBeUndefined();
    expect(r.candidates.map((c) => c.hotel)).toContain('KAMELYA COLLECTION SENTIDO SELIN HOTEL');
    expect(r.candidates).toHaveLength(4);
  });
});

describe('matchHotel: the 7 additional cases', () => {
  const exactCases: [string, string, 'containment' | 'key' | 'alias'][] = [
    ['Лонисера Уърлд', 'LONICERA WORLD HOTEL', 'alias'],
    ['хотел Лонисера', 'LONICERA RESORT & SPA', 'key'],
    ['Сафир Ризорт', 'SAPHIR RESORT & SPA HOTEL', 'containment'],
    ['Делфин Ботаник Платинум', 'DELPHIN BOTANIK PLATINUM', 'containment'],
    ['Ефталия Сплаш', 'EFTALIA SPLASH RESORT', 'containment'],
  ];

  // protects=alias, HOTEL-dropping, generic narrowing and multi-token containment give the right hotel; fails_when=a different hotel or the wrong matched_by; no_claim=every other brand in the catalog resolves
  it.each(exactCases)('%s -> exact %s by %s', (query, hotel, by) => {
    const r = matchHotel(query, HOTELS, ALIASES);
    expect(r.match).toBe('exact');
    expect(r.matched_by).toBe(by);
    expect(r.hotel).toBe(hotel);
  });

  // protects=a query holding only the word hotel names no hotel; fails_when=any hotel or candidate is returned; no_claim=other empty queries (digits, punctuation) behave the same
  it('"хотел" -> none', () => {
    const r = matchHotel('хотел', HOTELS, ALIASES);
    expect(r.match).toBe('none');
    expect(r.matched_by).toBeUndefined();
    expect(r.candidates).toBeUndefined();
  });

  // protects=a half-right name still shows the closest hotel as a candidate, never as exact; fails_when=exact is returned or HAYDARPASHA PALACE is missing; no_claim=Ксилофон is a real hotel word
  it('"Ксилофон Палас" -> approximate with HAYDARPASHA PALACE among the candidates', () => {
    const r = matchHotel('Ксилофон Палас', HOTELS, ALIASES);
    expect(r.match).toBe('approximate');
    expect(r.matched_by).toBeUndefined();
    expect(r.candidates.map((c) => c.hotel)).toContain('HAYDARPASHA PALACE');
    expect(r.candidates.length).toBeLessThanOrEqual(5);
  });
});

describe('key rules', () => {

  // protects=the (EX. ...) name is a second name of the same hotel and other brackets are dropped; fails_when=the EX name is lost, brackets leak into the main name, or the spacing variants are not read; no_claim=a hotel with several EX parts keeps all of them
  it('splits (EX. ...) into a second name and drops other brackets', () => {
    expect(hotelNames('KAIA CORACESIUM (EX.VILLA SUNFLOWER BEACH HOTEL)')).toEqual(['KAIA CORACESIUM', 'VILLA SUNFLOWER BEACH HOTEL']);
    expect(hotelNames('CALIDO SOL HOTEL ( EX. STELLA BEACH )')).toEqual(['CALIDO SOL HOTEL', 'STELLA BEACH']);
    expect(hotelNames('SOLIVIA HOTEL (ex. TITAN SELECT)')).toEqual(['SOLIVIA HOTEL', 'TITAN SELECT']);
    expect(hotelNames('SOMETHING (NEW WING) RESORT')).toEqual(['SOMETHING RESORT']);
  });

  // protects=fuzzy equality (edit distance 1, 5+ letters) only widens the candidate list; fails_when=a one-letter typo returns exact, or is not offered as a candidate; no_claim=the fuzzy rule finds typos of 4-letter words
  it('fuzzy tokens appear only in candidates, never as an exact match', () => {
    const r = matchHotel('Lonicira', HOTELS, ALIASES);
    expect(r.match).toBe('approximate');
    expect(r.candidates.map((c) => c.hotel)).toContain('LONICERA RESORT & SPA');
  });
});
