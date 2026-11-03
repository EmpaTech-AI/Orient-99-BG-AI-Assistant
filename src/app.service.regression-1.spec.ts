// Regression: ISSUE-002 — an Instagram reply promised a colleague without calling transfer_to_human
// Found by /qa on 2026-11-03
// Report: .gstack/qa-reports/run-20261103T135142Z/qa-report-orient99-api-2026-11-03.md
import { AppService } from './app.service';
import { SUPPORTED_ACTIONS } from './assistant/config';
import { CHANNELS } from './interfaces/enums';

describe('AppService colleague promise without a handoff', () => {
  let handoff: jest.SpyInstance;

  beforeEach(() => {
    // The real tool would post to the webhook in .env.
    handoff = jest.spyOn(SUPPORTED_ACTIONS, 'transfer_to_human').mockResolvedValue('Transfer to human acknowledged.');
  });

  afterEach(() => {
    handoff.mockRestore();
  });

  function serviceReplying(outputText: string): AppService {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';
    const service = new AppService({} as any);
    (service as any).openai = { responses: { create: jest.fn().mockResolvedValueOnce({ output_text: outputText, output: [] }) } };
    return service;
  }

  // Value: protects=a social-channel reply that promises a colleague always notifies the team and tells the client how to resume; fails_when=the promise reaches the client while transfer_to_human was never called; why_new=app.service.spec.ts only covers the client asking for a human; seam=none; no_claim=how often the live model omits the call (mocked model)
  it('calls transfer_to_human and adds the contacts when an Instagram reply promises a colleague', async () => {
    const service = serviceReplying('Здравейте! За Lonicera Resort & Spa в Алания не откривам автобусна оферта за 7 нощувки. Колега от екипа ще Ви изпрати информация.');

    const result = await service.chat({ thread_id: 'conv_test', message: 'Имате ли оферта с автобус?', channel: CHANNELS.INSTAGRAM, contact_id: 'c-1' });

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff.mock.calls[0][1]).toEqual({ thread_id: 'conv_test', channel: CHANNELS.INSTAGRAM, contact_id: 'c-1' });
    expect(result.response).toContain('Колега от екипа ще Ви изпрати информация.');
    expect(result.response).toContain('0700 144 34');
    expect(result.response).toContain('продължи разговора');
    expect(result.response.length).toBeLessThanOrEqual(450);
  });

  // Value: protects=an offer to connect, or a promise on webchat (where the team needs a phone first), does not hand the client over; fails_when=a question like "Желаете ли да Ви свържа с колега?" or a webchat reply triggers transfer_to_human; why_new=the guard above needs a negative; seam=none; no_claim=other wordings of an offer to connect
  it('does not hand over for an offer to connect or on webchat', async () => {
    await serviceReplying('Точните цени са на линка. Желаете ли да Ви свържа с колега?').chat({ thread_id: 'conv_test', message: 'Колко струва?', channel: CHANNELS.MESSENGER });
    await serviceReplying('Ако оставите телефон, колега от екипа ще Ви изпрати оферта.').chat({ thread_id: 'conv_test', message: 'Има ли 2027?', channel: CHANNELS.WEBCHAT });

    expect(handoff).not.toHaveBeenCalled();
  });
});
