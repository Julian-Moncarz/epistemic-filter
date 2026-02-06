import { describe, it, expect } from 'vitest';
import {
  encodeMuLaw,
  decodeMuLaw,
  resampleLinear,
  convertToTelephonyAudio,
  attenuateAudio,
} from '../src/audio.js';

describe('μ-law encoding/decoding', () => {
  it('encodes and decodes silence (zeros)', () => {
    const pcm = Buffer.alloc(20); // 10 zero samples
    const encoded = encodeMuLaw(pcm);
    expect(encoded.length).toBe(10);

    const decoded = decodeMuLaw(encoded);
    expect(decoded.length).toBe(20);

    // Decoded silence should be very close to zero
    const samples = new Int16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2);
    for (const s of samples) {
      expect(Math.abs(s)).toBeLessThan(200); // μ-law has quantization noise near zero
    }
  });

  it('roundtrips a positive sample within tolerance', () => {
    const original = new Int16Array([1000]);
    const pcmBuf = Buffer.from(original.buffer);

    const encoded = encodeMuLaw(pcmBuf);
    expect(encoded.length).toBe(1);

    const decoded = decodeMuLaw(encoded);
    const result = new Int16Array(decoded.buffer, decoded.byteOffset, 1);

    // μ-law is lossy — allow ~5% tolerance for mid-range values
    expect(Math.abs(result[0] - 1000)).toBeLessThan(100);
  });

  it('roundtrips a negative sample within tolerance', () => {
    const original = new Int16Array([-5000]);
    const pcmBuf = Buffer.from(original.buffer);

    const encoded = encodeMuLaw(pcmBuf);
    const decoded = decodeMuLaw(encoded);
    const result = new Int16Array(decoded.buffer, decoded.byteOffset, 1);

    expect(result[0]).toBeLessThan(0);
    expect(Math.abs(result[0] - (-5000))).toBeLessThan(500);
  });

  it('clips samples beyond max range', () => {
    const loud = new Int16Array([32767, -32768]);
    const pcmBuf = Buffer.from(loud.buffer);

    const encoded = encodeMuLaw(pcmBuf);
    expect(encoded.length).toBe(2);

    // Should not throw; clipping is handled internally
    const decoded = decodeMuLaw(encoded);
    expect(decoded.length).toBe(4);
  });

  it('handles Int16Array input directly', () => {
    const samples = new Int16Array([0, 100, -100, 5000, -5000]);
    const encoded = encodeMuLaw(samples);
    expect(encoded.length).toBe(5);
  });

  it('preserves sign across encode/decode', () => {
    const samples = new Int16Array([3000, -3000]);
    const pcmBuf = Buffer.from(samples.buffer);

    const decoded = decodeMuLaw(encodeMuLaw(pcmBuf));
    const result = new Int16Array(decoded.buffer, decoded.byteOffset, 2);

    expect(result[0]).toBeGreaterThan(0);
    expect(result[1]).toBeLessThan(0);
  });

  it('produces different encoded bytes for different amplitudes', () => {
    const quiet = new Int16Array([100]);
    const loud = new Int16Array([20000]);

    const encQuiet = encodeMuLaw(Buffer.from(quiet.buffer));
    const encLoud = encodeMuLaw(Buffer.from(loud.buffer));

    expect(encQuiet[0]).not.toBe(encLoud[0]);
  });
});

