// Shared catalog types. No dependencies: used by the scraper (scripts/catalog),
// the search (src/catalog) and the replay oracle (test/).

export const TRANSPORTS = ['plane', 'bus', 'own'] as const;
export type Transport = (typeof TRANSPORTS)[number];

// Single source of truth for board codes. The tool enum, the parser mapping and
// the prompt labels in instructions.ts all derive from or are checked against it.
export const BOARDS = ['RO', 'BB', 'HB', 'FB', 'AI', 'UAI', 'OTHER'] as const;
export type Board = (typeof BOARDS)[number];

export const PROGRAM_KINDS = ['holiday', 'excursion', 'cruise', 'exotic'] as const;
export type ProgramKind = (typeof PROGRAM_KINDS)[number];

export interface Catalog {
  version: 1;
  scraped_at: string; // ISO 8601, UTC
  source: 'https://www.orient99.com';
  programs: Program[];
  offers: HotelOffer[]; // hotel rows; excursions/cruises/exotic programs have none
}

export interface Program {
  id: string; // the oid from the program URL
  kind: ProgramKind;
  title: string; // exactly as on the site
  url: string; // program page URL, absolute, as fetched
  destination: string | null; // most common hotel location (first part); null for programs without hotels
  transport: Transport | null;
  departure_city: string | null; // first segment of "Маршрут"
  nights: number | null;
  days: number | null;
  departure_dates: string[]; // ISO yyyy-mm-dd, sorted, unique; past dates kept here
  season: string; // "Лято 2027" / "2027" / "unknown"
  image: string | null;
  from_price_eur: number | null; // only used for programs without hotel rows
}

export interface HotelOffer {
  program_id: string;
  hotel_id: string; // the hid from the hotel offer URL
  hotel: string; // Latin, exactly as on the site, "(EX. …)" part included
  destination: string | null; // first part of the location line
  region: string | null; // second part
  board: Board;
  board_raw: string;
  from_price_eur: number | null; // ranking only, never returned by the tool
  url: string; // hotel offer link, absolute
  image: string | null;
}

// ---- search_offers contract (Part 2) ----

export interface SearchOffersInput {
  hotel?: string;
  destination?: string;
  transport?: Transport;
  season_year?: number;
  month?: number;
  departure_date?: string; // yyyy-mm-dd; orders results, never filters
  nights?: number;
  board?: Exclude<Board, 'OTHER'>;
  budget_per_person_eur?: number;
  kind?: ProgramKind;
}

export type OfferFlag = 'over_budget' | 'dates_unknown';

export interface OfferRow {
  kind: ProgramKind;
  title: string;
  hotel: string | null;
  destination: string | null;
  transport: Transport | null;
  departure_city: string | null;
  nights: number | null;
  days: number | null;
  nearest_departure: string | null;
  departure_dates: string[]; // at most 12, ascending
  board: Board | null;
  season: string;
  image: string | null;
  link: string;
  flags: OfferFlag[];
}

export interface SearchOffersResult {
  match: 'exact' | 'approximate' | 'none' | 'not_requested';
  matched_by?: 'containment' | 'key' | 'alias';
  hotel?: string;
  candidates?: { hotel: string; destination: string | null }[];
  unmet_filters?: string[];
  rows: OfferRow[];
  total_matching: number;
  today: string; // yyyy-mm-dd, Europe/Sofia
  catalog_scraped_at: string;
}

// Error shapes returned by the tool instead of throwing (D4).
export interface SearchOffersError {
  error: 'catalog_unavailable' | 'invalid_input';
  fields?: string[];
}
