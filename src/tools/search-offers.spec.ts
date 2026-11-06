import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Test } from '@nestjs/testing';

const FIXTURE = path.resolve(__dirname, '../catalog/__fixtures__/catalog-small.json');
const saved = process.env.CATALOG_PATH;
let log: jest.SpyInstance;
let warn: jest.SpyInstance;

beforeEach(() => {
  log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  log.mockRestore();
  warn.mockRestore();
  if (saved === undefined) delete process.env.CATALOG_PATH;
  else process.env.CATALOG_PATH = saved;
});

function loadTool(file: string) {
  process.env.CATALOG_PATH = file;
  let tool: typeof import('./search-offers');
  jest.isolateModules(() => {
    tool = require('./search-offers');
  });
  return tool!;
}

describe('search_offers tool', () => {
  const today = { today: '2026-11-04' };

  // protects=every bad argument comes back as invalid_input naming the field, and the tool never throws (D4); fails_when=month 13, a non-date, non-numeric nights or an unknown enum rejects the promise or returns rows; no_claim=the model corrects itself afterwards
  it.each([
    [{ month: 13 }, ['month']],
    [{ departure_date: 'tomorrow' }, ['departure_date']],
    [{ nights: 'many' }, ['nights']],
  ])('invalid input %j returns invalid_input with fields %j', async (args, fields) => {
    const tool = loadTool(FIXTURE);
    const out = await tool.search_offers(args, undefined, today);
    expect(out).toEqual({ error: 'invalid_input', fields });
  });

  // protects=a valid call returns the search result object for the model; fails_when=a string comes back or the match is wrong; no_claim=the model words the answer right
  it('a valid call returns the result object', async () => {
    const tool = loadTool(FIXTURE);
    const out = (await tool.search_offers({ hotel: 'Лонисера', transport: 'bus', departure_date: '2027-09-15' }, undefined, today)) as any;
    expect(out.match).toBe('exact');
    expect(out.hotel).toBe('LONICERA RESORT & SPA');
    expect(out.rows[0].nearest_departure).toBe('2027-09-14');
    expect(out.today).toBe('2026-11-04');
  });
});

describe('AppModule with the catalog missing', () => {
  // protects=a missing catalog file never stops the Nest app from compiling (a boot crash takes the agent down on Railway); fails_when=compile throws; no_claim=the app answers requests
  it('compiles when CATALOG_PATH points at a missing file', async () => {
    process.env.CATALOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'no-catalog-')), 'missing.json');
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
    let AppModule: any;
    jest.isolateModules(() => {
      AppModule = require('../app.module').AppModule;
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith('[catalog] unavailable: '))).toBe(true);
    await moduleRef.close();
  });
});
