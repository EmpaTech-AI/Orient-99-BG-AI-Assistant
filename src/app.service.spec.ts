import { AppService } from './app.service';
import { CHANNELS } from './interfaces/enums';
import { SUPPORTED_ACTIONS } from './assistant/config';

const BOOKING_URL = 'https://www.orient99.com/early_booking/lonicera-resort-spa';

// app.service.ts loads .env at import, so a real tool here would post to the
// production webhook or Airtable.
let toolSpies: jest.SpyInstance[];

beforeEach(() => {
  toolSpies = ['transfer_to_human', 'capture_lead', 'capture_complaint'].map((name) => jest.spyOn(SUPPORTED_ACTIONS, name as any).mockResolvedValue('ok'));
});

afterEach(() => {
  toolSpies.forEach((spy) => spy.mockRestore());
});

describe('AppService broken-link retry', () => {
  // protects=a cut-off Messenger booking link is retried once as a developer message (not as the client) and the fixed, formatted reply is returned; fails_when=no retry, more than one retry, the retry is sent with role "user" or without the language instruction, or the broken/unformatted reply is returned; no_claim=how the live model answers the retry (not exercised against OpenAI)
  it('retries once as a developer message and returns the formatted retry reply', async () => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';
    const service = new AppService({} as any);

    const create = jest.fn()
      .mockResolvedValueOnce({ output_text: '🏨 Хотел: LONICERA RESORT & SPA\n🔗 Резервация: ', output: [] })
      .mockResolvedValueOnce({ output_text: `![Снимка на хотела](https://www.orient99.com/images/test.jpg)\n🏨 Хотел: LONICERA RESORT & SPA\n🔗 Резервация: ${BOOKING_URL}`, output: [] });
    (service as any).openai = { responses: { create } };

    const result = await service.chat({ thread_id: 'conv_test', message: 'Колко струва?', channel: CHANNELS.MESSENGER });

    expect(create).toHaveBeenCalledTimes(2);
    const retryInput = create.mock.calls[1][0].input[0];
    expect(retryInput.role).toBe('developer');
    expect(retryInput.content).toContain('същия език');
    expect(result.response).toContain(BOOKING_URL);
    expect(result.response).not.toContain('![');
  });

  // protects=a failed retry does not cost the client the reply they already had; fails_when=an error on the retry call turns the whole turn into the "Моля изчакайте" fallback; no_claim=the retry running past the 32s guard (timer path, not exercised here)
  it('keeps the first reply when the retry call fails', async () => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';
    const service = new AppService({} as any);

    const create = jest.fn()
      .mockResolvedValueOnce({ output_text: '🏨 Хотел: LONICERA RESORT & SPA\n🔗 Резервация: ', output: [] })
      .mockRejectedValueOnce(new Error('429 rate limited'));
    (service as any).openai = { responses: { create } };

    const result = await service.chat({ thread_id: 'conv_test', message: 'Колко струва?', channel: CHANNELS.MESSENGER });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.response).toContain('LONICERA RESORT & SPA');
    expect(result.response).not.toContain('Моля изчакайте');
  });

  // protects=a retry that never answers does not cost the client the reply they already had; fails_when=the retry is awaited without its own time limit, so the 32s guard returns "Моля изчакайте" instead; no_claim=the exact moment the retry is abandoned, or that the abandoned request is cancelled (it is not)
  it('keeps the first reply when the retry never answers', async () => {
    jest.useFakeTimers();

    try {
      process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';
      const service = new AppService({} as any);

      const create = jest.fn()
        .mockResolvedValueOnce({ output_text: '🏨 Хотел: LONICERA RESORT & SPA\n🔗 Резервация: ', output: [] })
        .mockReturnValueOnce(new Promise(() => {}));
      (service as any).openai = { responses: { create } };

      const pending = service.chat({ thread_id: 'conv_test', message: 'Колко струва?', channel: CHANNELS.MESSENGER });
      await jest.advanceTimersByTimeAsync(33_000);
      const result = await pending;

      expect(create).toHaveBeenCalledTimes(2);
      expect(result.response).toContain('LONICERA RESORT & SPA');
      expect(result.response).not.toContain('Моля изчакайте');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('AppService main reply formatting', () => {
  // protects=the first Messenger reply itself is cleaned of image, bold and markdown-link syntax, without an extra OpenAI round-trip; fails_when=the main path skips formatForChannel, or a markdown-wrapped link is taken for a broken one and retried; no_claim=webchat output, covered by channel-format.spec.ts
  it('formats the first Messenger reply and does not retry a markdown-wrapped link', async () => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';
    const service = new AppService({} as any);

    const create = jest.fn().mockResolvedValueOnce({
      output_text: `![Снимка на хотела](https://www.orient99.com/images/test.jpg)\n🏨 Хотел: **LONICERA RESORT & SPA**\n🔗 Резервация: [Виж офертата](${BOOKING_URL})`,
      output: [],
    });
    (service as any).openai = { responses: { create } };

    const result = await service.chat({ thread_id: 'conv_test', message: 'Оферта?', channel: CHANNELS.MESSENGER });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.response).toBe(`🏨 Хотел: LONICERA RESORT & SPA\n🔗 Резервация: ${BOOKING_URL}`);
  });
});

describe('AppService malformed tool arguments', () => {
  // Value: protects=a tool call whose arguments are not valid JSON does not end the turn with the waiting message; the model gets an invalid_input output and answers; fails_when=JSON.parse throws out of resolveToolCalls (client sees "Моля изчакайте", no handover) or the tool runs with garbage; why_new=no existing test sends a broken arguments string; seam=none; no_claim=how the live model reacts to the error output (stubbed client)
  it('returns invalid_input to the model and continues the turn', async () => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';
    const service = new AppService({} as any);
    const create = jest.fn()
      .mockResolvedValueOnce({ output_text: '', output: [{ type: 'function_call', name: 'capture_lead', call_id: 'c1', arguments: '{"name": ' }] })
      .mockResolvedValueOnce({ output_text: `🏨 Хотел: LONICERA RESORT & SPA\n🔗 Резервация: ${BOOKING_URL}`, output: [] });
    (service as any).openai = { responses: { create } };

    const result = await service.chat({ thread_id: 'conv_test', message: 'Оферта?', channel: CHANNELS.MESSENGER });

    expect(create).toHaveBeenCalledTimes(2);
    const followUp = create.mock.calls[1][0].input[0];
    expect(followUp).toMatchObject({ type: 'function_call_output', call_id: 'c1' });
    expect(JSON.parse(followUp.output)).toEqual({ error: 'invalid_input', fields: ['arguments'] });
    expect(SUPPORTED_ACTIONS.capture_lead).not.toHaveBeenCalled();
    expect(result.response).toContain(BOOKING_URL);
    expect(result.response).not.toContain('Моля изчакайте');
  });
});
