#!/bin/bash
# test_tenant.sh — Tests for tenant.sh stop/start/status commands
# Uses mock podman/curl to test without real containers.
# Run: bash birth/test_tenant.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR=$(mktemp -d)
TENANT_FILE="$TEST_DIR/tenants.json"
MOCK_BIN="$TEST_DIR/bin"
PASS=0
FAIL=0

cleanup() { rm -rf "$TEST_DIR"; }
trap cleanup EXIT

# --- Setup mock binaries ---
mkdir -p "$MOCK_BIN"

# Mock podman
cat > "$MOCK_BIN/podman" << 'MOCK'
#!/bin/bash
case "$1" in
    stop|rm|start|run)
        echo "mock-podman: $*" >&2
        ;;
    inspect)
        if [[ "$*" == *"-f"* ]]; then
            echo "running"
        else
            echo '{"State":{"Status":"running"}}'
        fi
        ;;
    *)
        echo "mock-podman: $*" >&2
        ;;
esac
exit 0
MOCK
chmod +x "$MOCK_BIN/podman"

# Mock curl (for health check and Caddy API)
cat > "$MOCK_BIN/curl" << 'MOCK'
#!/bin/bash
# Succeed for health checks and Caddy admin API
if [[ "$*" == *"/health"* ]]; then
    echo "OK"
elif [[ "$*" == *"localhost:2020"* ]]; then
    if [[ "$*" == *"routes/"* ]]; then
        echo "2"
    else
        echo "{}"
    fi
fi
exit 0
MOCK
chmod +x "$MOCK_BIN/curl"

# Mock python3 (for route count)
cat > "$MOCK_BIN/python3" << 'MOCK'
#!/bin/bash
# Return route count
echo "2"
MOCK
chmod +x "$MOCK_BIN/python3"

export PATH="$MOCK_BIN:$PATH"
export TENANT_FILE
export DOMAIN_SUFFIX="test.feather-cloud.dev"
export WORK_IMAGE="localhost/feather-work:test"

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        PASS=$((PASS + 1))
        echo "  PASS: $desc"
    else
        FAIL=$((FAIL + 1))
        echo "  FAIL: $desc (expected '$expected', got '$actual')"
    fi
}

assert_contains() {
    local desc="$1" needle="$2" haystack="$3"
    if echo "$haystack" | grep -q "$needle"; then
        PASS=$((PASS + 1))
        echo "  PASS: $desc"
    else
        FAIL=$((FAIL + 1))
        echo "  FAIL: $desc (expected to contain '$needle')"
    fi
}

# --- Test: Add a tenant ---
echo "Test: add tenant"
echo '{}' > "$TENANT_FILE"
bash "$SCRIPT_DIR/tenant.sh" add testuser > /dev/null 2>&1
status=$(jq -r '.testuser.status' "$TENANT_FILE")
assert_eq "add sets status to running" "running" "$status"

port=$(jq -r '.testuser.port' "$TENANT_FILE")
assert_eq "add assigns port 9001" "9001" "$port"

subdomain=$(jq -r '.testuser.subdomain' "$TENANT_FILE")
assert_eq "add sets correct subdomain" "testuser.test.feather-cloud.dev" "$subdomain"

image_tag=$(jq -r '.testuser.active_image_tag' "$TENANT_FILE")
assert_eq "add sets active_image_tag" "$WORK_IMAGE" "$image_tag"

# Check new fields exist
stripe_cid=$(jq -r '.testuser.stripe_customer_id' "$TENANT_FILE")
assert_eq "add sets stripe_customer_id to null" "null" "$stripe_cid"

compute=$(jq -r '.testuser.compute_seconds_this_period' "$TENANT_FILE")
assert_eq "add sets compute_seconds to 0" "0" "$compute"

# --- Test: Stop tenant ---
echo "Test: stop tenant"
bash "$SCRIPT_DIR/tenant.sh" stop testuser > /dev/null 2>&1
status=$(jq -r '.testuser.status' "$TENANT_FILE")
assert_eq "stop sets status to stopped" "stopped" "$status"

