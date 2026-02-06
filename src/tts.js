// ElevenLabs streaming TTS integration
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

export class WhisperTTS {
  constructor(apiKey, voiceId) {
    this.client = new ElevenLabsClient({ apiKey });
    this.voiceId = voiceId;
  }

  // Generate TTS audio and return as a single PCM buffer
  // ElevenLabs streaming returns chunks; we concatenate them
  async synthesize(text) {
    try {
      const audioStream = await this.client.textToSpeech.stream(
        this.voiceId,
        {
          text,
          modelId: 'eleven_turbo_v2_5',
          outputFormat: 'pcm_22050',
          voiceSettings: {
            stability: 0.7,
            similarityBoost: 0.8,
            style: 0.0,
            useSpeakerBoost: false,
          },
        }
      );

      const chunks = [];
      for await (const chunk of audioStream) {
        chunks.push(Buffer.from(chunk));
      }

      const pcmBuffer = Buffer.concat(chunks);
      console.log(`[tts] synthesized ${text.length} chars → ${pcmBuffer.length} bytes PCM`);
      return { pcmBuffer, sampleRate: 22050 };
    } catch (err) {
      console.error('[tts] error:', err.message);
      return null;
    }
  }
}
