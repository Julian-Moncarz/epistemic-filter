// Two-stage claim detection and verification using Claude
import Anthropic from '@anthropic-ai/sdk';

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
1. Use the web search tool to verify the claim
2. Determine if the claim is FALSE or MISLEADING
3. If false, provide a brief, natural-sounding correction

IMPORTANT:
- Only flag claims that are clearly wrong. If the claim is approximately correct or debatable, respond with CORRECT.
- Corrections must be SHORT (under 20 words) and conversational, like a friend whispering a correction.
- Start corrections with "Actually," or "Just so you know,"

Respond in this exact format:
CORRECT
or
CORRECTION: <brief correction>`;

export class ClaimProcessor {
  constructor(anthropicKey, braveApiKey) {
    this.client = new Anthropic({ apiKey: anthropicKey });
    this.braveApiKey = braveApiKey;
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

  // Stage 2: Sonnet verification with web search
  async verifyClaim(claim) {
    // Deduplicate concurrent verification of the same claim
    if (this.pendingVerifications.has(claim)) return null;
    this.pendingVerifications.add(claim);

    try {
      const searchResults = await this.webSearch(claim);

      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: `Claim to verify: "${claim}"\n\nWeb search results:\n${searchResults}`,
          },
        ],
        system: VERIFICATION_PROMPT,
      });

      const text = response.content[0]?.text?.trim() || '';
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

  // Brave Search API
  async webSearch(query) {
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.braveApiKey,
        },
      });

      if (!res.ok) {
        console.error(`[search] brave returned ${res.status}`);
        return 'Search failed - no results available.';
      }

      const data = await res.json();
      const results = data.web?.results || [];

      return results
        .slice(0, 5)
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.description}`)
        .join('\n\n') || 'No relevant results found.';
    } catch (err) {
      console.error('[search] error:', err.message);
      return 'Search failed - no results available.';
    }
  }
}
