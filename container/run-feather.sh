#!/bin/bash
if [ -f /home/user/.env ]; then
    set -a
    . /home/user/.env
    set +a
fi
if [ -f /home/user/anthropic-key ]; then
    set -a
    . /home/user/anthropic-key
    set +a
fi
export FEATHER_UPLOAD_DIR=/opt/feather/uploads
exec /usr/local/bin/feather
