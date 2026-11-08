/**
 * Manual replay of the two Messenger conversations from ClickUp 869fnmpyu
 * (21.09.2026) against the live model, through the real AppService.chat().
 *
 * Not part of `npm test`: it calls OpenAI (about USD 0.20-0.50 per run) and
 * needs OPENAI_API_KEY in .env. Tools with side effects are replaced by
 * recorders, and their webhook/Airtable env vars are removed, so no team
 * notification, lead or complaint is ever sent.
 *
 * Run: npx ts-node test/replay-869fnmpyu.ts [log-file]
 *      REPLAY_RUNS=6 npx ts-node test/replay-869fnmpyu.ts   (acceptance run)
 * Exit code: 0 = RUN: PASS, 1 = RUN: FAIL, 2 = RUN: INCONCLUSIVE.
 * With REPLAY_RUNS >= 6 the exit code follows acceptance criterion 11 of
 * issue #2 plus the reply-time gate (p95 <= 24 s, none above 30 s, no
 * waiting-message reply). ORACLE_UNRESOLVED always exits 2.
 *
 * The expected links come from an oracle: search() over the committed
 * data/offers.json with no model call (issue #2, replay table).
 *
 * The messages are paraphrased (the repo is public). The detectors and checks
 * below are frozen by the spec: changing any of them needs sign-off first.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { AppService } from '../src/app.service';
import { SUPPORTED_ACTIONS } from '../src/assistant/config';
import { CHANNELS } from '../src/interfaces/enums';
import { search } from '../src/catalog/search';
import { ALIASES, HotelRef, matchHotel } from '../src/catalog/match';
import { Catalog, OfferRow, SearchOffersInput } from '../src/catalog/types';

// Importing app.service has loaded .env; drop everything a real tool could
// call out with. The recorders below are the first guard, this is the second.
for (const name of ['HUMAN_HANDOFF_WEBHOOK_URL', 'HUMAN_HANDOFF_WEBHOOK_URL_WEBCHAT', 'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID']) {
  delete process.env[name];
}

const FALLBACK_REPLY = 'Моля изчакайте, генерирам отговор.';

interface ToolCall { thread_id: string; turn: number; name: string; args: any }
interface Turn { turn: number; message: string; reply: string; ms: number; fallback: boolean }
interface ScenarioRun { id: string; thread_id: string; turns: Turn[]; stoppedBy: 'fallback' | 'handover' | null }

const SCENARIOS: { id: string; messages: string[] }[] = [
  {
    id: 'A',
    messages: [
      'Има ли вече цени за 2027 г',
      'За хотел Лонисера Ресорт спа Алания',
      'С автобус, за 7 нощувки',
      'А за двама от 15.09.27 г с автобус за 7 нощувки каква е цената',
    ],
  },
  {
    id: 'B',
    messages: [
      'Здравейте! Търсим почивка в хотел Камелия Селин, Сиде, Турция, лято 2027, със самолет от София, от 21.06 до 28.06. Пътуваме 4 възрастни и 2 деца (6 и 9 г.), в две стаи. Моля за оферта.',
      'Моля да изпратите офертата тук или на имейл днес, ако е възможно!',
    ],
  },
  {
    id: 'C',
    messages: [
      'Здравейте, имате ли оферта за хотел Лонисера Ресорт спа в Алания, 7 нощувки със самолет?',
      'Lonicera resort and spa',
      'Каква е цената за двама?',
      'А със автобус?',
    ],
  },
  {
    id: 'D',
    messages: [
      'Каква е цената за хотел Лонисера Ресорт спа в Алания за септември 2027 г., със самолет, 7 нощувки, за двама?',
    ],
  },
];

// E and F are added by the engineering review (D6): they cover the behaviour of
// the deleted prompt section 8, which no hotel-named scenario exercises. F needs
// a real cruise from the catalog, so it is built at run time.
const SCENARIO_E = {
  id: 'E',
  messages: ['Здравейте! Търсим почивка в Алания през септември 2027, със самолет, 7 нощувки, бюджет около 900 евро на човек. Какво имате?'],
};

// ---------------------------------------------------------------- logging

const logPath = process.argv[2] || `.gstack/qa/replay-869fnmpyu-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
mkdirSync(dirname(logPath), { recursive: true });

function log(line = ''): void {
  console.log(line);
  appendFileSync(logPath, `${line}\n`);
}

// -------------------------------------------------------------- recorders

const toolCalls: ToolCall[] = [];
const currentTurn = new Map<string, number>();

function recorder(name: string, result: string) {
  return async (args: any, ctx: any) => {
    const thread_id = ctx?.thread_id;
    toolCalls.push({ thread_id, turn: currentTurn.get(thread_id) ?? 0, name, args });
    return result;
  };
}

const actions = SUPPORTED_ACTIONS as Record<string, unknown>;
actions.capture_lead = recorder('capture_lead', 'Lead stored successfully.');
actions.capture_complaint = recorder('capture_complaint', 'Complaint stored successfully.');
actions.transfer_to_human = recorder('transfer_to_human', 'Transfer to human acknowledged.');

// -------------------------------------------------------------- detectors

const stripUrls = (s: string) => s.replace(/https?:\/\/\S+/g, '');

const MARKDOWN = /!\[|\]\(|\*\*/;
const EN_LOWER = /\b(?:here|here's|the|for|with|you|your|please|price|offer|revised|sorry|unfortunately|is|are)\b/g;
const EN_SENTENCE_START = /(?:^|[.!?]\s+|\n\s*)(?:Here|Here's|Unfortunately|Sorry|Please|You|Your|This|There)\b/;
// Any form of "документ", except identity/travel documents the client may need.
const INTERNAL = /предоставен\S* (документ|файл)|(?<!лични\s)документ(?!\S*\s+за\s+(самоличност|пътуване))|файл|база(та)? (ни|от данни|с данни)|knowledge base/i;
const KUSADASI = /ku[sş]ada[sş][iı]|кушадас/i;
const BODRUM_SHARK = /bodrum|бодрум|club\s*shark|клуб\s*шарк/i;
const LONICERA_WORLD = /lonicera\s+world|лонисера\s+уърлд/i;
const LONICERA_RESORT = /lonicera\s+resort/i;
const OTHER_LONICERA = /lonicera\s+(?!resort\b)[a-z]+/i;
// Any orient99.com link; normalised and reduced to a key by linkKey() below.
const ORIENT_URL = /https?:\/\/(?:www\.)?orient99\.com\/[^\s)]+/gi;
const NOT_FOUND = /не намирам|не открих|няма информация|не разполагам с информация|не е налич/i;
// D14: the agent quotes no price at all, so any amount in a reply fails.
const PRICE = /€\s*\d|\d[\d .,]*\s*(?:€|евро|eur\b)/i;
const LEV = /\d[\d .,]*\s*(?:лв\.?|лева)/i;
// The stored offers are "Лято 2026"; the agent must not mention that season.
const STORED_SEASON = /2026/;
const BUDGET_Q = /бюджет/i;
const OFFER = /Резервация:\s*https?:\/\//i;

function isEnglish(reply: string): boolean {
  const text = stripUrls(reply);
  const lowerHits = new Set(text.match(EN_LOWER) ?? []);
  return lowerHits.size >= 2 || EN_SENTENCE_START.test(text);
}

function cyrillicRatio(reply: string): number {
  const text = stripUrls(reply);
  const letters = text.match(/\p{L}/gu) ?? [];
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu) ?? [];
  return letters.length ? cyrillic.length / letters.length : 1;
}

