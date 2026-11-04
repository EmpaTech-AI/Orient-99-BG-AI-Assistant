import { CHANNELS } from './interfaces/enums';
import { formatForChannel, stripPriceDisclaimer, isReservationLinkBroken, enforceChannelLimit } from './channel-format';

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

  // protects=ordinary replies are not altered on Messenger; fails_when=plain text without markdown changes; no_claim=text with leading/trailing whitespace, which is trimmed
  it('leaves plain text without markdown unchanged on Messenger', () => {
    const input = 'Здравейте! С какво мога да Ви помогна?';

    expect(formatForChannel(input, CHANNELS.MESSENGER)).toBe(input);
  });

  // protects=email and phone links in the contact block read naturally on Messenger; fails_when=a "mailto:" or "tel:" target is shown instead of its label, or the markdown survives; no_claim=other non-http schemes beyond falling back to the label
  it('turns mailto and tel links into their labels on Messenger', () => {
    const input = 'Пишете на [office@example.com](mailto:office@example.com) или на [0700 144 34](tel:070014434).';

    expect(formatForChannel(input, CHANNELS.MESSENGER)).toBe('Пишете на office@example.com или на 0700 144 34.');
  });

  // protects=a booking URL written on the line after "🔗 Резервация:" is moved onto the label line, where the length cut and the broken-link check look for it; fails_when=the URL stays on its own line; no_claim=a URL separated from its label by other text
  it('joins a booking URL written on the next line to its label on Messenger', () => {
    const input = `🏨 Хотел: LONICERA RESORT & SPA\n🔗 Резервация:\n${BOOKING_URL}`;

    expect(formatForChannel(input, CHANNELS.MESSENGER)).toBe(`🏨 Хотел: LONICERA RESORT & SPA\n🔗 Резервация: ${BOOKING_URL}`);
  });

  // protects=an angle-bracket autolink ("<https://...>") reaches Messenger as a bare URL, so the broken-link check does not retry a complete link; fails_when=the brackets survive and "Резервация: <https://..." is taken for a cut-off link; no_claim=autolinks with spaces or ">" inside the URL
  it('unwraps an angle-bracket booking link on Messenger', () => {
    const output = formatForChannel(`🔗 Резервация: <${BOOKING_URL}>`, CHANNELS.MESSENGER);

    expect(output).toBe(`🔗 Резервация: ${BOOKING_URL}`);
    expect(isReservationLinkBroken(output)).toBe(false);
    expect(formatForChannel(`🔗 Резервация: [линк](<${BOOKING_URL}>)`, CHANNELS.MESSENGER)).toBe(`🔗 Резервация: ${BOOKING_URL}`);
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

  // protects=a price answer that happens to open with the disclaimer's first words reaches the client whole; fails_when="Имайте предвид, че цените на офертите се променят по дати..." is taken for the disclaimer and cut away; no_claim=any other sentence about prices
  it('stripPriceDisclaimer keeps a price answer that opens with the disclaimer words', () => {
    const input = 'Разбира се!\n\nИмайте предвид, че цените на офертите се променят по дати. Колега от екипа може да потвърди точната цена за Вашите дати - желаете ли да Ви свържа?';

    expect(stripPriceDisclaimer(input, CHANNELS.MESSENGER)).toBe(input);
  });

  // protects=a Messenger reply that merely talks about prices is delivered whole; fails_when=a sentence like "Имайте предвид, че цените по дати са на линка" is taken for the disclaimer and the reply (or its booking link) is cut away; no_claim=disclaimer wordings other than "цените на офертите"
  it('stripPriceDisclaimer never empties a reply or drops its booking link', () => {
    const leading = `Имайте предвид, че цените по дати са на линка за резервация.\n🏨 Хотел: Lonicera Resort & Spa\n🔗 Резервация: ${BOOKING_URL}`;
    const middle = `🏨 Хотел: Lonicera Resort & Spa\nИмайте предвид, че цените на офертите се менят по дати.\n🔗 Резервация: ${BOOKING_URL}`;

    expect(stripPriceDisclaimer(leading, CHANNELS.MESSENGER)).toBe(leading);
    expect(stripPriceDisclaimer(middle, CHANNELS.MESSENGER)).toBe(middle);
  });

  // protects=only the "цените на офертите" disclaimer is stripped, not any closing sentence about prices; fails_when=a last line like "Имайте предвид, че цените по дати се менят." after the booking link is removed on Messenger; no_claim=other disclaimer wordings
  it('stripPriceDisclaimer keeps a closing price sentence that is not the disclaimer', () => {
    const input = `🏨 Хотел: Lonicera Resort & Spa\n🔗 Резервация: ${BOOKING_URL}\nИмайте предвид, че цените по дати се менят.`;

    expect(stripPriceDisclaimer(input, CHANNELS.MESSENGER)).toBe(input);
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

  // protects=text after the booking line is dropped before anything in the offer; fails_when=a field line (🏨, 📍, 🍽️, 💰, 🚌) or the intro is cut while a closing sentence after the link survives; no_claim=how a reply without a booking line is cut
  it('enforceChannelLimit drops text after the booking line first', () => {
    const kept = [
      'Ето офертата:',
      '🏨 Хотел: Lonicera Resort & Spa',
      '📍 Локация: Алания, Турция',
      '🍽️ Изхранване: All Inclusive',
      '💰 Цена: актуалните цени по дати са на линка за резервация',
      '🚌 Транспорт: Самолет от София',
      `🔗 Резервация: ${BOOKING_URL}`,
    ].join('\n');
    const offer = `${kept}\n${'Ако искате, колега от екипа ще потвърди точната цена за Вашите дати. '.repeat(3)}`;

    expect(offer.length).toBeGreaterThan(450);
    expect(enforceChannelLimit(offer, CHANNELS.INSTAGRAM)).toBe(kept);
  });

  // protects=when the offer fields plus the booking line alone exceed the limit, the intro goes, the fields are shortened from the end and the booking line is kept whole; fails_when=the intro survives while the hotel line is cut, or the booking line is cut; no_claim=a booking line that is longer than the limit by itself
  it('enforceChannelLimit drops the intro first when the fields alone do not fit', () => {
    const link = `🔗 Резервация: ${BOOKING_URL}&${'x'.repeat(190)}`;
    const text = [
      'Здравейте! ' + 'Това е въведение към офертата. '.repeat(5),
      '🏨 Хотел: Lonicera Resort & Spa',
      '📍 Локация: Алания, Турция',
      '🍽️ Изхранване: All Inclusive',
      '💰 Цена: актуалните цени по дати са на линка за резервация',
      '🚌 Транспорт: Самолет от София',
      link,
    ].join('\n');
    const cut = enforceChannelLimit(text, CHANNELS.INSTAGRAM);

    expect(cut.length).toBeLessThanOrEqual(450);
    expect(cut.startsWith('🏨 Хотел: Lonicera Resort & Spa\n')).toBe(true);
    expect(cut).toContain('…');
    expect(cut.endsWith(`\n${link}`)).toBe(true);
    expect(isReservationLinkBroken(cut)).toBe(false);
  });
});
