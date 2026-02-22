#!/bin/bash
# Tail Feather logs
SERVICE="${1:-feather}"
echo "=== Logs: $SERVICE (Ctrl-C to stop) ==="
sudo supervisorctl tail -f "$SERVICE"
