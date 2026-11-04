// Regression: ISSUE-002 — an Instagram reply promised a colleague without calling transfer_to_human
// Found by /qa on 2026-11-03
// Report: .gstack/qa-reports/run-20261103T135142Z/qa-report-orient99-api-2026-11-03.md
import { AppService } from './app.service';
import { SUPPORTED_ACTIONS } from './assistant/config';
import { CHANNELS } from './interfaces/enums';

const BOOKING_URL = 'https://www.orient99.com/early_booking/lonicera-resort-spa?from=SOF&nights=7';

const OFFER_WITH_PROMISE = [
  'Здравейте! Ето офертата за Lonicera Resort & Spa:',
  '🏨 Хотел: Lonicera Resort & Spa',
  '📍 Локация: Алания, Турция',
  '🍽️ Изхранване: All Inclusive',
  '💰 Цена: актуалните цени по дати са на линка за резервация',
  `🔗 Резервация: ${BOOKING_URL}`,
  'Колега от екипа ще Ви потърси за точните дати.',
].join('\n');

const HANDOFF_CALL = { type: 'function_call', name: 'transfer_to_human', call_id: 'call_1', arguments: '{"reason":"x","customer_message":"x","customer_name":"","customer_phone":"","customer_email":""}' };

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe('AppService colleague promise without a handoff', () => {
  let handoff: jest.SpyInstance;
  let lead: jest.SpyInstance;
  let complaint: jest.SpyInstance;

  beforeEach(() => {
    // The real tools would post to the webhook and Airtable in .env.
    handoff = jest.spyOn(SUPPORTED_ACTIONS, 'transfer_to_human').mockResolvedValue('Transfer to human acknowledged.');
    lead = jest.spyOn(SUPPORTED_ACTIONS, 'capture_lead').mockResolvedValue('Lead stored successfully.');
    complaint = jest.spyOn(SUPPORTED_ACTIONS, 'capture_complaint').mockResolvedValue('Complaint stored successfully.');
  });

  afterEach(() => {
    handoff.mockRestore();
    lead.mockRestore();
    complaint.mockRestore();
  });

  function serviceWith(create: jest.Mock): AppService {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';
    const service = new AppService({} as any);
    (service as any).openai = { responses: { create } };
    return service;
  }

  function serviceReplying(outputText: string): AppService {
    return serviceWith(jest.fn().mockResolvedValueOnce({ output_text: outputText, output: [] }));
  }

  function serviceCalling(tool: string, reply: string): AppService {
    return serviceWith(jest.fn()
      .mockResolvedValueOnce({ output_text: '', output: [{ type: 'function_call', name: tool, call_id: 'call_1', arguments: '{}' }] })
      .mockResolvedValueOnce({ output_text: reply, output: [] }));
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

  // Value: protects=common wordings of the promise (plural, "ще се свърже", "наш колега ... ще Ви се обади", a trailing "които желаете") are caught too; fails_when=the pattern or its exemptions let these replies leave the team unnotified; why_new=the test above uses one wording; seam=none; no_claim=wordings in languages other than Bulgarian
  it.each([
    'Колега от екипа ще се свърже с Вас.',
    'Колегите от екипа ще Ви изпратят оферта.',
    'Наш колега ще Ви се обади утре.',
    'В момента нямам актуална оферта. — колега от екипа ни ще Ви пише.',
    'Колега от екипа ще Ви изпрати оферта за датите, които желаете.',
  ])('hands over for the promise "%s"', async (reply) => {
    await serviceReplying(reply).chat({ thread_id: 'conv_test', message: 'Оферта?', channel: CHANNELS.MESSENGER, contact_id: 'c-1' });

    expect(handoff).toHaveBeenCalledTimes(1);
  });

  // Value: protects=each kind of non-promise is exempt on its own (a condition, an offer, a question, a temporal clause, a request for contact details); fails_when=dropping any one exemption hands over a client who asked for nothing and pauses the AI, or blocks lead capture; why_new=the combined negative test below cannot tell the exemptions apart; seam=none; no_claim=other wordings
  it.each([
    'Ако желаете, колега от екипа ще Ви изпрати точната цена.',
    'Желаете ли да Ви свържем — колега от екипа ще Ви се обади.',
    'Да помоля ли колега от екипа, който ще Ви се обади утре?',
    'Колегите ще Ви отговорят, ако имате въпроси.',
    'След като направите резервацията през линка, колегите ще Ви изпратят потвърждение.',
    'Оставете ми име и телефон и колега ще Ви потърси.',
    'Колега от екипа ще Ви се обади при нужда.',
  ])('does not hand over for the non-promise "%s"', async (reply) => {
    await serviceReplying(reply).chat({ thread_id: 'conv_test', message: 'Оферта?', channel: CHANNELS.MESSENGER, contact_id: 'c-1' });

    expect(handoff).not.toHaveBeenCalled();
  });

  // Value: protects=an offer to connect, a condition, stored lead or complaint confirmations, a webchat promise or the client's resume turn does not hand the client over; fails_when=any of these replies triggers transfer_to_human and pauses the AI without the client asking; why_new=covers the non-text exemptions (tools, channel, resume turn); seam=none; no_claim=other wordings of an offer to connect
  it('does not hand over for an offer, a stored capture, webchat or the resume turn', async () => {
    await serviceReplying('Точните цени са на линка. Желаете ли да Ви свържа с колега?').chat({ thread_id: 'conv_test', message: 'Колко струва?', channel: CHANNELS.MESSENGER });
    await serviceReplying('Ако оставите телефон, колега от екипа ще Ви изпрати оферта.').chat({ thread_id: 'conv_test', message: 'Има ли 2027?', channel: CHANNELS.WEBCHAT });
    await serviceReplying('Колега от екипа ще Ви пише скоро, а междувременно ето още информация.').chat({ thread_id: 'conv_test', message: 'продължи разговора', channel: CHANNELS.INSTAGRAM });
    await serviceCalling('capture_lead', 'Благодаря! Колега от екипа ще Ви потърси за офертата.').chat({ thread_id: 'conv_test', message: 'Иван, 0888 123 456, ivan@example.com', channel: CHANNELS.MESSENGER, contact_id: 'c-1' });
    await serviceCalling('capture_complaint', 'Съжаляваме! Колега от екипа ще Ви потърси днес.').chat({ thread_id: 'conv_test', message: 'Оплакване', channel: CHANNELS.MESSENGER, contact_id: 'c-1' });

    expect(handoff).not.toHaveBeenCalled();
  });

  // Value: protects=a capture tool that stored nothing (missing fields, Airtable error) does not suppress the handoff for a promise the client was given; fails_when=a failed capture_lead counts as done and the client waits for a colleague nobody was told about; why_new=the stored-capture case above only covers success; seam=none; no_claim=the capture tools' own validation (mocked tools)
  it('hands over when a capture tool stored nothing', async () => {
    lead.mockResolvedValueOnce('Missing required information. Please provide name, phone, email, and query');

    await serviceCalling('capture_lead', 'Благодаря! Колега от екипа ще Ви потърси за офертата.').chat({ thread_id: 'conv_test', message: 'Иван', channel: CHANNELS.MESSENGER, contact_id: 'c-1' });

    expect(handoff).toHaveBeenCalledTimes(1);
  });

  // Value: protects=an Instagram offer that also promises a colleague keeps its booking link, still tells the client a colleague will follow up, and gains the footer within 450 chars; fails_when=the footer is fitted by cutting the booking line, or the promise after the link is cut away while the team is notified; why_new=the tests above use replies without a link; seam=none; no_claim=how the live model words such a reply
  it('keeps the booking link and the promise when an Instagram offer promises a colleague', async () => {
    const result = await serviceReplying(OFFER_WITH_PROMISE).chat({ thread_id: 'conv_test', message: 'Оферта?', channel: CHANNELS.INSTAGRAM, contact_id: 'c-1' });

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(result.response).toContain(`🔗 Резервация: ${BOOKING_URL}`);
    expect(result.response).toMatch(/Колега от екипа ще/);
    expect(result.response).toContain('0700 144 34');
    expect(result.response.endsWith('продължи разговора')).toBe(true);
    expect(result.response.length).toBeLessThanOrEqual(450);
  });

  // Value: protects=the broken-link retry cannot drop the footer that a handoff requires; fails_when=the handoff is decided before the retry and the retry text replaces the reply with the footer; why_new=no test combines the guard with the retry; seam=none; no_claim=the live retry wording (mocked model)
  it('keeps the footer when the reply also goes through the broken-link retry', async () => {
    const service = serviceWith(jest.fn()
      .mockResolvedValueOnce({ output_text: '🏨 Хотел: Lonicera Resort & Spa\n🔗 Резервация: \nКолега от екипа ще Ви потърси за точните дати.', output: [] })
      .mockResolvedValueOnce({ output_text: OFFER_WITH_PROMISE, output: [] }));

    const result = await service.chat({ thread_id: 'conv_test', message: 'Оферта?', channel: CHANNELS.INSTAGRAM, contact_id: 'c-1' });

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(result.response).toContain(BOOKING_URL);
    expect(result.response).toContain('продължи разговора');
  });

  // Value: protects=a retry in which the model itself calls transfer_to_human is followed by neither a second, forced handoff nor a reply without the footer; fails_when=the guard decides before the retry and the team is notified twice, or the retry's handoff reply lacks the footer; why_new=the second-handoff test below only covers a call in the first pass; seam=none; no_claim=duplicate calls made by the model itself in both passes
  it('notifies the team once and keeps the footer when the retry calls transfer_to_human itself', async () => {
    const service = serviceWith(jest.fn()
      .mockResolvedValueOnce({ output_text: '🏨 Хотел: Lonicera Resort & Spa\n🔗 Резервация: \nКолега от екипа ще Ви потърси за точните дати.', output: [] })
      .mockResolvedValueOnce({ output_text: '', output: [HANDOFF_CALL] })
      .mockResolvedValueOnce({ output_text: OFFER_WITH_PROMISE, output: [] }));

    const result = await service.chat({ thread_id: 'conv_test', message: 'Оферта?', channel: CHANNELS.INSTAGRAM, contact_id: 'c-1' });

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(result.response).toContain(BOOKING_URL);
    expect(result.response.endsWith('продължи разговора')).toBe(true);
  });

  // Value: protects=the guard never sends a second handoff when the model itself already called transfer_to_human this turn; fails_when=the calledTools check is dropped and the team is notified twice; why_new=the tests above only cover the model omitting the call; seam=none; no_claim=real tool side effects (tool mocked; unit only)
  it('does not hand over a second time when the model already called transfer_to_human', async () => {
    await serviceCalling('transfer_to_human', 'Колега от екипа ще Ви изпрати информация.').chat({ thread_id: 'conv_test', message: 'Имате ли оферта с автобус?', channel: CHANNELS.MESSENGER, contact_id: 'c-1' });

    expect(handoff).toHaveBeenCalledTimes(1);
  });

  // Value: protects=after any handoff on Instagram the reply ends with one copy of the contacts and the resume line and still states the promise, even when the model restated an offer and the text is over the limit; fails_when=the length cut drops the contacts or the promise after the booking line, or the contacts appear twice; why_new=the tests above only cover forced handoffs; seam=none; no_claim=how the live model formats its own contacts block
  it('ends every handoff reply with one copy of the contacts and the resume line', async () => {
    const contacts = 'Национален телефон: 0700 144 34  \nПловдив: 032 622 174  \nСофия: 00359 2 987 01 07  \nEmail: office@orient99.com';
    const service = serviceWith(jest.fn()
      .mockResolvedValueOnce({ output_text: '', output: [HANDOFF_CALL] })
      .mockResolvedValueOnce({ output_text: `${OFFER_WITH_PROMISE}\n\n${contacts}\n\nАко желаете да продължите разговора с AI асистента, напишете: продължи разговора`, output: [] }));

    const result = await service.chat({ thread_id: 'conv_test', message: 'Каква е цената за двама?', channel: CHANNELS.INSTAGRAM, contact_id: 'c-1' });

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(result.response.length).toBeLessThanOrEqual(450);
    expect(result.response).toContain(`🔗 Резервация: ${BOOKING_URL}`);
    expect(result.response).toMatch(/Колега от екипа ще/);
    expect(occurrences(result.response, '0700 144 34')).toBe(1);
    expect(result.response.endsWith('продължи разговора')).toBe(true);
  });

  // Value: protects=a reply that already lists the national phone on the promise's own line keeps the promise, one copy of the contacts and gains the resume line; fails_when=the whole line with the phone is dropped (taking the promise with it), the contacts appear twice, or the resume line is skipped; why_new=the first test only covers a reply without contacts; seam=none; no_claim=none beyond protects (mocked model and tool)
  it('keeps the promise and one copy of the contacts when the reply already has the phone', async () => {
    const result = await serviceReplying('Колега от екипа ще Ви изпрати информация. Национален телефон: 0700 144 34').chat({ thread_id: 'conv_test', message: 'Автобус?', channel: CHANNELS.INSTAGRAM, contact_id: 'c-1' });

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(result.response).toContain('Колега от екипа ще Ви изпрати информация.');
    expect(occurrences(result.response, '0700 144 34')).toBe(1);
    expect(result.response.endsWith('продължи разговора')).toBe(true);
  });

  // Value: protects=a failing forced-handoff webhook never breaks or delays the client's reply; fails_when=the .catch on the non-awaited call is removed and the rejection becomes the fallback or an unhandled rejection; why_new=every other test mocks the tool resolving; seam=none; no_claim=real webhook behaviour (tool mocked)
  it('still replies with the footer when the forced handoff fails', async () => {
    handoff.mockRejectedValueOnce(new Error('webhook 500'));

    const result = await serviceReplying('Колега от екипа ще Ви изпрати информация.').chat({ thread_id: 'conv_test', message: 'Оферта?', channel: CHANNELS.INSTAGRAM, contact_id: 'c-1' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.response).not.toContain('Моля изчакайте');
    expect(result.response.endsWith('продължи разговора')).toBe(true);
  });

  // Value: protects=once the 32s guard has already sent the fallback, a late reply does not hand the client over; fails_when=the guard still calls transfer_to_human after the client got "Моля изчакайте" and never saw the promise; why_new=no test covers side effects after the request timeout; seam=none; no_claim=tool calls the model itself makes after the timeout
  it('does not force a handoff after the request timed out', async () => {
    jest.useFakeTimers();

    try {
      const late = new Promise((resolve) => setTimeout(() => resolve({ output_text: 'Колега от екипа ще Ви изпрати информация.', output: [] }), 33_000));
      const service = serviceWith(jest.fn().mockReturnValueOnce(late));

      const pending = service.chat({ thread_id: 'conv_test', message: 'Оферта?', channel: CHANNELS.MESSENGER, contact_id: 'c-1' });
      await jest.advanceTimersByTimeAsync(34_000);
      const result = await pending;

      expect(result.response).toContain('Моля изчакайте');
      expect(handoff).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
