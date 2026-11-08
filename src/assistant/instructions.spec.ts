import { AXEL_INSTRUCTIONS } from './instructions';
import { BOARDS } from '../catalog/types';

// The grep gate of acceptance criterion 10: the forbidden-wording block is the
// only place that may name files, search or the old season.
function gatedLines(): string[] {
  const lines = AXEL_INSTRUCTIONS.split('\n');
  const kept: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.startsWith('🚫 FORBIDDEN CLIENT WORDING')) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (line.trim() === '') inBlock = false;
      continue;
    }
    if (line.trim().startsWith('//')) continue;
    kept.push(line);
  }
  return kept;
}

describe('AXEL_INSTRUCTIONS prompt gate', () => {
  // Value: protects=the prompt no longer sends the model to files, a knowledge base or stored prices that no longer exist; fails_when=a leftover line still says file, knowledge base, файл, vector or stored price outside the forbidden-wording block; why_new=the prompt has never been asserted on; seam=none; no_claim=how the live model behaves with the new prompt (replay covers that)
  it('has no leftover file, knowledge-base or stored-price wording', () => {
    const hits = gatedLines().filter((l) => /file|knowledge base|файл|vector|stored price/i.test(l));
    expect(hits).toEqual([]);
  });

  // Value: protects=every mention of searching names the tool search_offers; fails_when=a line still tells the model to search something else; why_new=same as above; seam=none; no_claim=model behavior
  it('mentions search only as search_offers', () => {
    const hits = gatedLines().filter((l) => /search/i.test(l) && !l.includes('search_offers'));
    expect(hits).toEqual([]);
  });

  // Value: protects=no season year from the April scrape is left in the prompt; fails_when=a line still contains 2026; why_new=same as above; seam=none; no_claim=model behavior
  it('contains no 2026', () => {
    expect(gatedLines().filter((l) => l.includes('2026'))).toEqual([]);
  });

  // Value: protects=the anti-leak wording is one block, so it cannot drift apart; fails_when=the block is missing or duplicated; why_new=same as above; seam=none; no_claim=model behavior
  it('has the forbidden-wording block exactly once', () => {
    const count = AXEL_INSTRUCTIONS.split('\n').filter((l) => l.startsWith('🚫 FORBIDDEN CLIENT WORDING')).length;
    expect(count).toBe(1);
  });

  // Value: protects=a board code is never printed raw to a client; fails_when=a code is added to BOARDS without a Bulgarian label in the prompt; why_new=the codes live in four places; seam=none; no_claim=how the model words the line
  it('has a Bulgarian label for every board code except OTHER', () => {
    const labels: Record<string, string> = {
      RO: 'RO = Само нощувка',
      BB: 'BB = Закуска',
      HB: 'HB = Закуска и вечеря',
      FB: 'FB = Пълен пансион',
      AI: 'AI = Всичко включено',
      UAI: 'UAI = Ултра всичко включено',
    };
    for (const code of BOARDS.filter((b) => b !== 'OTHER')) {
      expect(AXEL_INSTRUCTIONS).toContain(labels[code]);
    }
  });
});
