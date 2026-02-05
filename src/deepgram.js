// Deepgram streaming STT integration
import { createClient } from '@deepgram/sdk';

export function createDeepgramStream(apiKey, onTranscript) {
  const deepgram = createClient(apiKey);

  const connection = deepgram.listen.live({
    model: 'nova-2',
    language: 'en',
    smart_format: true,
    interim_results: true,
    utterance_end_ms: 1500,
    vad_events: true,
    encoding: 'linear16',
    sample_rate: 16000,
    channels: 1,
  });

  connection.on('open', () => {
    console.log('[deepgram] connection opened');
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
