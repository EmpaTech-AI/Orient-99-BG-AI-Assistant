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
 * Exit code: 0 = RUN: PASS, 1 = RUN: FAIL, 2 = RUN: INCONCLUSIVE.
 *
 * The messages are paraphrased (the repo is public). The detectors and checks
 * below are frozen by the spec: changing any of them needs sign-off first.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { AppService } from '../src/app.service';
import { SUPPORTED_ACTIONS } from '../src/assistant/config';
import { CHANNELS } from '../src/interfaces/enums';

// Importing app.service has loaded .env; drop everything a real tool could
// call out with. The recorders below are the first guard, this is the second.
for (const name of ['HUMAN_HANDOFF_WEBHOOK_URL', 'HUMAN_HANDOFF_WEBHOOK_URL_WEBCHAT', 'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID']) {
  delete process.env[name];
}

const FALLBACK_REPLY = 'Моля изчакайте, генерирам отговор.';

// LONICERA RESORT & SPA's real booking link in the 7-night Alanya bus file.
// C3 accepts a bus offer only with this link: a link made up from another
// hotel's id (seen with gpt-5.4-mini) or the 5/9/12-night offer fails, since
// the client asked for 7 nights.
const LONICERA_RESORT_BUS_7N_URL = 'https://www.orient99.com/early_booking/early_alanya/view/hotel?hid=3016370&oid=2614151';

// Its real links in the three 7-night Alanya plane files (Sofia SunExpress,
// Sofia, Varna). C1/C2 reject any other link, e.g. LONICERA PREMIUM's
// (hid=3016548), which gpt-5.4-mini once paired with this hotel's name.
const LONICERA_RESORT_PLANE_7N_URLS = [
  'https://www.orient99.com/early_booking/early_alanya/view/hotel?hid=3016370&oid=2865428',
  'https://www.orient99.com/early_booking/early_alanya/view/hotel?hid=3016370&oid=2864543',
  'https://www.orient99.com/early_booking/early_alanya/view/hotel?hid=3016370&oid=2865417',
];

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
const BOOKING_URL = /https?:\/\/(?:www\.)?orient99\.com\/early_booking\/[^\s)]+/gi;
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

const bookingUrls = (reply: string) => (reply.match(BOOKING_URL) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ''));
const urlsIn = (reply: string, allowed: string[]) => bookingUrls(reply).every((u) => allowed.includes(u));

