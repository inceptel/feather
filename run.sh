#!/bin/bash
# Feather Production
cd "$(dirname "$0")"
set -a; source .env; set +a
exec ./target/release/feather-rs
