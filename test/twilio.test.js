import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { createTwimlRouter, parseTwilioMessage, sendAudioToTwilio } from '../src/twilio.js';

describe('parseTwilioMessage', () => {
  it('parses a media event with base64 audio', () => {
    const payload = Buffer.from([0x80, 0xFF, 0x00, 0x42]).toString('base64');
    const msg = JSON.stringify({
      event: 'media',
      streamSid: 'MZ123',
      media: { payload },
    });

    const result = parseTwilioMessage(msg);
    expect(result.type).toBe('media');
    expect(result.streamSid).toBe('MZ123');
    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBe(4);
    expect(result.audio[0]).toBe(0x80);
    expect(result.audio[3]).toBe(0x42);
  });

  it('parses a start event', () => {
    const msg = JSON.stringify({
      event: 'start',
      start: { streamSid: 'MZabc' },
    });

    const result = parseTwilioMessage(msg);
    expect(result.type).toBe('start');
    expect(result.streamSid).toBe('MZabc');
  });

  it('parses a stop event', () => {
    const msg = JSON.stringify({ event: 'stop' });
    const result = parseTwilioMessage(msg);
    expect(result.type).toBe('stop');
  });

  it('parses a connected event', () => {
    const msg = JSON.stringify({ event: 'connected' });
    const result = parseTwilioMessage(msg);
    expect(result.type).toBe('connected');
  });

  it('returns unknown for unrecognized events', () => {
    const msg = JSON.stringify({ event: 'dtmf' });
    const result = parseTwilioMessage(msg);
    expect(result.type).toBe('dtmf');
  });

  it('returns error for invalid JSON', () => {
    const result = parseTwilioMessage('not json at all');
    expect(result.type).toBe('error');
  });

  it('returns error for empty string', () => {
    const result = parseTwilioMessage('');
    expect(result.type).toBe('error');
  });

  it('handles start event without streamSid gracefully', () => {
    const msg = JSON.stringify({ event: 'start', start: {} });
    const result = parseTwilioMessage(msg);
    expect(result.type).toBe('start');
    expect(result.streamSid).toBeUndefined();
  });

  it('handles media event with empty payload', () => {
    const msg = JSON.stringify({
      event: 'media',
      streamSid: 'MZ1',
      media: { payload: '' },
    });
    const result = parseTwilioMessage(msg);
    expect(result.type).toBe('media');
    expect(result.audio.length).toBe(0);
  });
});

describe('sendAudioToTwilio', () => {
  function mockWs() {
    const sent = [];
    return {
      OPEN: 1,
      readyState: 1,
      send: vi.fn((msg) => sent.push(msg)),
      _sent: sent,
    };
  }

  it('sends audio in 160-byte chunks', () => {
    const ws = mockWs();
    const audio = Buffer.alloc(480); // 3 chunks exactly
    sendAudioToTwilio(ws, audio, 'MZ_stream_1');

    expect(ws.send).toHaveBeenCalledTimes(3);

    for (const raw of ws._sent) {
      const msg = JSON.parse(raw);
      expect(msg.event).toBe('media');
      expect(msg.streamSid).toBe('MZ_stream_1');
      expect(msg.media.payload).toBeDefined();

      const decoded = Buffer.from(msg.media.payload, 'base64');
      expect(decoded.length).toBe(160);
    }
  });

  it('uses streamSid (camelCase) in the message format', () => {
    const ws = mockWs();
    sendAudioToTwilio(ws, Buffer.alloc(160), 'MZtest');

    const msg = JSON.parse(ws._sent[0]);
    expect(msg.streamSid).toBe('MZtest');
    expect(msg.stream_sid).toBeUndefined(); // NOT snake_case
  });

  it('handles audio not evenly divisible by 160', () => {
    const ws = mockWs();
    const audio = Buffer.alloc(200); // 1 full chunk + 40 bytes
    sendAudioToTwilio(ws, audio, 'MZ_stream_2');

    expect(ws.send).toHaveBeenCalledTimes(2);

    const lastMsg = JSON.parse(ws._sent[1]);
    const lastChunk = Buffer.from(lastMsg.media.payload, 'base64');
    expect(lastChunk.length).toBe(40);
  });

  it('sends nothing if ws is not open', () => {
    const ws = mockWs();
    ws.readyState = 3; // CLOSED
    const audio = Buffer.alloc(320);
    sendAudioToTwilio(ws, audio, 'MZ_stream_3');

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('handles empty buffer', () => {
    const ws = mockWs();
    sendAudioToTwilio(ws, Buffer.alloc(0), 'MZ_stream_4');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('sends exactly one chunk for 160 bytes', () => {
    const ws = mockWs();
    sendAudioToTwilio(ws, Buffer.alloc(160), 'MZ_stream_5');
    expect(ws.send).toHaveBeenCalledTimes(1);
  });
});

describe('createTwimlRouter', () => {
  let server;

  async function startServer(router) {
    const app = express();
    app.use(express.json());
    app.use('/twilio', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    return `http://localhost:${server.address().port}`;
  }

  it('responds with valid TwiML on POST /inbound', async () => {
    const router = createTwimlRouter('wss://example.com/media');
    const base = await startServer(router);

    const res = await fetch(`${base}/twilio/inbound`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('xml');

    const body = await res.text();
    expect(body).toContain('<?xml');
    expect(body).toContain('<Response>');
    expect(body).toContain('<Connect>');
    expect(body).toContain('<Stream url="wss://example.com/media"');
    expect(body).toContain('</Response>');

    server.close();
  });

  it('responds 200 on POST /status', async () => {
    const router = createTwimlRouter('wss://example.com/media');
    const base = await startServer(router);

    const res = await fetch(`${base}/twilio/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CallStatus: 'completed' }),
    });
    expect(res.status).toBe(200);

    server.close();
  });

  it('embeds the correct websocket URL in TwiML', async () => {
    const wsUrl = 'wss://my-server.com:8080/media';
    const router = createTwimlRouter(wsUrl);
    const base = await startServer(router);

    const res = await fetch(`${base}/twilio/inbound`, { method: 'POST' });
    const body = await res.text();
    expect(body).toContain(`url="${wsUrl}"`);

    server.close();
  });
});
