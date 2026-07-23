import { AXEL_INSTRUCTIONS } from './instructions';

const { capture_lead_config, capture_lead } = require('../tools/capture-lead');
const { capture_complaint_config, capture_complaint } = require('../tools/capture-complaint');
const { fetch_date_config, fetch_date } = require('../tools/fetch-date');
const { fetch_time_config, fetch_time } = require('../tools/fetch-time');
const { transfer_to_human_config, transfer_to_human } = require('../tools/transfer-to-human');

export const MODEL = 'gpt-4o';

export const INSTRUCTIONS = AXEL_INSTRUCTIONS;

// Vector store / files backing the assistant's knowledge base, mirrored
// from the live OpenAI assistant (asst_wbikeqOeWoxbLxRAE5VlrhJr) as of 2026-07-23.
const VECTOR_STORE_ID = 'vs_69e4c252b3f08191a2b8c40396220d7c';
const CODE_INTERPRETER_FILE_IDS = ['file-9K9jXy634wVu2Xt38AQHMP', 'file-4zYVPhMmhJHcd197q7tmRG'];

export const TOOLS = [
  { type: 'file_search', vector_store_ids: [VECTOR_STORE_ID] },
  { type: 'code_interpreter', container: { type: 'auto', file_ids: CODE_INTERPRETER_FILE_IDS } },
  capture_lead_config,
  capture_complaint_config,
  fetch_date_config,
  fetch_time_config,
  transfer_to_human_config,
];

export const SUPPORTED_ACTIONS = {
  capture_lead,
  capture_complaint,
  fetch_date,
  fetch_time,
  transfer_to_human,
};
