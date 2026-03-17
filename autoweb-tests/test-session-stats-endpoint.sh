#!/bin/bash
# test-session-stats-endpoint.sh
# Tests: /api/sessions/:id/stats endpoint returns session statistics

# Get any session ID from the API
PROJECT_ID=$(curl -s http://localhost:4860/api/projects | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['projects'][0]['id'])" 2>/dev/null)
SESSION_ID=$(curl -s "http://localhost:4860/api/projects/$PROJECT_ID/sessions" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['sessions'][0]['id'])" 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
    echo "SKIP: no sessions available"
    exit 0
fi

RESPONSE=$(curl -s "http://localhost:4860/api/sessions/$SESSION_ID/stats")

# Must have session_id field
echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'session_id' in d, 'missing session_id'" || exit 1
# Must have by_role
echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'by_role' in d, 'missing by_role'" || exit 1
# Must have message_count
echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'message_count' in d, 'missing message_count'" || exit 1
# message_count must be integer >= 0
echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); assert isinstance(d['message_count'], int) and d['message_count'] >= 0, 'bad message_count'" || exit 1
# Invalid session ID should return 404 or 400
BAD=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:4860/api/sessions/not-a-real-session-id/stats")
[ "$BAD" = "404" ] || [ "$BAD" = "400" ] || exit 1

exit 0