describe('resampleLinear', () => {
  it('returns same buffer when rates match', () => {
    const buf = Buffer.from(new Int16Array([1, 2, 3]).buffer);
    const result = resampleLinear(buf, 16000, 16000);
    expect(result).toBe(buf); // exact same reference
  });

  it('downsamples 16kHz to 8kHz (halves sample count)', () => {
    const samples = new Int16Array(1600); // 100ms at 16kHz
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(Math.sin(i * 0.1) * 10000);
    }
    const buf = Buffer.from(samples.buffer);
    const result = resampleLinear(buf, 16000, 8000);
    const outSamples = new Int16Array(result.buffer, result.byteOffset, result.byteLength / 2);

    expect(outSamples.length).toBe(800); // half
  });

  it('downsamples 22050Hz to 8000Hz correctly', () => {
    const samples = new Int16Array(2205); // 100ms at 22050Hz
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(Math.sin(i * 0.05) * 8000);
    }
    const buf = Buffer.from(samples.buffer);
    const result = resampleLinear(buf, 22050, 8000);
    const outSamples = new Int16Array(result.buffer, result.byteOffset, result.byteLength / 2);

    // 2205 * (8000/22050) ≈ 800
    expect(outSamples.length).toBe(Math.floor(2205 / (22050 / 8000)));
  });

  it('accepts Int16Array directly', () => {
    const samples = new Int16Array([100, 200, 300, 400]);
    const result = resampleLinear(samples, 16000, 8000);
    const out = new Int16Array(result.buffer, result.byteOffset, result.byteLength / 2);
    expect(out.length).toBe(2);
  });

  it('interpolates values between samples', () => {
    // Two samples: 0 and 10000, downsample 4:1
    const samples = new Int16Array([0, 0, 10000, 10000]);
    const buf = Buffer.from(samples.buffer);
    const result = resampleLinear(buf, 4000, 2000);
    const out = new Int16Array(result.buffer, result.byteOffset, result.byteLength / 2);

    expect(out.length).toBe(2);
    // First sample should be near 0, second near 10000
    expect(out[0]).toBe(0);
  });
});

describe('convertToTelephonyAudio', () => {
  it('converts 22050Hz PCM to 8kHz μ-law', () => {
    // 1 second of 22050Hz silence
    const pcm = Buffer.alloc(22050 * 2); // 16-bit
    const result = convertToTelephonyAudio(pcm, 22050);

    // Should be ~8000 μ-law bytes (1 second at 8kHz)
    expect(result.length).toBe(8000);
  });

  it('converts 24000Hz PCM to 8kHz μ-law', () => {
    const pcm = Buffer.alloc(24000 * 2);
    const result = convertToTelephonyAudio(pcm, 24000);
    expect(result.length).toBe(8000);
  });

  it('output is all valid byte values', () => {
    const samples = new Int16Array(2205);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(Math.sin(i * 0.1) * 15000);
    }
    const result = convertToTelephonyAudio(Buffer.from(samples.buffer), 22050);

    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(0);
      expect(result[i]).toBeLessThanOrEqual(255);
    }
  });
});

describe('attenuateAudio', () => {
  it('reduces amplitude with default factor', () => {
    // Create a loud μ-law signal
    const loud = new Int16Array([10000, -10000, 10000, -10000]);
    const mulaw = encodeMuLaw(loud);

    const attenuated = attenuateAudio(mulaw);

    // Decode both and compare amplitudes
    const origPcm = decodeMuLaw(mulaw);
    const attPcm = decodeMuLaw(attenuated);
    const origSamples = new Int16Array(origPcm.buffer, origPcm.byteOffset, origPcm.byteLength / 2);
    const attSamples = new Int16Array(attPcm.buffer, attPcm.byteOffset, attPcm.byteLength / 2);

    for (let i = 0; i < origSamples.length; i++) {
      expect(Math.abs(attSamples[i])).toBeLessThan(Math.abs(origSamples[i]));
    }
  });

  it('preserves length', () => {
    const mulaw = encodeMuLaw(new Int16Array([5000, -5000, 3000]));
    const attenuated = attenuateAudio(mulaw, 0.5);
    expect(attenuated.length).toBe(mulaw.length);
  });

  it('factor of 1.0 preserves amplitude approximately', () => {
    const samples = new Int16Array([8000]);
    const mulaw = encodeMuLaw(samples);
    const attenuated = attenuateAudio(mulaw, 1.0);

    const origDecoded = new Int16Array(decodeMuLaw(mulaw).buffer)[0];
    const attDecoded = new Int16Array(decodeMuLaw(attenuated).buffer)[0];

    // Double μ-law roundtrip introduces some error, but should be close
    expect(Math.abs(origDecoded - attDecoded)).toBeLessThan(500);
  });

  it('factor of 0 produces near-silence', () => {
    const samples = new Int16Array([20000, -20000]);
    const mulaw = encodeMuLaw(samples);
    const attenuated = attenuateAudio(mulaw, 0.0);

    const decoded = decodeMuLaw(attenuated);
    const result = new Int16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2);

    for (const s of result) {
      expect(Math.abs(s)).toBeLessThan(200);
    }
  });
});
