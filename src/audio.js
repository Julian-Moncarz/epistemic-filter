// μ-law encoding/decoding and audio resampling utilities

const MULAW_BIAS = 0x84;
const MULAW_MAX = 0x7FFF;
const MULAW_CLIP = 32635;

// Encode a 16-bit linear PCM sample to 8-bit μ-law
function encodeMuLawSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}

  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  const muLawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return muLawByte;
}

// Decode an 8-bit μ-law sample to 16-bit linear PCM
function decodeMuLawSample(muLawByte) {
  muLawByte = ~muLawByte & 0xFF;
  const sign = muLawByte & 0x80;
  const exponent = (muLawByte >> 4) & 0x07;
  const mantissa = muLawByte & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

// Encode a buffer of 16-bit PCM (Int16Array or Buffer of LE int16s) to μ-law bytes
export function encodeMuLaw(pcmBuffer) {
  const samples = pcmBuffer instanceof Int16Array
    ? pcmBuffer
    : new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 2);

  const mulaw = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) {
    mulaw[i] = encodeMuLawSample(samples[i]);
  }
  return mulaw;
}

// Decode a μ-law buffer to 16-bit PCM (returns Buffer of LE int16s)
export function decodeMuLaw(mulawBuffer) {
  const pcm = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    const sample = decodeMuLawSample(mulawBuffer[i]);
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

// Downsample PCM from sourceRate to targetRate using linear interpolation
export function resampleLinear(pcmBuffer, sourceRate, targetRate) {
  if (sourceRate === targetRate) return pcmBuffer;

  const samples = pcmBuffer instanceof Int16Array
    ? pcmBuffer
    : new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 2);

  const ratio = sourceRate / targetRate;
  const outputLength = Math.floor(samples.length / ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;

    if (idx + 1 < samples.length) {
      output[i] = Math.round(samples[idx] * (1 - frac) + samples[idx + 1] * frac);
    } else {
      output[i] = samples[idx] || 0;
    }
  }

  return Buffer.from(output.buffer);
}

// Convert ElevenLabs PCM output (typically 22050Hz or 24000Hz, 16-bit mono)
// to Telnyx-compatible μ-law 8kHz
export function convertToTelnyxAudio(pcmBuffer, sourceRate = 22050) {
  const resampled = resampleLinear(pcmBuffer, sourceRate, 8000);
  return encodeMuLaw(resampled);
}

// Reduce volume of μ-law audio for whisper effect
export function attenuateAudio(mulawBuffer, factor = 0.4) {
  const pcm = decodeMuLaw(mulawBuffer);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(samples[i] * factor);
  }
  return encodeMuLaw(samples);
}
