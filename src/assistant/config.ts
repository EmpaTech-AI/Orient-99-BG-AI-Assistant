import { AXEL_INSTRUCTIONS } from './instructions';
import { CHANNELS } from '../interfaces/enums';

const { capture_lead_config, capture_lead } = require('../tools/capture-lead');
const { capture_complaint_config, capture_complaint } = require('../tools/capture-complaint');
const { fetch_date_config, fetch_date } = require('../tools/fetch-date');
const { fetch_time_config, fetch_time } = require('../tools/fetch-time');
const { search_offers_config, search_offers } = require('../tools/search-offers');
const { transfer_to_human_config, transfer_to_human, handoff_not_sent_marker } = require('../tools/transfer-to-human');

// Marker transfer_to_human returns when it deliberately didn't notify the team.
export const HANDOFF_NOT_SENT_MARKER: string = handoff_not_sent_marker;

// gpt-6-luna replaced gpt-4o on 2026-11-03 (ClickUp 869fnmpyu). OpenAI shuts
// gpt-4o down on 2027-01-14 and names gpt-6-luna as its replacement. In the
// replay gpt-4o ignored a correct file_search hit and doubled prices, gpt-4.1
// substituted a similar hotel and gpt-5.4-mini paired a hotel with another
// hotel's booking link. Low reasoning keeps a turn well inside the 32s
// timeout guard in app.service.ts.
export const MODEL = 'gpt-6-luna';

// Sent on every responses.create call. Only reasoning models accept it: if
// MODEL changes to one without reasoning (gpt-4o, gpt-4.1), remove this too,
// or every call fails with a 400 and the client only gets the fallback reply.
export const REASONING = { effort: 'low' as const };

export const INSTRUCTIONS = AXEL_INSTRUCTIONS;

// Social channels (Messenger, Instagram) are reached through GHL/Make.com,
// which forward the client's channel alongside the message. Webchat is
// unrestricted and keeps its existing behavior.
export const CHANNEL_CHAR_LIMITS: Partial<Record<CHANNELS, number>> = {
  [CHANNELS.MESSENGER]: 600,
  [CHANNELS.INSTAGRAM]: 450,
};

// Offers come from the search_offers tool (data/offers.json). The old hosted
// file_search over the April 2026 scrape was removed; its store is left
// untouched for rollback: vs_69e4c252b3f08191a2b8c40396220d7c. To roll back,
// revert the PR (the old prompt and file_search come back together).
// The two company documents below stay in code_interpreter.
const CODE_INTERPRETER_FILE_IDS = ['file-9K9jXy634wVu2Xt38AQHMP', 'file-4zYVPhMmhJHcd197q7tmRG'];

export const TOOLS = [
  { type: 'code_interpreter', container: { type: 'auto', file_ids: CODE_INTERPRETER_FILE_IDS } },
  capture_lead_config,
  capture_complaint_config,
  fetch_date_config,
  fetch_time_config,
  transfer_to_human_config,
  search_offers_config,
];

export const SUPPORTED_ACTIONS = {
  capture_lead,
  capture_complaint,
  fetch_date,
  fetch_time,
  transfer_to_human,
  search_offers,
};
