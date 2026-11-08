import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Catalog } from './types';

const FIXTURE = path.resolve(__dirname, '__fixtures__/catalog-small.json');
const DAY = 86_400_000;

let dir: string;
let warn: jest.SpyInstance;
let log: jest.SpyInstance;
const saved = process.env.CATALOG_PATH;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-load-'));
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  log.mockRestore();
  if (saved === undefined) delete process.env.CATALOG_PATH;
  else process.env.CATALOG_PATH = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function loadAt(file: string) {
  process.env.CATALOG_PATH = file;
  let mod: typeof import('./load');
  let tool: typeof import('../tools/search-offers');
  jest.isolateModules(() => {
    mod = require('./load');
    tool = require('../tools/search-offers');
  });
  return { mod: mod!, tool: tool! };
}

const warned = () => warn.mock.calls.map((c) => String(c[0]));
const unavailableLines = () => warned().filter((l) => l.startsWith('[catalog] unavailable: '));
const staleLines = () => warned().filter((l) => l.startsWith('[catalog] stale'));
const catalogWith = (scraped_at: string): Catalog => ({
  ...(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Catalog),
  scraped_at,
});

describe('catalog loader', () => {
  // protects=a missing data/offers.json does not crash the service and search_offers answers catalog_unavailable; fails_when=loading throws, nothing is logged, or search_offers returns rows or throws; no_claim=the production file exists
  it('missing file: no throw, logs unavailable, search_offers returns catalog_unavailable', async () => {
    const { mod, tool } = loadAt(path.join(dir, 'nope.json'));
    expect(mod.getCatalog()).toBeNull();
    expect(unavailableLines()).toHaveLength(1);
    await expect(tool.search_offers({ hotel: 'Лонисера' })).resolves.toEqual({ error: 'catalog_unavailable' });
  });

  // protects=a corrupted file does not crash the service; fails_when=a JSON.parse error escapes or no unavailable line is logged; no_claim=the reason text is stable across Node versions
  it('invalid JSON: no throw, logs unavailable, search_offers returns catalog_unavailable', async () => {
    const { mod, tool } = loadAt(write('bad.json', '{ "version": 1, '));
    expect(mod.getCatalog()).toBeNull();
    expect(unavailableLines()).toHaveLength(1);
    await expect(tool.search_offers({})).resolves.toEqual({ error: 'catalog_unavailable' });
  });

  // protects=a catalog from another format version is refused rather than half-read; fails_when=version 2 loads, or the reason does not name the version; no_claim=a version-1 file with wrong inner shapes is always caught
  it('wrong version: refused with the version in the reason', async () => {
    const { mod, tool } = loadAt(write('v2.json', { ...catalogWith(new Date().toISOString()), version: 2 }));
    expect(mod.getCatalog()).toBeNull();
    expect(unavailableLines()).toEqual(['[catalog] unavailable: unsupported version 2']);
    await expect(tool.search_offers({})).resolves.toEqual({ error: 'catalog_unavailable' });
  });

  // protects=the default path resolves to the repo data/offers.json; fails_when=the default points elsewhere; no_claim=the file exists yet
  it('default path is the repo data/offers.json', () => {
    delete process.env.CATALOG_PATH;
    let mod: typeof import('./load');
    jest.isolateModules(() => {
      mod = require('./load');
    });
    expect(mod!.catalogPath()).toBe(path.resolve(__dirname, '../../data/offers.json'));
  });
});

describe('staleness', () => {
  // protects=staleness is logged at load: 15 days logs, 13 days stays silent; fails_when=the load path does not call checkStaleness; no_claim=the 24 h repeat fires (see the timer test)
  it('at load: 15 days old logs [catalog] stale, 13 days logs nothing', () => {
    loadAt(write('old.json', catalogWith(new Date(Date.now() - 15 * DAY).toISOString())));
    expect(staleLines()).toHaveLength(1);
    expect(staleLines()[0]).toMatch(/^\[catalog\] stale: scraped_at=\S+ age=15d$/);
    warn.mockClear();
    loadAt(write('young.json', catalogWith(new Date(Date.now() - 13 * DAY).toISOString())));
    expect(staleLines()).toHaveLength(0);
  });
});
