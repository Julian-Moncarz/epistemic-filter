import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhisperTTS } from '../src/tts.js';

// Mock ElevenLabs SDK — must use function() for `new` compatibility
vi.mock('@elevenlabs/elevenlabs-js', () => {
  const streamFn = vi.fn();
  function MockElevenLabsClient() {
    this.textToSpeech = { stream: streamFn };
  }
  return {
    ElevenLabsClient: MockElevenLabsClient,
    __mockStream: streamFn,
  };
});

async function getMockTTS() {
  const mod = await import('@elevenlabs/elevenlabs-js');
  return mod.__mockStream;
}

// Helper to create an async iterable from buffers
function asyncIterableFrom(buffers) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const buf of buffers) {
        yield buf;
      }
    },
  };
}

describe('WhisperTTS', () => {
  let tts;
  let mockStream;

  beforeEach(async () => {
    mockStream = await getMockTTS();
    mockStream.mockReset();
    tts = new WhisperTTS('test-key', 'voice-123');
  });

  it('synthesizes text and returns PCM buffer with sample rate', async () => {
    const chunk1 = Buffer.alloc(1000, 0x42);
    const chunk2 = Buffer.alloc(500, 0x43);
    mockStream.mockResolvedValueOnce(asyncIterableFrom([chunk1, chunk2]));

    const result = await tts.synthesize('Hello world');

    expect(result).not.toBeNull();
    expect(result.pcmBuffer.length).toBe(1500);
    expect(result.sampleRate).toBe(22050);
  });

  it('calls ElevenLabs with correct parameters', async () => {
    mockStream.mockResolvedValueOnce(asyncIterableFrom([Buffer.alloc(100)]));

    await tts.synthesize('Test text');

    expect(mockStream).toHaveBeenCalledWith('voice-123', {
      text: 'Test text',
      modelId: 'eleven_turbo_v2_5',
      outputFormat: 'pcm_22050',
      voiceSettings: {
        stability: 0.7,
        similarityBoost: 0.8,
        style: 0.0,
        useSpeakerBoost: false,
      },
    });
  });

  it('returns null on API error', async () => {
    mockStream.mockRejectedValueOnce(new Error('quota exceeded'));

    const result = await tts.synthesize('Some text');
    expect(result).toBeNull();
  });

  it('handles single chunk response', async () => {
    const chunk = Buffer.alloc(2000, 0x55);
    mockStream.mockResolvedValueOnce(asyncIterableFrom([chunk]));

    const result = await tts.synthesize('Short');
    expect(result.pcmBuffer.length).toBe(2000);
  });

  it('handles many small chunks', async () => {
    const chunks = Array.from({ length: 50 }, () => Buffer.alloc(20, 0x01));
    mockStream.mockResolvedValueOnce(asyncIterableFrom(chunks));

    const result = await tts.synthesize('Many chunks');
    expect(result.pcmBuffer.length).toBe(1000);
  });

  it('concatenates chunks in order', async () => {
    const chunk1 = Buffer.from([0x01, 0x02]);
    const chunk2 = Buffer.from([0x03, 0x04]);
    mockStream.mockResolvedValueOnce(asyncIterableFrom([chunk1, chunk2]));

    const result = await tts.synthesize('Ordered');
    expect(result.pcmBuffer[0]).toBe(0x01);
    expect(result.pcmBuffer[1]).toBe(0x02);
    expect(result.pcmBuffer[2]).toBe(0x03);
    expect(result.pcmBuffer[3]).toBe(0x04);
  });
});
