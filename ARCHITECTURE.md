# Fact-Whisper Architecture

Real-time phone call fact-checking. You call a number, say things, and if you state something factually wrong, a voice whispers the correction in your ear.

## Pipeline

```
Phone Call
    → Twilio (receives call, opens WebSocket media stream)
    → Deepgram Nova-2 (streaming speech-to-text, μ-law 8kHz)
    → Claude Haiku (claim detection: is this a checkable fact?)
    → Claude Sonnet (verification with web search: is it true?)
    → ElevenLabs Turbo v2.5 (text-to-speech correction)
    → μ-law audio encoding + attenuation (whisper effect)
    → Twilio WebSocket (plays audio back to caller)
```

Total latency from false claim to whispered correction: ~2-4 seconds.

## Source Files

| File | Purpose |
|------|---------|
| `src/server.js` | Express + WebSocket server, orchestrates the pipeline |
| `src/twilio.js` | TwiML webhook responses, WebSocket message parsing, audio sending |
| `src/deepgram.js` | Streaming STT via Deepgram Nova-2, configured for μ-law 8kHz |
| `src/claims.js` | Two-stage claim processing: detection (Haiku) + verification (Sonnet + web search) |
| `src/tts.js` | ElevenLabs streaming TTS, returns PCM audio |
| `src/audio.js` | μ-law encoding/decoding, resampling (22050→8000Hz), volume attenuation |

## Infrastructure

- **VPS**: Hetzner CX23 (2 vCPU, 4GB RAM)
- **Domain**: Dynamic DNS (e.g., DuckDNS) or any domain pointing to the VPS
- **Reverse proxy**: Caddy (automatic HTTPS via Let's Encrypt)
- **Process manager**: systemd
- **Phone number**: Twilio number with Voice capability
- **Firewall**: UFW (ports 22, 80, 443 only)

## How a Call Works

1. Someone calls the Twilio number
2. Twilio sends a POST to `/twilio/inbound`
3. Server responds with TwiML telling Twilio to open a WebSocket stream to `/media`
4. Twilio streams raw μ-law 8kHz audio over the WebSocket
5. Audio chunks are forwarded to Deepgram for real-time transcription
6. Each final transcript segment is checked by Haiku for factual claims
7. Detected claims are verified by Sonnet with web search
8. If a claim is false, ElevenLabs generates a spoken correction
9. The audio is resampled to 8kHz μ-law, attenuated for a whisper effect
10. The correction is sent back through the Twilio WebSocket, playing in the caller's ear

## Audio Format Notes

- Twilio streams and expects **μ-law 8kHz mono** audio
- ElevenLabs outputs **PCM 22050Hz 16-bit mono**
- `audio.js` handles the conversion: resample 22050→8000, then encode to μ-law
- Audio is attenuated by 0.5x for a subtle whisper effect
- Twilio expects audio in 160-byte chunks (20ms frames)

## Cost Estimates

| Service | Cost | Notes |
|---------|------|-------|
| Hetzner VPS | $4.09/mo | Fixed |
| Twilio number | ~$1.15/mo | Fixed |
| Twilio voice | ~$0.0085/min | Per inbound minute |
| Deepgram Nova-2 | $0.0043/min | Streaming STT |
| Anthropic Haiku | ~$0.001/call | Claim detection |
| Anthropic Sonnet | ~$0.01/call | Verification + web search |
| ElevenLabs | varies | Per correction TTS |

A typical 5-minute call with a few corrections: ~$0.10-0.20 in API costs.

## Logging

All app logs go through systemd's journal. To make them persist across reboots and keep history:

```bash
# On the VPS, ensure persistent logging is enabled:
mkdir -p /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal
systemctl restart systemd-journald
```

Useful log commands:
```bash
# Live logs
journalctl -u factwhisper -f

# Logs from today
journalctl -u factwhisper --since today

# Export all logs to a file
journalctl -u factwhisper --no-pager > /opt/epistemic-filter/calls.log

# Logs from a specific time range
journalctl -u factwhisper --since "2026-02-06 02:00" --until "2026-02-06 03:00"
```

## Environment Variables

The app requires these env vars (stored in `/opt/epistemic-filter/.env` on the VPS):

- `TWILIO_ACCOUNT_SID` — Twilio account identifier
- `TWILIO_AUTH_TOKEN` — Twilio authentication
- `DEEPGRAM_API_KEY` — Deepgram STT access
- `ANTHROPIC_API_KEY` — Claude API access
- `ELEVENLABS_API_KEY` — ElevenLabs TTS access
- `ELEVENLABS_VOICE_ID` — Which ElevenLabs voice to use
- `PORT` — Server port (default 8080)
- `HOST` — Public domain (used to construct WebSocket URL in TwiML)