# Stop again should be idempotent
bash "$SCRIPT_DIR/tenant.sh" stop testuser > /dev/null 2>&1
status=$(jq -r '.testuser.status' "$TENANT_FILE")
assert_eq "stop is idempotent" "stopped" "$status"

# --- Test: Start tenant ---
echo "Test: start tenant"
bash "$SCRIPT_DIR/tenant.sh" start testuser > /dev/null 2>&1
status=$(jq -r '.testuser.status' "$TENANT_FILE")
assert_eq "start sets status to running" "running" "$status"

# Start again should be idempotent
bash "$SCRIPT_DIR/tenant.sh" start testuser > /dev/null 2>&1
status=$(jq -r '.testuser.status' "$TENANT_FILE")
assert_eq "start is idempotent" "running" "$status"

# --- Test: Status ---
echo "Test: status"
output=$(bash "$SCRIPT_DIR/tenant.sh" status testuser 2>/dev/null)
assert_contains "status returns JSON with port" '"port"' "$output"
assert_contains "status returns podman_state" '"podman_state"' "$output"

# --- Test: created_at field ---
echo "Test: created_at field"
created=$(jq -r '.testuser.created_at' "$TENANT_FILE")
assert_contains "created_at is ISO timestamp" "T" "$created"

# --- Test: last_access updated on stop ---
echo "Test: last_access updates"
bash "$SCRIPT_DIR/tenant.sh" stop testuser > /dev/null 2>&1
la_after_stop=$(jq -r '.testuser.last_access' "$TENANT_FILE")
assert_contains "last_access updated on stop" "T" "$la_after_stop"
bash "$SCRIPT_DIR/tenant.sh" start testuser > /dev/null 2>&1
la_after_start=$(jq -r '.testuser.last_access' "$TENANT_FILE")
assert_contains "last_access updated on start" "T" "$la_after_start"

# --- Test: image_tags is an array ---
echo "Test: image_tags"
tag_count=$(jq '.testuser.image_tags | length' "$TENANT_FILE")
assert_eq "image_tags has 1 entry" "1" "$tag_count"
first_tag=$(jq -r '.testuser.image_tags[0]' "$TENANT_FILE")
assert_eq "image_tags[0] matches WORK_IMAGE" "$WORK_IMAGE" "$first_tag"

# --- Test: Add second tenant gets next port ---
echo "Test: second tenant port allocation"
bash "$SCRIPT_DIR/tenant.sh" add testuser2 > /dev/null 2>&1
port2=$(jq -r '.testuser2.port' "$TENANT_FILE")
assert_eq "second tenant gets port 9002" "9002" "$port2"

# --- Test: Container name convention ---
echo "Test: container naming"
container=$(jq -r '.testuser.container' "$TENANT_FILE")
assert_eq "container name follows convention" "feather-user-testuser" "$container"
container2=$(jq -r '.testuser2.container' "$TENANT_FILE")
assert_eq "container2 name follows convention" "feather-user-testuser2" "$container2"

# --- Test: Volume name convention ---
echo "Test: volume naming"
volume=$(jq -r '.testuser.volume' "$TENANT_FILE")
assert_eq "volume name follows convention" "feather-user-testuser" "$volume"

# --- Test: Route ID convention ---
echo "Test: route_id naming"
route_id=$(jq -r '.testuser.route_id' "$TENANT_FILE")
assert_eq "route_id follows convention" "tenant-testuser" "$route_id"