function evaluate(runs: Record<string, ScenarioRun>): Result[] {
  const all = Object.values(runs);
  const { A, B, C, D } = runs;
  const results: Result[] = [];

  results.push(everyReply('R1', all, (r) => !MARKDOWN.test(r) && !isEnglish(r) && cyrillicRatio(r) >= 0.5));
  results.push(everyReply('R2', all, (r) => !INTERNAL.test(stripUrls(r))));
  results.push(everyReply('R3', all, (r) => !PRICE.test(stripUrls(r)) && !LEV.test(stripUrls(r))));

  const aHandover = A.turns.some((t) => t.turn <= 4 && isHandover(A.thread_id, t.turn));
  results.push(aHandover
    ? { check: 'A1', status: 'PASS' }
    : A.stoppedBy === 'fallback' ? { check: 'A1', status: 'SKIP', detail: '(fallback)' } : { check: 'A1', status: 'FAIL', detail: 'A: no handover with reason "Няма оферта" on turns 1-4' });
  results.push(everyReply('A2', [A], (r) => !OFFER.test(r) && !KUSADASI.test(stripUrls(r)) && !LONICERA_WORLD.test(stripUrls(r)) && !BODRUM_SHARK.test(stripUrls(r))));

  const bHandover = B.turns.some((t) => t.turn <= 2 && isHandover(B.thread_id, t.turn));
  const bReplies = everyReply('B1', [B], (r) => !BODRUM_SHARK.test(stripUrls(r)) && !OFFER.test(r));
  if (bReplies.status === 'FAIL') {
    results.push(bReplies);
  } else if (bHandover) {
    results.push({ check: 'B1', status: 'PASS' });
  } else {
    results.push(B.stoppedBy === 'fallback' ? { check: 'B1', status: 'SKIP', detail: '(fallback)' } : { check: 'B1', status: 'FAIL', detail: 'B: no handover with reason "Няма оферта" on turn 1 or 2' });
  }

  results.push(turnCheck('C1', C, 1, (t) => {
    const r = stripUrls(t.reply);
    return LONICERA_RESORT.test(r) && OFFER.test(t.reply) && urlsIn(t.reply, LONICERA_RESORT_PLANE_7N_URLS) && !NOT_FOUND.test(r) && !BUDGET_Q.test(r) && !isHandover(C.thread_id, 1);
  }));

  let c2: Result = { check: 'C2', status: 'PASS' };
  for (const turn of [2, 3]) {
    const r = turnCheck('C2', C, turn, (t) => {
      const text = stripUrls(t.reply);
      return !isHandover(C.thread_id, turn) && !LONICERA_WORLD.test(text) && !BUDGET_Q.test(text) && urlsIn(t.reply, LONICERA_RESORT_PLANE_7N_URLS);
    });
    if (r.status !== 'PASS') {
      c2 = r;
      break;
    }
  }
  results.push(c2);

  // Signed off by the user on 2026-11-03: the bus excerpt for this hotel is
  // often not retrieved from today's vector store, so an honest handover
  // passes too. Never another LONICERA hotel, and never a link other than its
  // own 7-night bus offer.
  results.push(turnCheck('C3', C, 4, (t) => {
    const r = stripUrls(t.reply);
    if (OTHER_LONICERA.test(r)) {
      return false;
    }
    if (isHandover(C.thread_id, 4)) {
      return true;
    }
    return LONICERA_RESORT.test(r) && OFFER.test(t.reply) && bookingUrls(t.reply).length > 0 && urlsIn(t.reply, [LONICERA_RESORT_BUS_7N_URL]) && !NOT_FOUND.test(r);
  }));
  results.push(everyReply('C4', [C], (r) => !KUSADASI.test(stripUrls(r)) && !STORED_SEASON.test(stripUrls(r))));

  results.push(turnCheck('D1', D, 1, (t) => {
    const r = stripUrls(t.reply);
    return isHandover(D.thread_id, 1) && !OFFER.test(t.reply) && !KUSADASI.test(r) && !LONICERA_WORLD.test(r);
  }));

  return results;
}

async function main(): Promise<number> {
  if (!process.env.OPENAI_API_KEY) {
    log('OPENAI_API_KEY is not set - nothing was run.');
    return 2;
  }

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

  log(`Replay 869fnmpyu, ${new Date().toISOString()}, model: ${overrideModel ?? 'config.ts MODEL'}${overrideEffort ? `, reasoning: ${overrideEffort}` : ''}, log: ${logPath}`);
  const runs: Record<string, ScenarioRun> = {};

  // Scenarios are independent conversations; every one runs regardless of
  // what happened in the previous one.
  for (const scenario of SCENARIOS) {
    runs[scenario.id] = await runScenario(service, scenario.id, scenario.messages);
  }

  log();
  const results = evaluate(runs);
  for (const r of results) {
    log(r.status === 'PASS' ? `PASS ${r.check}` : r.status === 'SKIP' ? `SKIP ${r.check} (fallback)` : `FAIL ${r.check} ${r.detail}`);
  }

  const latencies = Object.values(runs).flatMap((s) => s.turns.map((t) => `${s.id}/${t.turn}=${t.ms}ms`));
  log(`LATENCY: ${latencies.join(' ')}`);

  const anyFallback = Object.values(runs).some((s) => s.stoppedBy === 'fallback');
  if (results.some((r) => r.status === 'FAIL')) {
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
