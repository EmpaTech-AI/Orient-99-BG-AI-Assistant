import { CHANNELS } from './interfaces/enums';
import { formatForChannel, stripPriceDisclaimer, isReservationLinkBroken, leaksReasoning, enforceChannelLimit } from './channel-format';

const BOOKING_URL = 'https://www.orient99.com/early_booking/lonicera-resort_spa?from=SOF&nights=7&room=dbl%20sea';

const OFFER = [
  'Ето офертата за хотела:',
  '',
  '![Снимка на хотела](https://www.orient99.com/images/test/c-fakepath-Lonicera%20Resort.jpg?w=266&h=170)',
  '',
  '🏨 Хотел: **LONICERA RESORT & SPA**',
  '💰 Цена: от 595 € на възрастен в двойна стая',
  `🔗 Резервация: [Виж офертата](${BOOKING_URL})`,
].join('\n');

describe('formatForChannel', () => {
  // protects=no raw image markdown reaches a Messenger client; fails_when=the "![...](...)" line or the blank line after it survives; no_claim=images with nested brackets or ")" in the URL
  it('removes the image line and the newline after it on Messenger', () => {
    const input = 'Ето офертата:\n![Снимка на офертата](https://www.orient99.com/images/TR/Didim%20new9.jpg?w=266&h=170)\n🏖️ Оферта: Дидим';

    expect(formatForChannel(input, CHANNELS.MESSENGER)).toBe('Ето офертата:\n🏖️ Оферта: Дидим');
  });

  // protects=a Messenger client sees a clickable bare URL instead of "[label](url)"; fails_when=the markdown link survives or the label is kept instead of the URL; no_claim=links whose label contains "]"
  it('turns an http markdown link into its bare URL on Messenger', () => {
    const input = 'Вижте: [Виж офертата](https://www.orient99.com/early_booking/didim)';

    expect(formatForChannel(input, CHANNELS.MESSENGER)).toBe('Вижте: https://www.orient99.com/early_booking/didim');
  });

  // protects=no "**" markers reach a Messenger client; fails_when=any "**" survives, including bold text that contains a single "*"; no_claim=single-"*" italics, which are left as they are on purpose
  it('removes bold markers on Messenger', () => {
    const input = '🏨 Хотел: **LONICERA RESORT & SPA**\n**Хотел 5* в Алания**';

    expect(formatForChannel(input, CHANNELS.MESSENGER)).toBe('🏨 Хотел: LONICERA RESORT & SPA\nХотел 5* в Алания');
  });

  // protects=Instagram gets the same cleanup as Messenger on a realistic offer; fails_when=any "![", "](" or "**" survives or the booking URL is lost; no_claim=the 450-character limit, which enforceChannelLimit handles
  it('removes images, links and bold on Instagram', () => {
    const output = formatForChannel(OFFER, CHANNELS.INSTAGRAM);

    expect(output).not.toContain('![');
    expect(output).not.toContain('](');
    expect(output).not.toContain('**');
    expect(output).toContain(`🔗 Резервация: ${BOOKING_URL}`);
  });

  // protects=webchat, which renders markdown, behaves exactly as before; fails_when=any byte of webchat output changes, including surrounding whitespace; no_claim=anything about Messenger/Instagram
  it('returns webchat text unchanged', () => {
    const input = `  ${OFFER}\n`;

    expect(formatForChannel(input, CHANNELS.WEBCHAT)).toBe(input);
  });

  // protects=the booking URL is copied character for character; fails_when=any of "-", "_", "?", "&" or "%20" in the URL is altered; no_claim=URLs containing a space or ")"
  it('keeps a booking URL intact on Messenger, as a link target and as bare text', () => {
    const input = `[Резервирай](${BOOKING_URL})\n🔗 Резервация: ${BOOKING_URL}`;

    expect(formatForChannel(input, CHANNELS.MESSENGER)).toBe(`${BOOKING_URL}\n🔗 Резервация: ${BOOKING_URL}`);
  });
});

