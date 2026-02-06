// Twilio TwiML handler and WebSocket audio bridge
import express from 'express';
import crypto from 'crypto';
import { twilioCost } from './costs.js';

// Validate X-Twilio-Signature to ensure requests originate from Twilio
function validateTwilioSignature(authToken) {
  return (req, res, next) => {
    const signature = req.headers['x-twilio-signature'];
    if (!signature) {
      console.warn('[twilio] rejected: missing X-Twilio-Signature');
      return res.sendStatus(403);
    }

    // Reconstruct the full URL Twilio signed against
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const url = `${protocol}://${req.headers.host}${req.originalUrl}`;

    // Sort POST params and append key=value pairs to URL
    const params = req.body || {};
    const sortedKeys = Object.keys(params).sort();
    const data = url + sortedKeys.map((k) => k + params[k]).join('');

    const expected = crypto
      .createHmac('sha1', authToken)
      .update(Buffer.from(data, 'utf-8'))
      .digest('base64');

    if (signature !== expected) {
      console.warn('[twilio] rejected: invalid signature');
      return res.sendStatus(403);
    }

    next();
  };
}

// TwiML response for incoming calls — opens a bidirectional media stream
export function createTwimlRouter(wsUrl, authToken, costTracker = null) {
  const router = express.Router();

  // All routes require valid Twilio signature
  router.use(validateTwilioSignature(authToken));

  // Twilio sends a webhook when a call comes in; respond with TwiML
  router.post('/inbound', (req, res) => {
    console.log('[twilio] incoming call');

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

    res.type('text/xml').send(twiml);
  });

  // Status callback
  router.post('/status', (req, res) => {
    console.log('[twilio] status:', req.body?.CallStatus || 'unknown');

    if (costTracker && req.body?.CallDuration) {
      const seconds = parseInt(req.body.CallDuration, 10);
      if (seconds > 0) {
        costTracker.log('twilio', 'call', seconds, 'seconds', twilioCost(seconds), req.body.CallSid);
      }
    }

    res.sendStatus(200);
  });

  return router;
}

// Parse Twilio media WebSocket messages
export function parseTwilioMessage(message) {
  try {
    const data = JSON.parse(message);

    if (data.event === 'media') {
      // Audio payload is base64-encoded μ-law 8kHz
      const audioBuffer = Buffer.from(data.media.payload, 'base64');
      return { type: 'media', audio: audioBuffer, streamSid: data.streamSid };
    }

    if (data.event === 'start') {
      console.log('[twilio] stream started:', data.start?.streamSid);
      return { type: 'start', streamSid: data.start?.streamSid };
    }

    if (data.event === 'stop') {
      console.log('[twilio] stream stopped');
      return { type: 'stop' };
    }

    if (data.event === 'connected') {
      console.log('[twilio] websocket connected');
      return { type: 'connected' };
    }

    return { type: data.event || 'unknown' };
  } catch {
    return { type: 'error' };
  }
}

// Send audio back to Twilio through the WebSocket
export function sendAudioToTwilio(ws, mulawBuffer, streamSid) {
  // Twilio expects audio in 160-byte chunks (20ms of 8kHz μ-law)
  const CHUNK_SIZE = 160;

  for (let offset = 0; offset < mulawBuffer.length; offset += CHUNK_SIZE) {
    const chunk = mulawBuffer.slice(offset, offset + CHUNK_SIZE);
    const message = JSON.stringify({
      event: 'media',
      streamSid,
      media: {
        payload: chunk.toString('base64'),
      },
    });

    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}