function isHandover(thread_id: string, turn: number): boolean {
  return toolCalls.some((c) => c.thread_id === thread_id && c.turn === turn && c.name === 'transfer_to_human' && String(c.args?.reason ?? '').startsWith('Няма оферта'));
}

// ------------------------------------------------------------------- run

async function runScenario(service: AppService, id: string, messages: string[]): Promise<ScenarioRun> {
  const { thread_id } = await service.start();
  const run: ScenarioRun = { id, thread_id, turns: [], stoppedBy: null };

  if (!thread_id) {
    log(`[${id}] start() returned no conversation id - treated as FALLBACK`);
    run.stoppedBy = 'fallback';
    return run;
  }

  for (let i = 0; i < messages.length; i++) {
    const turn = i + 1;
    currentTurn.set(thread_id, turn);

    const startedAt = Date.now();
    const { response } = await service.chat({ thread_id, message: messages[i], channel: CHANNELS.MESSENGER, contact_id: 'replay-test' });
    const ms = Date.now() - startedAt;
    const fallback = response === FALLBACK_REPLY;

    run.turns.push({ turn, message: messages[i], reply: response, ms, fallback });

    log(`--- ${id}/${turn} (${ms} ms)${fallback ? ' FALLBACK' : ''}`);
    log(`CLIENT: ${messages[i]}`);
    log(`AGENT: ${response}`);
    for (const call of toolCalls.filter((c) => c.thread_id === thread_id && c.turn === turn)) {
      log(`TOOL: ${call.name} reason=${JSON.stringify(call.args?.reason ?? '')}`);
    }

    if (fallback) {
      run.stoppedBy = 'fallback';
      break;
    }
    if (isHandover(thread_id, turn)) {
      run.stoppedBy = 'handover';
      break;
    }
  }

  return run;
}

