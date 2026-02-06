// Live integration tests — hits real APIs (requires .env to be configured)
import { describe, it, expect, beforeAll } from 'vitest';
import 'dotenv/config';
import { ClaimProcessor } from '../src/claims.js';
import { WhisperTTS } from '../src/tts.js';
import { convertToTelephonyAudio, attenuateAudio, decodeMuLaw, encodeMuLaw } from '../src/audio.js';
import { sendAudioToTwilio } from '../src/twilio.js';

const TIMEOUT = 30_000;

// LLM verification is non-deterministic — retry up to 3 times
async function retryVerify(claim, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const correction = await claims.verifyClaim(claim);
    if (correction) return correction;
    console.log(`  [retry] attempt ${i + 1} returned CORRECT, retrying...`);
  }
  return null;
}

let claims;
let tts;

beforeAll(() => {
  claims = new ClaimProcessor(process.env.ANTHROPIC_API_KEY);
  tts = new WhisperTTS(process.env.ELEVENLABS_API_KEY, process.env.ELEVENLABS_VOICE_ID);
});

// ── Anthropic: Claim Detection (Haiku) ──────────────────────────────

describe('live: claim detection (Haiku)', () => {
  it('detects an obvious false factual claim', async () => {
    const claim = await claims.detectClaim(
      'We were talking about geography and world capitals.',
      'The capital of Australia is Sydney.'
    );
    expect(claim).not.toBeNull();
    expect(claim.toLowerCase()).toContain('australia');
  }, TIMEOUT);

  it('detects a numerical factual claim', async () => {
    const claim = await claims.detectClaim(
      'We were discussing space and planets.',
      'The speed of light is about 100,000 miles per second.'
    );
    expect(claim).not.toBeNull();
    expect(claim.toLowerCase()).toContain('light');
  }, TIMEOUT);

  it('returns NONE for opinions', async () => {
    const claim = await claims.detectClaim(
      'We were chatting about food.',
      'I think pizza is the best food ever.'
    );
    expect(claim).toBeNull();
  }, TIMEOUT);

  it('returns NONE for greetings and small talk', async () => {
    const claim = await claims.detectClaim(
      'Just started the conversation.',
      'Hey, how are you doing today?'
    );
    expect(claim).toBeNull();
  }, TIMEOUT);

  it('returns NONE for hedged/uncertain statements', async () => {
    const claim = await claims.detectClaim(
      'We were talking about history.',
      'I think maybe the war started around that time, not sure though.'
    );
    expect(claim).toBeNull();
  }, TIMEOUT);
});

// ── Anthropic: Claim Verification (Haiku + Web Search) ──────────────

describe('live: claim verification (Haiku + web search)', () => {
  it('corrects a clearly false claim', async () => {
    const correction = await retryVerify('The capital of Australia is Sydney');
    expect(correction).not.toBeNull();
    expect(correction.toLowerCase()).toMatch(/canberra/);
  }, 60_000);

  it('accepts a true claim', async () => {
    const correction = await claims.verifyClaim(
      'Water boils at 100 degrees Celsius at sea level'
    );
    expect(correction).toBeNull();
  }, TIMEOUT);

  it('corrects a false numerical claim', async () => {
    const correction = await retryVerify('The Earth has 3 moons');
    expect(correction).not.toBeNull();
    expect(correction.toLowerCase()).toMatch(/one|1|single|moon/);
  }, 60_000);

  it('accepts an approximately correct claim', async () => {
    const correction = await claims.verifyClaim(
      'The Earth is about 93 million miles from the Sun'
    );
    expect(correction).toBeNull();
  }, TIMEOUT);
});

// ── ElevenLabs TTS ──────────────────────────────────────────────────

