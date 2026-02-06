# Fact-Whisper Setup Guide

How to deploy Fact-Whisper (or a similar real-time phone call app) on a VPS.

## Prerequisites

You'll need accounts with:
- **Twilio** — phone number + voice API (twilio.com)
- **Deepgram** — speech-to-text API (deepgram.com)
- **Anthropic** — Claude API for claim detection/verification (console.anthropic.com)
- **ElevenLabs** — text-to-speech API (elevenlabs.io)
- **Hetzner** (or any VPS provider) — a small server (hetzner.com)
- **DuckDNS** (or any domain) — free dynamic DNS (duckdns.org)

## 1. Provision a VPS

Any cheap VPS works. Minimum specs: 1 vCPU, 2GB RAM, Ubuntu 24.04.

On Hetzner, a CX22 or CX23 ($4-6/mo) is plenty.

When creating the server, add your SSH public key so you can log in.

## 2. Point a Domain to Your VPS

You need a domain because Twilio requires HTTPS/WSS for webhooks and media streams.

**Using DuckDNS (free):**
1. Go to duckdns.org, sign in, claim a subdomain (e.g., `myapp.duckdns.org`)
2. Update it to point to your VPS IP:
```bash
curl "https://www.duckdns.org/update?domains=myapp&token=YOUR_TOKEN&ip=YOUR_VPS_IP"
```

**Using a real domain:** Point an A record to your VPS IP.

## 3. SSH Into Your Server

```bash
ssh root@YOUR_VPS_IP
```

## 4. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
```

Verify: `node --version` should show v22.x.x.

## 5. Install Caddy (Reverse Proxy + Auto-HTTPS)

Caddy automatically gets TLS certificates from Let's Encrypt.

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
```

Configure Caddy (`/etc/caddy/Caddyfile`):
```
yourdomain.duckdns.org {
    reverse_proxy localhost:8080
}
```

```bash
systemctl restart caddy
```

Caddy will automatically obtain a TLS certificate. This may take a minute.

## 6. Clone and Install the App

```bash
cd /opt
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
npm install --production
```

## 7. Create the .env File

```bash
nano /opt/YOUR_REPO/.env
```

```
TWILIO_ACCOUNT_SID=your_value
TWILIO_AUTH_TOKEN=your_value
DEEPGRAM_API_KEY=your_value
ANTHROPIC_API_KEY=your_value
ELEVENLABS_API_KEY=your_value
ELEVENLABS_VOICE_ID=your_value
PORT=8080
HOST=yourdomain.duckdns.org
```

The `HOST` variable is important — it tells the app what domain to use when constructing the WebSocket URL in the TwiML response to Twilio.

## 8. Create a systemd Service

This keeps the app running and auto-restarts on crash or reboot.

```bash
printf '[Unit]\nDescription=Fact-Whisper\nAfter=network.target\n\n[Service]\nWorkingDirectory=/opt/YOUR_REPO\nExecStart=/usr/bin/node src/server.js\nRestart=always\nRestartSec=5\nEnvironmentFile=/opt/YOUR_REPO/.env\n\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/factwhisper.service
```

```bash
systemctl daemon-reload
systemctl enable factwhisper
systemctl start factwhisper
```

Check status: `systemctl status factwhisper` — should show `active (running)`.

## 9. Set Up the Firewall

```bash
ufw allow 22
ufw allow 80
ufw allow 443
ufw --force enable
```

## 10. Verify

```bash
curl https://yourdomain.duckdns.org/health
```

Should return `{"status":"ok"}`.

## 11. Configure Twilio

1. Buy a phone number on Twilio (any number with Voice capability)
2. Go to Phone Numbers → your number → Voice Configuration
3. Set "A call comes in" to **Webhook**
4. URL: `https://yourdomain.duckdns.org/twilio/inbound`
5. Method: **HTTP POST**
6. Save

Call the number. Done.

## Troubleshooting

**Caddy can't get a certificate:**
- Make sure your domain resolves to your VPS IP: `dig +short yourdomain.duckdns.org`
- Make sure ports 80 and 443 are open: `ufw status`
- Check Caddy logs: `journalctl -u caddy --no-pager -n 30`

**App crashes on startup:**
- Check logs: `journalctl -u factwhisper --no-pager -n 30`
- Verify .env has all required variables
- Verify node is installed: `node --version`

**Call connects but no audio/corrections:**
- Check that the `HOST` env var matches your actual domain
- Check app logs during a call: `journalctl -u factwhisper -f`
- Verify Deepgram connection opens (look for `[deepgram] connection opened`)

**Using ngrok instead of a domain (quick testing):**
```bash
npm install -g ngrok
ngrok http 8080
```
Update `HOST` in `.env` to the ngrok domain and update the Twilio webhook URL. Note: the ngrok URL changes each time you restart unless you have a paid plan.

## Useful Commands

```bash
# View live logs
journalctl -u factwhisper -f

# Restart the app after code changes
systemctl restart factwhisper

# Check if everything is running
systemctl status factwhisper
systemctl status caddy

# Pull latest code and redeploy
cd /opt/YOUR_REPO && git pull && npm install --production && systemctl restart factwhisper
```
