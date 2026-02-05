// Telnyx TeXML handler and WebSocket audio bridge
import express from 'express';

// TeXML response for incoming calls — opens a bidirectional media stream
export function createTexmlRouter(wsUrl) {
  const router = express.Router();

  // Telnyx sends a webhook when a call comes in; respond with TeXML
  router.post('/inbound', (req, res) => {
    console.log('[telnyx] incoming call');

    const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

    res.type('text/xml').send(texml);
  });

  // Status callback
  router.post('/status', (req, res) => {
    console.log('[telnyx] status:', req.body?.CallStatus || 'unknown');
    res.sendStatus(200);
  });

  return router;
}

// Parse Telnyx media WebSocket messages
export function parseTelnyxMessage(message) {
  try {
    const data = JSON.parse(message);

    if (data.event === 'media') {
      // Audio payload is base64-encoded
      const audioBuffer = Buffer.from(data.media.payload, 'base64');
      return { type: 'media', audio: audioBuffer, streamSid: data.stream_sid };
    }

    if (data.event === 'start') {
      console.log('[telnyx] stream started:', data.start?.stream_sid);
      return { type: 'start', streamSid: data.start?.stream_sid };
    }

    if (data.event === 'stop') {
      console.log('[telnyx] stream stopped');
      return { type: 'stop' };
    }

    if (data.event === 'connected') {
      console.log('[telnyx] websocket connected');
      return { type: 'connected' };
    }

    return { type: data.event || 'unknown' };
  } catch {
    return { type: 'error' };
  }
}

// Send audio back to Telnyx through the WebSocket
export function sendAudioToTelnyx(ws, mulawBuffer, streamSid) {
  // Telnyx expects audio in 160-byte chunks (20ms of 8kHz μ-law)
  const CHUNK_SIZE = 160;

  for (let offset = 0; offset < mulawBuffer.length; offset += CHUNK_SIZE) {
    const chunk = mulawBuffer.slice(offset, offset + CHUNK_SIZE);
    const message = JSON.stringify({
      event: 'media',
      stream_sid: streamSid,
      media: {
        payload: chunk.toString('base64'),
      },
    });

    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}