describe('live: ElevenLabs TTS', () => {
  it('synthesizes a short correction to PCM audio', async () => {
    const result = await tts.synthesize(
      'Actually, the capital of Australia is Canberra, not Sydney.'
    );

    expect(result).not.toBeNull();
    expect(result.pcmBuffer).toBeInstanceOf(Buffer);
    expect(result.pcmBuffer.length).toBeGreaterThan(1000);
    expect(result.sampleRate).toBe(22050);

    // Verify it's valid 16-bit PCM (even byte count)
    expect(result.pcmBuffer.length % 2).toBe(0);
  }, TIMEOUT);

  it('synthesizes a very short correction', async () => {
    const result = await tts.synthesize('Actually, no.');

    expect(result).not.toBeNull();
    expect(result.pcmBuffer.length).toBeGreaterThan(500);
  }, TIMEOUT);
});

// ── Full Pipeline: Detect → Verify → TTS → Encode ──────────────────

describe('live: full pipeline', () => {
  it('detects a false claim, verifies, generates TTS, and encodes for Twilio', async () => {
    // Step 1: Detect
    const claim = await claims.detectClaim(
      'We were talking about world geography and history.',
      'The capital of France is Berlin.'
    );
    console.log(`  [pipeline] detected claim: "${claim}"`);
    expect(claim).not.toBeNull();

    // Step 2: Verify
    const correction = await claims.verifyClaim(claim);
    console.log(`  [pipeline] correction: "${correction}"`);
    expect(correction).not.toBeNull();
    expect(correction.length).toBeGreaterThan(5);
    expect(correction.length).toBeLessThan(200);

    // Step 3: TTS
    const audio = await tts.synthesize(correction);
    console.log(`  [pipeline] TTS: ${audio.pcmBuffer.length} bytes PCM`);
    expect(audio).not.toBeNull();
    expect(audio.pcmBuffer.length).toBeGreaterThan(0);

    // Step 4: Convert to telephony format
    const mulaw = convertToTelephonyAudio(audio.pcmBuffer, audio.sampleRate);
    console.log(`  [pipeline] μ-law: ${mulaw.length} bytes (${(mulaw.length / 8000).toFixed(2)}s)`);
    expect(mulaw.length).toBeGreaterThan(0);

    // Should be reasonable duration (0.5s–10s for a correction)
    const durationSec = mulaw.length / 8000;
    expect(durationSec).toBeGreaterThan(0.5);
    expect(durationSec).toBeLessThan(10);

    // Step 5: Attenuate for whisper
    const whispered = attenuateAudio(mulaw, 0.5);
    expect(whispered.length).toBe(mulaw.length);

    // Step 6: Verify chunking for Twilio
    const ws = { OPEN: 1, readyState: 1, chunks: [], send(m) { this.chunks.push(m); } };
    sendAudioToTwilio(ws, whispered, 'MZpipeline_test');

    const expectedChunks = Math.ceil(whispered.length / 160);
    expect(ws.chunks.length).toBe(expectedChunks);

    // Verify all chunks are valid Twilio messages
    let totalBytes = 0;
    for (const raw of ws.chunks) {
      const msg = JSON.parse(raw);
      expect(msg.event).toBe('media');
      expect(msg.streamSid).toBe('MZpipeline_test');
      totalBytes += Buffer.from(msg.media.payload, 'base64').length;
    }
    expect(totalBytes).toBe(whispered.length);

    console.log(`  [pipeline] ready to send: ${ws.chunks.length} chunks, ${totalBytes} bytes`);
  }, 60_000);

  it('passes through a true claim without generating a correction', async () => {
    // Step 1: Detect
    const claim = await claims.detectClaim(
      'We were talking about geography.',
      'Tokyo is the capital of Japan.'
    );
    console.log(`  [pipeline] detected claim: "${claim}"`);
    expect(claim).not.toBeNull();

    // Step 2: Verify — should return null (claim is true)
    const correction = await claims.verifyClaim(claim);
    console.log(`  [pipeline] correction: ${correction}`);
    expect(correction).toBeNull();
  }, TIMEOUT);

  it('skips non-claims entirely', async () => {
    const claim = await claims.detectClaim(
      'Just chatting about weekend plans.',
      'Yeah I was thinking maybe we could go hiking or something.'
    );
    console.log(`  [pipeline] detected claim: ${claim}`);
    expect(claim).toBeNull();
    // Pipeline stops here — no verification or TTS needed
  }, TIMEOUT);
});