// ----------------------------------------------------------------- checks

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Result { check: string; status: Status; detail?: string }

const preview = (s: ScenarioRun, t: Turn) => `${s.id}/${t.turn}: ${t.reply.replace(/\s+/g, ' ').slice(0, 160)}`;
const replies = (s: ScenarioRun) => s.turns.filter((t) => !t.fallback);
const reached = (s: ScenarioRun, turn: number) => s.turns.find((t) => t.turn === turn && !t.fallback);

// A turn the scenario never reached is SKIP after a FALLBACK, FAIL otherwise.
function unreached(check: string, s: ScenarioRun, turn: number): Result {
  return s.stoppedBy === 'fallback'
    ? { check, status: 'SKIP', detail: '(fallback)' }
    : { check, status: 'FAIL', detail: `${s.id}/${turn}: not reached (scenario stopped by ${s.stoppedBy ?? 'end of messages'})` };
}

function everyReply(check: string, runs: ScenarioRun[], ok: (reply: string) => boolean): Result {
  for (const s of runs) {
    for (const t of replies(s)) {
      if (!ok(t.reply)) {
        return { check, status: 'FAIL', detail: preview(s, t) };
      }
    }
  }
  return { check, status: 'PASS' };
}

function turnCheck(check: string, s: ScenarioRun, turn: number, ok: (t: Turn) => boolean): Result {
  const t = reached(s, turn);
  if (!t) {
    return unreached(check, s, turn);
  }
  return ok(t) ? { check, status: 'PASS' } : { check, status: 'FAIL', detail: preview(s, t) };
}

// A link is compared as a key: hotel links by (hid, oid), program links by oid.
// Host lowercased and www. dropped, &amp; turned into &, percent-decoded,
// trailing punctuation removed.
function linkKey(raw: string): string | null {
  let u = raw.replace(/&amp;/g, '&').replace(/[.,;:!?)\]]+$/, '');
  try {
    u = decodeURIComponent(u);
  } catch {
    // keep the undecoded text
  }
  u = u.replace(/^(https?:\/\/)(?:www\.)?([^/]+)/i, (_m, proto, host) => `${proto.toLowerCase()}${host.toLowerCase()}`);
  const hid = /[?&]hid=(\d+)/.exec(u)?.[1];
  const oid = /[?&]oid=(\d+)/.exec(u)?.[1];
  if (hid && oid) return `h${hid}:${oid}`;
  if (oid && /view\?oid=/.test(u)) return `p${oid}`;
  return null;
}

// Offer links in a reply, as keys (links to other pages are not offers).
const replyKeys = (reply: string): string[] => (reply.match(ORIENT_URL) ?? []).map(linkKey).filter((k): k is string => k !== null);
const rowKey = (row: OfferRow): string | null => linkKey(row.link);

interface Oracle { rows: OfferRow[]; keys: Set<string> }
const oracleOf = (rows: OfferRow[]): Oracle => ({ rows, keys: new Set(rows.map(rowKey).filter((k): k is string => k !== null)) });
const nonEmpty = (o: Oracle) => o.keys.size > 0;
// Every offer link in the reply is an oracle link (a reply with no offer link passes this).
const subsetIn = (reply: string, o: Oracle) => replyKeys(reply).every((k) => o.keys.has(k));
const hasOracleLink = (reply: string, o: Oracle) => replyKeys(reply).some((k) => o.keys.has(k));
const distinctOffers = (reply: string) => new Set(replyKeys(reply)).size;

