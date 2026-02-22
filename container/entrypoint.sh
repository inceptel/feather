#!/bin/bash
set -e

# Ensure directories exist
mkdir -p ~/memory
mkdir -p ~/.claude

# Initialize Claude settings if not present
if [ ! -f ~/.claude/settings.json ]; then
    cat > ~/.claude/settings.json << 'SETTINGS'
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  },
  "env": {
    "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY": "1"
  }
}
SETTINGS
fi

# Initialize memory file if not present
if [ ! -f ~/memory/MEMORY.md ]; then
    cat > ~/memory/MEMORY.md << 'MEMORY'
# Memory

## Identity
- Name: (your name)
- Email: (your email)

## Preferences
(add your preferences here)

## Active Projects
(list your active projects)

## Notes
(important things to remember)
MEMORY
fi

# Load .env if present (for API keys etc)
if [ -f ~/.env ]; then
    set -a
    source ~/.env
    set +a
fi

echo "Starting Feather workspace as user: $(whoami)"

# Start supervisord
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
