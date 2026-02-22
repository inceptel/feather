#!/bin/bash
if [ -f /home/user/.env ]; then
    set -a
    . /home/user/.env
    set +a
fi
export FEATHER_UPLOAD_DIR=/opt/feather/uploads
exec /usr/local/bin/feather
