import { getCatalog } from '../catalog/load';
import { search, validateInput } from '../catalog/search';
import { BOARDS, PROGRAM_KINDS, SearchOffersError, SearchOffersResult, TRANSPORTS } from '../catalog/types';

export const search_offers_config = {
  type: 'function',
  name: 'search_offers',
  description:
    "Search Orient99's current offers (hotel holidays, excursions, cruises, exotic trips). Call it before naming any offer, hotel, date or link. " +
    "Put only the hotel's name in `hotel` (no destination, no words like hotel/resort needed) and the place in `destination`. " +
    'Omit inputs the client did not give. Dates are yyyy-mm-dd. ' +
    'The dates returned are program departure dates, not hotel availability.',
  parameters: {
    type: 'object',
    properties: {
      hotel: { type: 'string' },
      destination: { type: 'string' },
      transport: { type: 'string', enum: [...TRANSPORTS] },
      season_year: { type: 'integer' },
      month: { type: 'integer', minimum: 1, maximum: 12 },
      departure_date: { type: 'string', description: 'yyyy-mm-dd; orders results by the nearest departure, never filters' },
      nights: { type: 'integer' },
      board: { type: 'string', enum: BOARDS.filter((b) => b !== 'OTHER') },
      budget_per_person_eur: { type: 'number' },
      kind: { type: 'string', enum: [...PROGRAM_KINDS] },
    },
    required: [],
  },
  strict: false,
};

// yyyy-mm-dd in Europe/Sofia.
export function sofiaToday(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
}

// Never throws: a bad argument or a missing catalog comes back as an error object
// the model can act on (D4).
export async function search_offers(
  args: unknown,
  _context?: unknown,
  deps: { today?: string } = {},
): Promise<SearchOffersResult | SearchOffersError> {
  const started = Date.now();
  const logInput = (() => {
    try {
      return JSON.stringify(args ?? {});
    } catch {
      return '"[unserialisable]"';
    }
  })();
  const finish = <T>(out: T, summary: string): T => {
    console.log(`[search_offers] input=${logInput} ${summary} ms=${Date.now() - started}`);
    return out;
  };

  try {
    const catalog = getCatalog();
    if (!catalog) return finish<SearchOffersError>({ error: 'catalog_unavailable' }, 'error=catalog_unavailable');
    const checked = validateInput(args);
    if (checked.ok === false) return finish<SearchOffersError>(checked.error, `error=invalid_input fields=${(checked.error.fields || []).join(',')}`);
    const result = search(catalog, checked.input, deps.today ?? sofiaToday());
    return finish(result, `match=${result.match} total=${result.total_matching}`);
  } catch (e) {
    console.log(`[search_offers] unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    return { error: 'catalog_unavailable' };
  }
}
