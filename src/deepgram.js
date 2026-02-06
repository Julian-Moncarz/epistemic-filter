// Deepgram streaming STT integration
import { createClient } from '@deepgram/sdk';
import { deepgramCost } from './costs.js';

export function createDeepgramStream(apiKey, onTranscript, costTracker = null, callId = null) {
  const deepgram = createClient(apiKey);

  const connection = deepgram.listen.live({
    model: 'nova-2',
    language: 'en',
    smart_format: true,
    interim_results: true,
    utterance_end_ms: 1500,
    vad_events: true,
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
  });

  let openedAt = null;

  connection.on('open', () => {
    console.log('[deepgram] connection opened');
    openedAt = Date.now();
  });

  connection.on('Results', (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript) return;

    const isFinal = data.is_final;
    const speechFinal = data.speech_final;

    onTranscript({
      text: transcript,
      isFinal,
      speechFinal,
    });
  });

  connection.on('error', (err) => {
    console.error('[deepgram] error:', err.message);
  });

  connection.on('close', () => {
    console.log('[deepgram] connection closed');
    if (costTracker && openedAt) {
      const seconds = (Date.now() - openedAt) / 1000;
      costTracker.log('deepgram', 'stt', seconds, 'seconds', deepgramCost(seconds), callId);
    }
  });

  return {
    send(audioChunk) {
      if (connection.getReadyState() === 1) {
        connection.send(audioChunk);
      }
    },
    close() {
      connection.requestClose();
    },
  };
}
