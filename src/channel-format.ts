import { CHANNELS } from './interfaces/enums';
import { CHANNEL_CHAR_LIMITS } from './assistant/config';

/**
 * Messenger and Instagram show markdown as raw text, so the model's image
 * lines, [label](url) links and **bold** markers reached clients literally.
 * Images are dropped, links become their bare URL (mailto:/tel: links become
 * their label) and bold markers are removed. A booking URL written on the
 * line after its "Резервация:" label is moved onto that line, where
 * enforceChannelLimit looks for it. Webchat renders markdown and is returned
 * unchanged.
 */
export function formatForChannel(text: string, channel: CHANNELS): string {
  if (!CHANNEL_CHAR_LIMITS[channel]) {
    return text;
  }

  return text
    // Images first - "![a](b)" also contains a "[a](b)" link.
    .replace(/!\[[^\]]*\]\([^)]*\)[ \t]*\n*/g, '')
    // Autolinks before links - "[a](<url>)" wraps its target in brackets.
    .replace(/<(https?:\/\/[^>\s]+)>/gi, '$1')
    .replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, label: string, target: string) => (/^https?:\/\//i.test(target) ? target : label))
    .replace(/\*\*([^\n]+?)\*\*/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/(Резервация:)[ \t]*\n+[ \t]*(?=https?:\/\/)/g, '$1 ')
    .trim();
}

/**
 * The prompt no longer asks for the "...ориентировъчни" price disclaimer,
 * but the model added it on these channels even when told to skip it, so
 * it's still stripped here as a backstop. Matches only a last line that
 * starts with "Имайте предвид, че цените на офертите са ориент", so a
 * self-truncated ("...ориентир…") copy is removed too but a price answer
 * that merely opens with the same words is not. Webchat is unaffected.
 */
export function stripPriceDisclaimer(text: string, channel: CHANNELS): string {
  if (!CHANNEL_CHAR_LIMITS[channel]) {
    return text;
  }

  const stripped = text.replace(/\n*\*?\s*Имайте предвид,?\s*че цените на офертите са ориент[^\n]*$/i, '').trimEnd();

  // The disclaimer is only ever the tail of an offer: if removing the match
  // would leave nothing or take a link with it, it wasn't the disclaimer.
  const links = text.match(/https?:\/\/\S+/g) ?? [];
  if (!stripped || links.some((link) => !stripped.includes(link))) {
    return text;
  }

  return stripped;
}

/**
 * Detects the model trailing off (e.g. "🔗 Резервация:…") instead of
 * writing out the booking URL, which has been observed when it runs low
 * on its self-estimated character budget near the end of a reply.
 */
export function isReservationLinkBroken(text: string): boolean {
  const match = text.match(/Резервация:\s*(\S*)/);
  return !!match && !/^https?:\/\//i.test(match[1]);
}

/**
 * Last-resort safety net: the prompt asks the model to send exactly one
 * complete offer so it naturally fits, so this should rarely trigger.
 * An offer without its link is useless to the client, so the booking line
 * and the offer fields above it are kept whole: whatever follows the
 * booking line goes first, then the intro is shortened, as the channel
 * prompt asks. A caller that appends its own footer passes the room left as
 * `limit`. Webchat is unaffected.
 */
export function enforceChannelLimit(text: string, channel: CHANNELS, limit = CHANNEL_CHAR_LIMITS[channel]): string {
  if (!limit || text.length <= limit) {
    return text;
  }

  const lines = text.split('\n');
  const linkLine = lines.findIndex((line) => /(Резервация:|🔗)\s*https?:\/\//.test(line));

  if (linkLine >= 0) {
    const head = lines.slice(0, linkLine);
    const withoutTail = lines.slice(0, linkLine + 1).join('\n');

    if (withoutTail.length <= limit) {
      return withoutTail;
    }

    // Section 10 offer fields (🏨, 🏖️, 📍, 🍽️, 💰, 🚌) start the offer.
    const firstField = head.findIndex((line) => /^\s*(🏨|🏖|📍|🍽|💰|🚌)/u.test(line));
    const intro = (firstField >= 0 ? head.slice(0, firstField) : head).join('\n').trimEnd();
    const offer = [...(firstField >= 0 ? head.slice(firstField) : []), lines[linkLine]].join('\n');
    const room = limit - offer.length - 1;

    if (offer.length <= limit) {
      return intro && room > 1 ? `${cutAtWord(intro, room)}\n${offer}` : offer;
    }

    // The fields alone don't fit: drop the intro and shorten the fields from
    // the end, so the hotel line next to the link survives.
    const roomBeforeLink = limit - lines[linkLine].length - 1;
    const beforeLink = (firstField >= 0 ? head.slice(firstField) : head).join('\n');

    if (roomBeforeLink > 1) {
      return `${cutAtWord(beforeLink, roomBeforeLink)}\n${lines[linkLine]}`;
    }
  }

  return cutAtWord(text, limit);
}

function cutAtWord(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const truncated = text.slice(0, limit - 1);
  const lastSpace = truncated.lastIndexOf(' ');
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;

  return `${cut}…`;
}
