import { TOOLS, SUPPORTED_ACTIONS } from './config';

describe('assistant tools', () => {
  // Value: protects=the model gets search_offers and no longer the hosted file_search over the April store; the company documents stay; fails_when=file_search is still offered, search_offers is missing, or code_interpreter loses its two file ids; why_new=TOOLS has never been asserted; seam=none; no_claim=how OpenAI treats the tool list (not called)
  it('has search_offers, no file_search, and keeps code_interpreter with its two files', () => {
    const types = TOOLS.map((t: any) => t.type);
    expect(types).not.toContain('file_search');
    expect(TOOLS.some((t: any) => t.name === 'search_offers')).toBe(true);
    const ci: any = TOOLS.find((t: any) => t.type === 'code_interpreter');
    expect(ci.container.file_ids).toEqual(['file-9K9jXy634wVu2Xt38AQHMP', 'file-4zYVPhMmhJHcd197q7tmRG']);
    expect(typeof (SUPPORTED_ACTIONS as any).search_offers).toBe('function');
  });
});
