import { AppService } from './app.service';
import { CHANNELS } from './interfaces/enums';

const BOOKING_URL = 'https://www.orient99.com/early_booking/lonicera-resort-spa';

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

  // protects=a retry that answers in time leaves no timer running behind the reply; fails_when=the retry's own timer or the request guard is not cleared once the reply is ready; no_claim=timers on the timeout path, which have already fired by then
  it('clears its timers when the retry answers in time', async () => {
    jest.useFakeTimers();

    try {
      process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';
      const service = new AppService({} as any);

      const create = jest.fn()
        .mockResolvedValueOnce({ output_text: '🏨 Хотел: LONICERA RESORT & SPA\n🔗 Резервация: ', output: [] })
        .mockResolvedValueOnce({ output_text: `🏨 Хотел: LONICERA RESORT & SPA\n🔗 Резервация: ${BOOKING_URL}`, output: [] });
      (service as any).openai = { responses: { create } };

      const result = await service.chat({ thread_id: 'conv_test', message: 'Колко струва?', channel: CHANNELS.MESSENGER });

      expect(result.response).toContain(BOOKING_URL);
      expect(jest.getTimerCount()).toBe(0);
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
