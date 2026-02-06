// Fact-Whisper — Real-time factual claim detection during phone calls
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';

import { createTwimlRouter, parseTwilioMessage, sendAudioToTwilio } from './twilio.js';
import { createDeepgramStream } from './deepgram.js';
import { ClaimProcessor } from './claims.js';
import { WhisperTTS } from './tts.js';
import { convertToTelephonyAudio, attenuateAudio } from './audio.js';

const PORT = process.env.PORT || 8080;

// Validate required env vars
const required = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'DEEPGRAM_API_KEY',
  'ANTHROPIC_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'MEDIA_SECRET',
];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// Initialize services
const claims = new ClaimProcessor(process.env.ANTHROPIC_API_KEY);
const tts = new WhisperTTS(process.env.ELEVENLABS_API_KEY, process.env.ELEVENLABS_VOICE_ID);

// Express app for TwiML webhooks
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// TwiML webhook routes
const host = process.env.HOST || `localhost:${PORT}`;
const wsUrl = `wss://${host}/media?token=${process.env.MEDIA_SECRET}`;
app.use('/twilio', createTwimlRouter(wsUrl));

// HTTP server
const server = http.createServer(app);

// WebSocket server for Twilio media streams
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('token') !== process.env.MEDIA_SECRET) {
    console.warn('[server] rejected WebSocket connection: invalid token');
    ws.close(1008, 'Unauthorized');
    return;
  }

  console.log('[server] new media stream connection');

  let streamSid = null;
  let deepgram = null;

  // Rolling transcript buffer (~30 seconds of conversation)
  const transcriptBuffer = [];
  const MAX_BUFFER_SEGMENTS = 30;

  // Track recent claims to avoid re-checking
  const recentClaims = new Set();
  const CLAIM_COOLDOWN_MS = 60_000;

  // Set up Deepgram STT — configured for μ-law 8kHz (Twilio's native format)
  deepgram = createDeepgramStream(process.env.DEEPGRAM_API_KEY, async (result) => {
    if (!result.isFinal) return;

    const segment = result.text.trim();
    if (!segment) return;

    console.log(`[transcript] ${segment}`);

    // Add to rolling buffer
    transcriptBuffer.push(segment);
    if (transcriptBuffer.length > MAX_BUFFER_SEGMENTS) {
      transcriptBuffer.shift();
    }

    // Stage 1: Claim detection with Haiku (async, non-blocking)
    processClaim(segment, ws, streamSid);
  });

  async function processClaim(segment, ws, sid) {
    try {
      const recentContext = transcriptBuffer.slice(-10).join(' ');
      const claim = await claims.detectClaim(recentContext, segment);

      if (!claim) return;

      // Skip if we recently checked this claim
      if (recentClaims.has(claim)) return;
      recentClaims.add(claim);
      setTimeout(() => recentClaims.delete(claim), CLAIM_COOLDOWN_MS);

      // Stage 2: Verify with Haiku + Anthropic web search
      const correction = await claims.verifyClaim(claim);

      if (!correction) return;

      // Stage 3: TTS and send back
      await whisperCorrection(correction, ws, sid);
    } catch (err) {
      console.error('[server] claim processing error:', err.message);
    }
  }

  async function whisperCorrection(text, ws, sid) {
    console.log(`[server] whispering: "${text}"`);

    const result = await tts.synthesize(text);
    if (!result) return;

    // Convert PCM to μ-law 8kHz for Twilio
    const mulawAudio = convertToTelephonyAudio(result.pcmBuffer, result.sampleRate);

    // Attenuate for a subtle whisper effect
    const whisperAudio = attenuateAudio(mulawAudio, 0.5);

    // Send back through the Twilio WebSocket
    if (ws.readyState === ws.OPEN && sid) {
      sendAudioToTwilio(ws, whisperAudio, sid);
      console.log(`[server] sent ${whisperAudio.length} bytes of correction audio`);
    }
  }

  // Handle messages from Twilio WebSocket
  ws.on('message', (message) => {
    const parsed = parseTwilioMessage(message.toString());

    switch (parsed.type) {
      case 'connected':
        break;

      case 'start':
        streamSid = parsed.streamSid;
        break;

      case 'media':
        if (!streamSid) streamSid = parsed.streamSid;
        // Twilio streams μ-law 8kHz — send directly to Deepgram (configured for mulaw)
        deepgram?.send(parsed.audio);
        break;

      case 'stop':
        deepgram?.close();
        break;
    }
  });

  ws.on('close', () => {
    console.log('[server] media stream closed');
    deepgram?.close();
  });

  ws.on('error', (err) => {
    console.error('[server] ws error:', err.message);
    deepgram?.close();
  });
});

server.listen(PORT, () => {
  console.log(`[server] Fact-Whisper running on port ${PORT}`);
  console.log(`[server] TwiML webhook: POST /twilio/inbound`);
  console.log(`[server] Media WebSocket: ws://localhost:${PORT}/media`);
});
