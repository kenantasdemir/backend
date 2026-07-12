#!/bin/bash
# Stop any existing cloudflared tunnel processes to avoid port or tunnel conflicts
pkill -f "cloudflared tunnel"

echo "Starting Cloudflare quick tunnel in the background for port 3000..."
nohup /opt/homebrew/bin/cloudflared tunnel --url http://localhost:3000 > tunnel.log 2>&1 &

echo "Waiting for the tunnel URL to be generated..."
sleep 5

# Check if the URL is in the log file
if grep -q "trycloudflare.com" tunnel.log; then
    echo "--------------------------------------------------------"
    grep -o "https://[a-zA-Z0-9-]*\.trycloudflare\.com" tunnel.log | uniq
    echo "--------------------------------------------------------"
else
    echo "Tunnel started, but URL could not be found in logs yet. Check tunnel.log shortly."
fi