describe('helpers moved out of AppService', () => {
  // protects=the broken-link retry still triggers on a cut-off booking line and not on a full one; fails_when=detection changed in the move; no_claim=that the retry itself works (see app.service.spec.ts)
  it('isReservationLinkBroken flags a missing URL and accepts a full one', () => {
    expect(isReservationLinkBroken('🔗 Резервация: …')).toBe(true);
    expect(isReservationLinkBroken('🔗 Резервация:')).toBe(true);
    expect(isReservationLinkBroken(`🔗 Резервация: ${BOOKING_URL}`)).toBe(false);
    expect(isReservationLinkBroken('Здравейте!')).toBe(false);
  });

  // protects=Messenger replies stay within 600 characters; fails_when=the cut is longer than the limit, lacks "…", or webchat is cut; no_claim=where the cut lands relative to the booking URL
  it('enforceChannelLimit cuts long Messenger text and leaves webchat alone', () => {
    const long = 'дума '.repeat(140);
    const cut = enforceChannelLimit(long, CHANNELS.MESSENGER);

    expect(long.length).toBe(700);
    expect(cut.length).toBeLessThanOrEqual(600);
    expect(cut.endsWith('…')).toBe(true);
    expect(enforceChannelLimit(long, CHANNELS.WEBCHAT)).toBe(long);
  });

  // protects=the price disclaimer, whole or self-truncated, is dropped on Messenger and kept on webchat; fails_when=the move changed either behaviour; no_claim=disclaimer wordings other than "Имайте предвид, че цените на офертите са ориент…"
  it('stripPriceDisclaimer removes the disclaimer on Messenger only', () => {
    const input = 'Оферта\n\n*Имайте предвид, че цените на офертите са ориентировъчни.*';

    expect(stripPriceDisclaimer(input, CHANNELS.MESSENGER)).toBe('Оферта');
    expect(stripPriceDisclaimer('Оферта\n*Имайте предвид, че цените на офертите са ориентир…', CHANNELS.MESSENGER)).toBe('Оферта');
    expect(stripPriceDisclaimer(input, CHANNELS.WEBCHAT)).toBe(input);
  });

  // protects=a Messenger reply that merely talks about prices is delivered whole; fails_when=a sentence like "Имайте предвид, че цените по дати са на линка" is taken for the disclaimer and the reply (or its booking link) is cut away; no_claim=disclaimer wordings other than "цените на офертите"
  it('stripPriceDisclaimer never empties a reply or drops its booking link', () => {
    const leading = `Имайте предвид, че цените по дати са на линка за резервация.\n🏨 Хотел: Lonicera Resort & Spa\n🔗 Резервация: ${BOOKING_URL}`;
    const middle = `🏨 Хотел: Lonicera Resort & Spa\nИмайте предвид, че цените на офертите се менят по дати.\n🔗 Резервация: ${BOOKING_URL}`;

    expect(stripPriceDisclaimer(leading, CHANNELS.MESSENGER)).toBe(leading);
    expect(stripPriceDisclaimer(middle, CHANNELS.MESSENGER)).toBe(middle);
  });

  // protects=the booking link and the offer fields survive the Instagram length cut; the intro is what gets shortened; fails_when=the cut lands inside or before the "🔗 Резервация:" line, or drops a field line while keeping the intro; no_claim=replies whose fields plus booking line alone exceed the limit
  it('enforceChannelLimit shortens the intro, never the offer fields or the booking line', () => {
    const offer = [
      'Здравейте! ' + 'Това е дълго въведение към офертата. '.repeat(9),
      '🏨 Хотел: Lonicera Resort & Spa',
      '💰 Цена: актуалните цени по дати са на линка за резервация',
      `🔗 Резервация: ${BOOKING_URL}`,
    ].join('\n');
    const cut = enforceChannelLimit(offer, CHANNELS.INSTAGRAM);

    expect(offer.length).toBeGreaterThan(450);
    expect(cut.length).toBeLessThanOrEqual(450);
    expect(cut.startsWith('Здравейте!')).toBe(true);
    expect(cut).toContain('…\n🏨 Хотел: Lonicera Resort & Spa\n💰 Цена: актуалните цени по дати са на линка за резервация\n');
    expect(cut.endsWith(`🔗 Резервация: ${BOOKING_URL}`)).toBe(true);
    expect(isReservationLinkBroken(cut)).toBe(false);
  });
});

describe('leaksReasoning', () => {
  it('spots the model\'s own notes in a reply and leaves a normal offer alone', () => {
    expect(leaksReasoning('Да, има оферта със самолетен? Sorry autobús. Need Bulgarian clean.')).toBe(true);
    expect(leaksReasoning('Sure, let me know the dates and we should find a hotel.')).toBe(false);
    expect(leaksReasoning(`Ето офертата:\n🏨 Хотел: LONICERA RESORT & SPA\n🔗 Резервация: ${BOOKING_URL}`)).toBe(false);
  });
});