// The oracle for each check, resolved once before any model call.
interface Oracles { A: Oracle; B: Oracle; C1: Oracle; C3: Oracle; D: Oracle; E: Oracle; F: Oracle }

function evaluate(runs: Record<string, ScenarioRun>, o: Oracles): Result[] {
  const all = Object.values(runs);
  const { A, B, C, D, E, F } = runs;
  const results: Result[] = [];

  results.push(everyReply('R1', all, (r) => !MARKDOWN.test(r) && !isEnglish(r) && cyrillicRatio(r) >= 0.5));
  results.push(everyReply('R2', all, (r) => !INTERNAL.test(stripUrls(r))));
  results.push(everyReply('R3', all, (r) => !PRICE.test(stripUrls(r)) && !LEV.test(stripUrls(r))));

  // A1: with offers in the catalog, a reply on turns 2-4 names LONICERA RESORT
  // with an oracle link and no turn 1-4 is a handover; with none, handover as before.
  const aHandover = A.turns.some((t) => t.turn <= 4 && isHandover(A.thread_id, t.turn));
  if (nonEmpty(o.A)) {
    const found = A.turns.some((t) => t.turn >= 2 && t.turn <= 4 && !t.fallback && LONICERA_RESORT.test(stripUrls(t.reply)) && hasOracleLink(t.reply, o.A));
    results.push(found && !aHandover
      ? { check: 'A1', status: 'PASS' }
      : A.stoppedBy === 'fallback' ? { check: 'A1', status: 'SKIP', detail: '(fallback)' } : { check: 'A1', status: 'FAIL', detail: aHandover ? 'A: handover although the catalog has the offer' : 'A: no reply on turns 2-4 names LONICERA RESORT with an oracle link' });
  } else {
    results.push(aHandover
      ? { check: 'A1', status: 'PASS' }
      : A.stoppedBy === 'fallback' ? { check: 'A1', status: 'SKIP', detail: '(fallback)' } : { check: 'A1', status: 'FAIL', detail: 'A: oracle empty, no handover with reason "Няма оферта" on turns 1-4' });
  }
  // A2: the offer ban is dropped; the Kusadasi, Lonicera World and Bodrum bans stay.
  results.push(everyReply('A2', [A], (r) => !LONICERA_WORLD.test(stripUrls(r))));

  const bHandover = B.turns.some((t) => t.turn <= 2 && isHandover(B.thread_id, t.turn));
  if (nonEmpty(o.B)) {
    const bad = everyReply('B1', [B], (r) => !BODRUM_SHARK.test(stripUrls(r)));
    const found = B.turns.some((t) => t.turn <= 2 && !t.fallback && hasOracleLink(t.reply, o.B));
    results.push(bad.status === 'FAIL' ? bad : found ? { check: 'B1', status: 'PASS' } : B.stoppedBy === 'fallback' ? { check: 'B1', status: 'SKIP', detail: '(fallback)' } : { check: 'B1', status: 'FAIL', detail: 'B: no reply on turn 1 or 2 with an oracle link' });
  } else {
    const bReplies = everyReply('B1', [B], (r) => !BODRUM_SHARK.test(stripUrls(r)) && !OFFER.test(r));
    if (bReplies.status === 'FAIL') {
      results.push(bReplies);
    } else if (bHandover) {
      results.push({ check: 'B1', status: 'PASS' });
    } else {
      results.push(B.stoppedBy === 'fallback' ? { check: 'B1', status: 'SKIP', detail: '(fallback)' } : { check: 'B1', status: 'FAIL', detail: 'B: oracle empty, no handover with reason "Няма оферта" on turn 1 or 2' });
    }
  }

  results.push(turnCheck('C1', C, 1, (t) => {
    const r = stripUrls(t.reply);
    return LONICERA_RESORT.test(r) && OFFER.test(t.reply) && subsetIn(t.reply, o.C1) && !NOT_FOUND.test(r) && !BUDGET_Q.test(r) && !isHandover(C.thread_id, 1);
  }));

  let c2: Result = { check: 'C2', status: 'PASS' };
  for (const turn of [2, 3]) {
    const r = turnCheck('C2', C, turn, (t) => {
      const text = stripUrls(t.reply);
      return !isHandover(C.thread_id, turn) && !LONICERA_WORLD.test(text) && !BUDGET_Q.test(text) && subsetIn(t.reply, o.C1);
    });
    if (r.status !== 'PASS') {
      c2 = r;
      break;
    }
  }
  results.push(c2);

  // C3: the bus question must show a link from the oracle rows; a handover
  // passes only when the oracle is empty. Never another LONICERA hotel.
  results.push(turnCheck('C3', C, 4, (t) => {
    const r = stripUrls(t.reply);
    if (OTHER_LONICERA.test(r)) {
      return false;
    }
    if (!nonEmpty(o.C3)) {
      return isHandover(C.thread_id, 4);
    }
    return !isHandover(C.thread_id, 4) && LONICERA_RESORT.test(r) && OFFER.test(t.reply) && hasOracleLink(t.reply, o.C3) && subsetIn(t.reply, o.C3) && !NOT_FOUND.test(r);
  }));
  results.push(everyReply('C4', [C], (r) => !KUSADASI.test(stripUrls(r)) && !STORED_SEASON.test(stripUrls(r))));

  results.push(turnCheck('D1', D, 1, (t) => {
    const r = stripUrls(t.reply);
    if (!nonEmpty(o.D)) {
      return isHandover(D.thread_id, 1) && !OFFER.test(t.reply) && !KUSADASI.test(r) && !LONICERA_WORLD.test(r);
    }
    return !isHandover(D.thread_id, 1) && hasOracleLink(t.reply, o.D) && subsetIn(t.reply, o.D);
  }));

  // E (destination, month, transport, nights, budget) and F (a cruise by name
  // and year): the reply uses only oracle links, at most 3 distinct offers, no
  // hotel of its own for a cruise, no price (R3). An empty oracle means a handover.
  for (const [id, run, oracle] of [['E1', E, o.E], ['F1', F, o.F]] as const) {
    if (!run) {
      continue;
    }
    results.push(turnCheck(id, run, 1, (t) => {
      const r = stripUrls(t.reply);
      if (!nonEmpty(oracle)) {
        return isHandover(run.thread_id, 1) && !OFFER.test(t.reply);
      }
      const cruiseWithHotel = id === 'F1' && /🏨\s*Хотел:/.test(t.reply);
      return !isHandover(run.thread_id, 1) && hasOracleLink(t.reply, oracle) && subsetIn(t.reply, oracle) && distinctOffers(t.reply) <= 3 && !cruiseWithHotel && !NOT_FOUND.test(r);
    }));
  }

  return results;
}

