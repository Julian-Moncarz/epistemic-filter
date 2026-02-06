import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaimProcessor } from '../src/claims.js';

// Mock the Anthropic SDK — must use function() for `new` compatibility
vi.mock('@anthropic-ai/sdk', () => {
  const createFn = vi.fn();
  function MockAnthropic() {
    this.messages = { create: createFn };
  }
  return {
    default: MockAnthropic,
    __mockCreate: createFn,
  };
});

// Get access to the mock
async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  return mod.__mockCreate;
}

describe('ClaimProcessor', () => {
  let processor;
  let mockCreate;

  beforeEach(async () => {
    mockCreate = await getMockCreate();
    mockCreate.mockReset();
    processor = new ClaimProcessor('test-key');
  });

  describe('detectClaim', () => {
    it('returns extracted claim when Haiku detects one', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'CLAIM: The Earth is 6000 years old' }],
      });

      const claim = await processor.detectClaim(
        'some context here',
        'The Earth is 6000 years old you know'
      );

      expect(claim).toBe('The Earth is 6000 years old');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
        })
      );
    });

    it('returns null when Haiku says NONE', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'NONE' }],
      });

      const claim = await processor.detectClaim('some context', 'I like pizza');
      expect(claim).toBeNull();
    });

    it('returns null on empty response', async () => {
      mockCreate.mockResolvedValueOnce({ content: [] });
      const claim = await processor.detectClaim('ctx', 'segment');
      expect(claim).toBeNull();
    });

    it('returns null on API error', async () => {
      mockCreate.mockRejectedValueOnce(new Error('rate limited'));
      const claim = await processor.detectClaim('ctx', 'segment');
      expect(claim).toBeNull();
    });

    it('trims whitespace from extracted claim', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'CLAIM:   Water boils at 50 degrees   ' }],
      });

      const claim = await processor.detectClaim('ctx', 'seg');
      expect(claim).toBe('Water boils at 50 degrees');
    });

    it('sends recent context and segment in the prompt', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'NONE' }],
      });

      await processor.detectClaim('recent talk about science', 'the sun is a planet');

      const call = mockCreate.mock.calls[0][0];
      expect(call.messages[0].content).toContain('recent talk about science');
      expect(call.messages[0].content).toContain('the sun is a planet');
    });
  });

  describe('verifyClaim', () => {
    it('returns correction when claim is false', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'web_search', name: 'web_search' },
          { type: 'text', text: 'CORRECTION: Actually, the Great Wall is not visible from space.' },
        ],
      });

      const correction = await processor.verifyClaim('The Great Wall is visible from space');
      expect(correction).toBe('Actually, the Great Wall is not visible from space.');
    });

    it('returns null when claim is correct', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'CORRECT' },
        ],
      });

      const correction = await processor.verifyClaim('Water boils at 100 degrees Celsius');
      expect(correction).toBeNull();
    });

    it('uses Haiku model with web_search tool', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'CORRECT' }],
      });

      await processor.verifyClaim('some claim');

      const call = mockCreate.mock.calls[0][0];
      expect(call.model).toBe('claude-haiku-4-5-20251001');
      expect(call.tools).toEqual([
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      ]);
    });

    it('returns null on API error', async () => {
      mockCreate.mockRejectedValueOnce(new Error('server error'));
      const correction = await processor.verifyClaim('claim');
      expect(correction).toBeNull();
    });

    it('deduplicates concurrent verifications of the same claim', async () => {
      let resolveFirst;
      mockCreate.mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; })
      );

      const p1 = processor.verifyClaim('duplicate claim');
      const p2 = processor.verifyClaim('duplicate claim');

      // Second should return null immediately (deduplicated)
      const r2 = await p2;
      expect(r2).toBeNull();

      // Now resolve the first
      resolveFirst({ content: [{ type: 'text', text: 'CORRECT' }] });
      const r1 = await p1;
      expect(r1).toBeNull();

      // Only one API call was made
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('allows re-verification after first completes', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'CORRECT' }],
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'CORRECTION: Actually, it is 40 million.' }],
      });

      await processor.verifyClaim('Canada has 80 million people');
      const second = await processor.verifyClaim('Canada has 80 million people');

      expect(second).toBe('Actually, it is 40 million.');
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('cleans up pending set even on error', async () => {
      mockCreate.mockRejectedValueOnce(new Error('fail'));
      await processor.verifyClaim('failing claim');

      // Should be able to verify again (not stuck in pending)
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'CORRECT' }],
      });
      const result = await processor.verifyClaim('failing claim');
      expect(result).toBeNull();
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('concatenates split text blocks from web search response', async () => {
      // Real Anthropic responses split text across multiple blocks after web search
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'server_tool_use', id: 'tu_1', name: 'web_search' },
          { type: 'web_search_tool_result', tool_use_id: 'tu_1' },
          { type: 'text', text: 'CORRECTION: ' },
          { type: 'text', text: 'Actually, Paris is the capital of France, not Lyon' },
          { type: 'text', text: '.' },
        ],
      });

      const correction = await processor.verifyClaim('Lyon is the capital of France');
      expect(correction).toBe('Actually, Paris is the capital of France, not Lyon.');
    });
  });
});
