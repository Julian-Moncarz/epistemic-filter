#!/bin/bash
# Deploy Fact-Whisper to VPS
# Usage: ./deploy.sh
# Your SSH key passphrase will be prompted by ssh-agent.

set -e

SERVER="${DEPLOY_HOST:-root@YOUR_VPS_IP}"
APP_DIR="/opt/epistemic-filter"

echo "Deploying to $SERVER..."

ssh $SERVER "cd $APP_DIR && git pull && npm install --production && systemctl restart factwhisper && echo 'Deploy complete. App status:' && systemctl is-active factwhisper"
