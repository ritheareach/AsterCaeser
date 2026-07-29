#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/astercaeser-ui.service"

if [ ! -f "$SERVICE_FILE" ]; then
  echo "Error: astercaeser-ui.service not found in $SCRIPT_DIR"
  exit 1
fi

echo "Installing AsterCaeser UI service..."
echo "Make sure you've edited astercaeser-ui.service with your username and paths first!"
echo ""

sudo cp "$SERVICE_FILE" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable astercaeser-ui
sudo systemctl start astercaeser-ui
sudo systemctl status astercaeser-ui
