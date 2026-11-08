// Loads and validates data/offers.json once, at module load. A failure never
// throws: it is logged and getCatalog() returns null, so the service still boots
// and search_offers answers {"error":"catalog_unavailable"}.
import * as fs from 'fs';
import * as path from 'path';
import { Catalog } from './types';

const STALE_AFTER_DAYS = 14;
const DAY_MS = 86_400_000;

export function catalogPath(): string {
  return process.env.CATALOG_PATH || path.resolve(__dirname, '../../data/offers.json');
}

// Returns the reason the value is not a usable catalog, or null when it is one.
export function validateCatalog(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'not a JSON object';
  const c = raw as Record<string, unknown>;
  if (c.version !== 1) return `unsupported version ${JSON.stringify(c.version)}`;
  if (typeof c.scraped_at !== 'string' || Number.isNaN(Date.parse(c.scraped_at))) return 'scraped_at is not an ISO date';
  if (!Array.isArray(c.programs)) return 'programs is not an array';
  if (!Array.isArray(c.offers)) return 'offers is not an array';
  for (const p of c.programs as Record<string, unknown>[]) {
    if (!p || typeof p.id !== 'string' || typeof p.title !== 'string' || typeof p.url !== 'string' || !Array.isArray(p.departure_dates)) {
      return 'a program is missing id, title, url or departure_dates';
    }
  }
  for (const o of c.offers as Record<string, unknown>[]) {
    if (!o || typeof o.program_id !== 'string' || typeof o.hotel_id !== 'string' || typeof o.hotel !== 'string' || typeof o.url !== 'string') {
      return 'an offer is missing program_id, hotel_id, hotel or url';
    }
  }
  return null;
}

export function loadCatalogFile(file: string): { catalog: Catalog | null; reason?: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const reason = validateCatalog(raw);
    return reason ? { catalog: null, reason } : { catalog: raw as Catalog };
  } catch (e) {
    return { catalog: null, reason: e instanceof Error ? e.message : String(e) };
  }
}

// The warning line when scraped_at is more than 14 days old, else null.
export function checkStaleness(scrapedAt: string, now: Date): string | null {
  const scraped = Date.parse(scrapedAt);
  if (Number.isNaN(scraped)) return null;
  const ageDays = Math.floor((now.getTime() - scraped) / DAY_MS);
  const exact = (now.getTime() - scraped) / DAY_MS;
  return exact > STALE_AFTER_DAYS ? `[catalog] stale: scraped_at=${scrapedAt} age=${ageDays}d` : null;
}

let current: Catalog | null = null;

export function getCatalog(): Catalog | null {
  return current;
}

// Test hook: lets a spec put a fixture catalog (or null) behind search_offers.
export function setCatalogForTests(catalog: Catalog | null): void {
  current = catalog;
}

function warnIfStale(): void {
  if (!current) return;
  const line = checkStaleness(current.scraped_at, new Date());
  if (line) console.warn(line);
}

function init(): void {
  const { catalog, reason } = loadCatalogFile(catalogPath());
  current = catalog;
  if (!catalog) {
    console.warn(`[catalog] unavailable: ${reason}`);
    return;
  }
  warnIfStale();
  setInterval(warnIfStale, DAY_MS).unref();
}

init();
