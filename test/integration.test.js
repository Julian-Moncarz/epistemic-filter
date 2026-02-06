import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createTwimlRouter, parseTwilioMessage, sendAudioToTwilio } from '../src/twilio.js';
import { encodeMuLaw, decodeMuLaw, convertToTelephonyAudio, attenuateAudio } from '../src/audio.js';

const TEST_AUTH_TOKEN = 'test-auth-token-abc123';

function twilioSignature(url, params = {}) {
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', TEST_AUTH_TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64');
}

describe('integration: Twilio WebSocket ↔ audio pipeline', () => {
  let server;
  let wss;
  let port;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use('/twilio', createTwimlRouter('wss://localhost/media', TEST_AUTH_TOKEN));

    server = http.createServer(app);
    wss = new WebSocketServer({ server, path: '/media' });

    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  afterEach(() => {
    wss.clients.forEach((c) => c.close());
    server.close();
  });

  it('accepts WebSocket connection on /media', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/media`);
    await new Promise((resolve) => ws.on('open', resolve));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('round-trips: client sends media → server receives audio', async () => {
    const received = [];

    wss.on('connection', (ws) => {
      ws.on('message', (msg) => {
        const parsed = parseTwilioMessage(msg.toString());
        if (parsed.type === 'media') {
          received.push(parsed);
        }
      });
    });

    const client = new WebSocket(`ws://localhost:${port}/media`);
    await new Promise((resolve) => client.on('open', resolve));

    // Send a Twilio-format media message (camelCase streamSid)
    const audioPayload = Buffer.from([0xFF, 0x80, 0x42, 0x00]);
    client.send(JSON.stringify({
      event: 'media',
      streamSid: 'MZtest_stream',
      media: { payload: audioPayload.toString('base64') },
    }));

    // Wait for server to process
    await new Promise((r) => setTimeout(r, 100));

    expect(received.length).toBe(1);
    expect(received[0].streamSid).toBe('MZtest_stream');
    expect(Buffer.compare(received[0].audio, audioPayload)).toBe(0);

    client.close();
  });

  it('round-trips: server sends audio back to client', async () => {
    const clientReceived = [];

    wss.on('connection', (serverWs) => {
      serverWs.on('message', (msg) => {
        const parsed = parseTwilioMessage(msg.toString());
        if (parsed.type === 'start') {
          // Simulate sending a correction back
          const pcm = new Int16Array([5000, -5000, 3000, -3000]);
          const mulaw = encodeMuLaw(pcm);
          sendAudioToTwilio(serverWs, mulaw, parsed.streamSid);
        }
      });
    });

    const client = new WebSocket(`ws://localhost:${port}/media`);
    await new Promise((resolve) => client.on('open', resolve));

    client.on('message', (data) => {
      clientReceived.push(JSON.parse(data.toString()));
    });

    // Send start event (Twilio uses camelCase streamSid)
    client.send(JSON.stringify({
      event: 'start',
      start: { streamSid: 'MZroundtrip_stream' },
    }));

    await new Promise((r) => setTimeout(r, 200));

    expect(clientReceived.length).toBeGreaterThan(0);
    expect(clientReceived[0].event).toBe('media');
    expect(clientReceived[0].streamSid).toBe('MZroundtrip_stream');

    // Verify the payload is valid base64 that decodes to audio
    const audioBack = Buffer.from(clientReceived[0].media.payload, 'base64');
    expect(audioBack.length).toBeGreaterThan(0);

    client.close();
  });

  it('TwiML inbound endpoint returns correct XML', async () => {
    const url = `http://localhost:${port}/twilio/inbound`;
    const sig = twilioSignature(url);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Twilio-Signature': sig },
    });

    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('<Response>');
    expect(body).toContain('<Stream');
    expect(body).toContain('</Response>');
  });
});

describe('integration: full audio pipeline', () => {
  it('converts PCM through entire chain: PCM → resample → μ-law → attenuate → decode', () => {
    // Simulate ElevenLabs output: 22050Hz 16-bit PCM, a 440Hz sine wave
    const duration = 0.1; // 100ms
    const sampleRate = 22050;
    const numSamples = Math.floor(sampleRate * duration);
    const samples = new Int16Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      samples[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 10000);
    }

    const pcmBuffer = Buffer.from(samples.buffer);

    // Step 1: Convert to telephony format (resample + μ-law encode)
    const telephonyAudio = convertToTelephonyAudio(pcmBuffer, sampleRate);

    // Should be ~800 bytes (100ms at 8kHz)
    const expectedSamples = Math.floor(numSamples / (sampleRate / 8000));
    expect(telephonyAudio.length).toBe(expectedSamples);

    // Step 2: Attenuate for whisper
    const whispered = attenuateAudio(telephonyAudio, 0.5);
    expect(whispered.length).toBe(telephonyAudio.length);

    // Step 3: Decode back to PCM (what would happen on the receiver end)
    const decoded = decodeMuLaw(whispered);
    const decodedSamples = new Int16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2);

    // Verify attenuated signal has lower amplitude
    const decodedOrig = decodeMuLaw(telephonyAudio);
    const origSamples = new Int16Array(decodedOrig.buffer, decodedOrig.byteOffset, decodedOrig.byteLength / 2);

    let maxOrig = 0, maxWhisper = 0;
    for (let i = 0; i < origSamples.length; i++) {
      maxOrig = Math.max(maxOrig, Math.abs(origSamples[i]));
      maxWhisper = Math.max(maxWhisper, Math.abs(decodedSamples[i]));
    }

    expect(maxWhisper).toBeLessThan(maxOrig);
    expect(maxWhisper).toBeGreaterThan(0); // Not silent
  });

  it('handles the Twilio chunking protocol correctly for realistic audio', () => {
    // Simulate 1 second of TTS audio
    const sampleRate = 22050;
    const samples = new Int16Array(sampleRate);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(Math.sin(2 * Math.PI * 300 * i / sampleRate) * 8000);
    }

    const telephonyAudio = convertToTelephonyAudio(Buffer.from(samples.buffer), sampleRate);
    const whispered = attenuateAudio(telephonyAudio, 0.5);

    // Simulate sending through WebSocket
    const ws = {
      OPEN: 1,
      readyState: 1,
      sent: [],
      send(msg) { this.sent.push(msg); },
    };

    sendAudioToTwilio(ws, whispered, 'MZtest_stream');

    // 8000 bytes / 160 bytes per chunk = 50 chunks for 1 second
    expect(ws.sent.length).toBe(50);

    // Verify total audio reconstructed from chunks matches
    let totalAudioBytes = 0;
    for (const raw of ws.sent) {
      const msg = JSON.parse(raw);
      expect(msg.streamSid).toBe('MZtest_stream');
      const chunk = Buffer.from(msg.media.payload, 'base64');
      totalAudioBytes += chunk.length;
    }
    expect(totalAudioBytes).toBe(8000);
  });
});
