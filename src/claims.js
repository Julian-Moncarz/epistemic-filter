// Two-stage claim detection and verification using Claude
import Anthropic from '@anthropic-ai/sdk';
import { anthropicCost } from './costs.js';

const CLAIM_DETECTION_PROMPT = `You are a factual claim detector monitoring a live conversation transcript.

Your job: determine if the latest segment contains a specific, checkable factual claim.

A checkable factual claim is a statement that:
- Asserts a specific fact about the world (numbers, dates, names, events, science, geography, etc.)
- Can be verified or falsified with a web search
- Is NOT an opinion, preference, or subjective statement
- Is NOT a vague or hedged statement ("I think maybe...")

If the segment contains a checkable factual claim, extract the single most important/specific claim.

Respond in this exact format:
CLAIM: <the extracted factual claim>
or
NONE

Do NOT explain your reasoning. Just output CLAIM: or NONE.`;

const VERIFICATION_PROMPT = `You are a real-time fact checker. You will receive a factual claim extracted from a live conversation.

Your job:
1. ALWAYS use the web search tool to verify the claim. Do not rely on your own knowledge alone.
2. Based on search results, determine if the claim is FALSE or MISLEADING.
3. If false, provide a brief, natural-sounding correction.

IMPORTANT:
- You MUST search before responding. Never skip the search.
- Be skeptical — if search results contradict the claim, it is wrong. Flag it.
- If the claim is approximately correct or genuinely debatable, respond with CORRECT.
- Corrections must be SHORT (under 20 words) and conversational, like a friend whispering a correction.
- Start corrections with "Actually," or "Just so you know,"

Respond in this exact format:
CORRECT
or
CORRECTION: <brief correction>`;

export class ClaimProcessor {
  constructor(anthropicKey, costTracker = null) {
    this.client = new Anthropic({ apiKey: anthropicKey });
    this.costTracker = costTracker;
    this.pendingVerifications = new Set();
  }

  // Stage 1: Haiku claim detection
  async detectClaim(recentTranscript, latestSegment) {
    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: `Recent conversation context:\n${recentTranscript}\n\nLatest segment to analyze:\n"${latestSegment}"`,
          },
        ],
        system: CLAIM_DETECTION_PROMPT,
      });

      if (this.costTracker && response.usage) {
        const cost = anthropicCost(response.usage);
        this.costTracker.log('anthropic', 'detect_claim', response.usage.input_tokens, 'input_tokens', cost.input, this._callId);
        this.costTracker.log('anthropic', 'detect_claim', response.usage.output_tokens, 'output_tokens', cost.output, this._callId);
      }

      const text = response.content[0]?.text?.trim() || '';
      if (text.startsWith('CLAIM:')) {
        const claim = text.slice(6).trim();
        console.log(`[claims] detected: "${claim}"`);
        return claim;
      }
      return null;
    } catch (err) {
      console.error('[claims] detection error:', err.message);
      return null;
    }
  }

  // Stage 2: Haiku verification with Anthropic built-in web search
  async verifyClaim(claim) {
    if (this.pendingVerifications.has(claim)) return null;
    this.pendingVerifications.add(claim);

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 3,
          },
        ],
        messages: [
          {
            role: 'user',
            content: `Claim to verify: "${claim}"`,
          },
        ],
        system: VERIFICATION_PROMPT,
      });

      if (this.costTracker && response.usage) {
        const cost = anthropicCost(response.usage);
        this.costTracker.log('anthropic', 'verify_claim', response.usage.input_tokens, 'input_tokens', cost.input, this._callId, { claim, web_search: true });
        this.costTracker.log('anthropic', 'verify_claim', response.usage.output_tokens, 'output_tokens', cost.output, this._callId, { claim, web_search: true });
      }

      // Concatenate all text blocks (Haiku may split across multiple blocks after web search)
      const textBlocks = response.content.filter((b) => b.type === 'text');
      const text = textBlocks.map((b) => b.text).join('').trim();

      if (text.startsWith('CORRECTION:')) {
        const correction = text.slice(11).trim();
        console.log(`[claims] correction: "${correction}"`);
        return correction;
      }

      console.log(`[claims] verified correct: "${claim}"`);
      return null;
    } catch (err) {
      console.error('[claims] verification error:', err.message);
      return null;
    } finally {
      this.pendingVerifications.delete(claim);
    }
  }
}