# --- Test: Password generated ---
echo "Test: password generation"
pass=$(jq -r '.testuser.password' "$TENANT_FILE")
pass_len=${#pass}
if [ "$pass_len" -ge 4 ] && [ "$pass_len" -le 8 ]; then
    PASS=$((PASS + 1))
    echo "  PASS: password has reasonable length ($pass_len)"
else
    FAIL=$((FAIL + 1))
    echo "  FAIL: password length unexpected ($pass_len)"
fi

# --- Test: Add duplicate fails ---
echo "Test: duplicate add"
if bash "$SCRIPT_DIR/tenant.sh" add testuser > /dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    echo "  FAIL: duplicate add should fail"
else
    PASS=$((PASS + 1))
    echo "  PASS: duplicate add fails"
fi

# --- Test: Invalid username ---
echo "Test: invalid usernames"
if bash "$SCRIPT_DIR/tenant.sh" add "UPPER" > /dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    echo "  FAIL: uppercase username should fail"
else
    PASS=$((PASS + 1))
    echo "  PASS: uppercase username rejected"
fi

if bash "$SCRIPT_DIR/tenant.sh" add "1starts-with-number" > /dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    echo "  FAIL: number-first username should fail"
else
    PASS=$((PASS + 1))
    echo "  PASS: number-first username rejected"
fi

# --- Test: Remove then re-add ---
echo "Test: remove and re-add"
bash "$SCRIPT_DIR/tenant.sh" remove testuser2 > /dev/null 2>&1
removed=$(jq -r '.testuser2 // "gone"' "$TENANT_FILE")
assert_eq "remove deletes from tenants.json" "gone" "$removed"

# Re-add should succeed and reclaim the port
bash "$SCRIPT_DIR/tenant.sh" add testuser2 > /dev/null 2>&1
port2_new=$(jq -r '.testuser2.port' "$TENANT_FILE")
assert_eq "re-added tenant gets port 9002 again" "9002" "$port2_new"

# --- Test: List command ---
echo "Test: list"
list_output=$(bash "$SCRIPT_DIR/tenant.sh" list 2>/dev/null)
assert_contains "list shows testuser" "testuser" "$list_output"
assert_contains "list shows testuser2" "testuser2" "$list_output"
assert_contains "list shows URL column" "https://" "$list_output"

# --- Test: Stop nonexistent tenant fails ---
echo "Test: error cases"
if bash "$SCRIPT_DIR/tenant.sh" stop nonexistent > /dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    echo "  FAIL: stop nonexistent should fail"
else
    PASS=$((PASS + 1))
    echo "  PASS: stop nonexistent fails"
fi

if bash "$SCRIPT_DIR/tenant.sh" start nonexistent > /dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    echo "  FAIL: start nonexistent should fail"
else
    PASS=$((PASS + 1))
    echo "  PASS: start nonexistent fails"
fi

if bash "$SCRIPT_DIR/tenant.sh" status nonexistent > /dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    echo "  FAIL: status nonexistent should fail"
else
    PASS=$((PASS + 1))
    echo "  PASS: status nonexistent fails"
fi

if bash "$SCRIPT_DIR/tenant.sh" remove nonexistent > /dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    echo "  FAIL: remove nonexistent should fail"
else
    PASS=$((PASS + 1))
    echo "  PASS: remove nonexistent fails"
fi

# --- Test: Usage with no args ---
echo "Test: usage message"
usage_output=$(bash "$SCRIPT_DIR/tenant.sh" 2>&1 || true)
assert_contains "no-args shows usage" "Usage:" "$usage_output"
assert_contains "usage lists stop command" "stop" "$usage_output"
assert_contains "usage lists start command" "start" "$usage_output"
assert_contains "usage lists status command" "status" "$usage_output"

# --- Test: Domain suffix env var ---
echo "Test: domain suffix override"
echo '{}' > "$TENANT_FILE"
DOMAIN_SUFFIX="custom.example.com" bash "$SCRIPT_DIR/tenant.sh" add domtest > /dev/null 2>&1
custom_sub=$(jq -r '.domtest.subdomain' "$TENANT_FILE")
assert_eq "custom DOMAIN_SUFFIX used" "domtest.custom.example.com" "$custom_sub"

# --- Summary ---
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