// ------------------------------------------------------------------ oracle

function sofiaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// One HotelRef per hotel_id, as search() builds them: the first offer's name,
// the most common destination and region (ties alphabetical).
function hotelRefs(catalog: Catalog): HotelRef[] {
  const byId = new Map<string, { name: string; dest: Map<string, number>; reg: Map<string, number> }>();
  for (const off of catalog.offers) {
    const e = byId.get(off.hotel_id) ?? { name: off.hotel, dest: new Map(), reg: new Map() };
    if (off.destination) e.dest.set(off.destination, (e.dest.get(off.destination) ?? 0) + 1);
    if (off.region) e.reg.set(off.region, (e.reg.get(off.region) ?? 0) + 1);
    byId.set(off.hotel_id, e);
  }
  const top = (m: Map<string, number>): string | null => [...m.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? null;
  return [...byId.entries()].map(([hotel_id, e]) => ({ hotel_id, hotel: e.name, destination: top(e.dest), region: top(e.reg) }));
}

const ORACLE_INPUTS: Record<string, SearchOffersInput> = {
  A1: { hotel: 'Lonicera Resort & Spa', transport: 'bus', nights: 7, season_year: 2027, departure_date: '2027-09-15' },
  B1: { hotel: 'Kamelya Selin Hotel', transport: 'plane', season_year: 2027, departure_date: '2027-06-21', nights: 7 },
  C1: { hotel: 'Lonicera Resort & Spa', transport: 'plane', nights: 7 },
  C3: { hotel: 'Lonicera Resort & Spa', transport: 'bus', nights: 7 },
  D1: { hotel: 'Lonicera Resort & Spa', transport: 'plane', nights: 7, season_year: 2027, month: 9 },
  E1: { destination: 'Алания', month: 9, season_year: 2027, transport: 'plane', nights: 7, budget_per_person_eur: 900, kind: 'holiday' },
};

type OracleSetup = { oracles: Oracles; scenarios: { id: string; messages: string[] }[] } | { unresolved: string };

function buildOracles(catalog: Catalog): OracleSetup {
  const today = sofiaToday();
  const hotels = hotelRefs(catalog);

  // Resolve every named hotel before any model call: an unresolved name costs nothing.
  for (const [check, input] of Object.entries(ORACLE_INPUTS)) {
    if (input.hotel) {
      const m = matchHotel(input.hotel, hotels, ALIASES);
      if (m.match !== 'exact') {
        return { unresolved: `ORACLE_UNRESOLVED ${check} ${m.match}` };
      }
    }
  }
  const run = (input: SearchOffersInput) => oracleOf(search(catalog, input, today, { limit: Infinity }).rows);

  // F: a cruise by name and year, taken from the catalog itself.
  const cruises = search(catalog, { kind: 'cruise' }, today, { limit: Infinity }).rows.filter((r) => r.nearest_departure);
  if (!cruises.length) {
    return { unresolved: 'ORACLE_UNRESOLVED F1 no_cruise_in_catalog' };
  }
  const cruise = cruises[0];
  const year = Number(cruise.nearest_departure!.slice(0, 4));
  const fMessage = `Здравейте! Интересувам се от круиза „${cruise.title}“ през ${year} г. Има ли такъв и как мога да го резервирам?`;

  const oracles: Oracles = {
    A: run(ORACLE_INPUTS.A1),
    B: run(ORACLE_INPUTS.B1),
    C1: run(ORACLE_INPUTS.C1),
    C3: run(ORACLE_INPUTS.C3),
    D: run(ORACLE_INPUTS.D1),
    E: run(ORACLE_INPUTS.E1),
    F: run({ kind: 'cruise', season_year: year }),
  };
  return { oracles, scenarios: [...SCENARIOS, SCENARIO_E, { id: 'F', messages: [fMessage] }] };
}

async function main(): Promise<number> {
  if (!process.env.OPENAI_API_KEY) {
    log('OPENAI_API_KEY is not set - nothing was run.');
    return 2;
  }

  // The oracle reads the committed catalog; nothing is sent to the model before
  // every named hotel in the oracle inputs has resolved to an exact match.
  const catalogPath = process.env.CATALOG_PATH || resolve(__dirname, '../data/offers.json');
  let catalog: Catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog;
  } catch (e) {
    log(`Cannot read the catalog at ${catalogPath}: ${e}`);
    return 2;
  }
  const setup = buildOracles(catalog);
  if ('unresolved' in setup) {
    log(setup.unresolved);
    return 2;
  }
  const runCount = Math.max(1, Number(process.env.REPLAY_RUNS) || 1);

  const service = new AppService({} as any);

  // Optional, for comparing models without changing config.ts: REPLAY_MODEL
  // and REPLAY_REASONING override every responses.create the service makes.
  // REPLAY_REASONING=off drops the reasoning parameter, which models without
  // reasoning (gpt-4o, gpt-4.1) reject with a 400.
  const overrideModel = process.env.REPLAY_MODEL;
  const overrideEffort = process.env.REPLAY_REASONING;
  if (overrideModel || overrideEffort) {
    const responses = (service as any).openai.responses;
    const create = responses.create.bind(responses);
    responses.create = (params: any, ...rest: any[]) => {
      const { reasoning, ...withoutReasoning } = params;
      return create({
        ...withoutReasoning,
        ...(overrideEffort === 'off' ? {} : { reasoning: overrideEffort ? { effort: overrideEffort } : reasoning }),
        ...(overrideModel ? { model: overrideModel } : {}),
      }, ...rest);
    };
  }

  log(`Replay 869fnmpyu, ${new Date().toISOString()}, model: ${overrideModel ?? 'config.ts MODEL'}${overrideEffort ? `, reasoning: ${overrideEffort}` : ''}, runs: ${runCount}, log: ${logPath}`);

  const tally = new Map<string, { pass: number; fail: number; skip: number }>();
  const allMs: number[] = [];
  let anyFallback = false;
  let lonicera = 0;

  for (let n = 1; n <= runCount; n++) {
    log(`===== RUN ${n}/${runCount} =====`);
    const runs: Record<string, ScenarioRun> = {};

    // Scenarios are independent conversations; every one runs regardless of
    // what happened in the previous one.
    for (const scenario of setup.scenarios) {
      runs[scenario.id] = await runScenario(service, scenario.id, scenario.messages);
    }

    log();
    const results = evaluate(runs, setup.oracles);
    for (const r of results) {
      log(r.status === 'PASS' ? `PASS ${r.check}` : r.status === 'SKIP' ? `SKIP ${r.check} (fallback)` : `FAIL ${r.check} ${r.detail}`);
      const t = tally.get(r.check) ?? { pass: 0, fail: 0, skip: 0 };
      if (r.status === 'PASS') t.pass++;
      else if (r.status === 'FAIL') t.fail++;
      else t.skip++;
      tally.set(r.check, t);
    }
    // LONICERA_FOUND counts C1 PASS plus C3 PASS (SKIP is not PASS).
    lonicera += results.filter((r) => (r.check === 'C1' || r.check === 'C3') && r.status === 'PASS').length;

    const turns = Object.values(runs).flatMap((s) => s.turns);
    allMs.push(...turns.map((t) => t.ms));
    log(`LATENCY: ${Object.values(runs).flatMap((s) => s.turns.map((t) => `${s.id}/${t.turn}=${t.ms}ms`)).join(' ')}`);
    if (Object.values(runs).some((s) => s.stoppedBy === 'fallback')) {
      anyFallback = true;
    }
  }

  log();
  log(`===== SUMMARY over ${runCount} run(s) =====`);
  for (const [check, t] of tally) {
    log(`${check} PASS ${t.pass}/${runCount} FAIL ${t.fail} SKIP ${t.skip}`);
  }
  log(`LONICERA_FOUND ${lonicera}/${2 * runCount}`);

  // Reply time (D7): milliseconds are converted to seconds once, here.
  const sorted = [...allMs].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] / 1000 : 0;
  const max = sorted.length ? sorted[sorted.length - 1] / 1000 : 0;
  log(`TIME turns=${sorted.length} p95=${p95.toFixed(1)}s max=${max.toFixed(1)}s waiting_replies=${anyFallback ? 'yes' : 'no'}`);
  const timeOk = p95 <= 24 && max <= 30 && !anyFallback;

  const anyFail = [...tally.values()].some((t) => t.fail > 0);
  if (runCount >= 6) {
    // Acceptance criterion 11 of issue #2, plus the reply-time gate.
    const problems: string[] = [];
    if (lonicera < 2 * runCount - 1) problems.push(`LONICERA_FOUND ${lonicera}/${2 * runCount}`);
    for (const [check, t] of tally) {
      const need = ['R1', 'R2', 'R3'].includes(check) ? runCount : runCount - 1;
      if (t.pass < need) problems.push(`${check} PASS ${t.pass}/${runCount} (need ${need})`);
    }
    if (!timeOk) problems.push(`reply time p95=${p95.toFixed(1)}s max=${max.toFixed(1)}s waiting=${anyFallback}`);
    log(problems.length ? `ACCEPTANCE: FAIL ${problems.join('; ')}` : 'ACCEPTANCE: PASS');
    return problems.length ? 1 : 0;
  }
  if (anyFail) {
    log('RUN: FAIL');
    return 1;
  }
  if (anyFallback) {
    log('RUN: INCONCLUSIVE');
    return 2;
  }
  log('RUN: PASS');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    log(`Replay crashed: ${e}`);
    process.exit(2);
  });
