#!/bin/bash
set -euo pipefail

# tenant.sh — Multi-tenant user provisioning for Feather
# Manages isolated work containers with Caddy subdomain routing.
#
# Usage:
#   tenant.sh add <username>     Start a user container, add Caddy route
#   tenant.sh remove <username>  Stop container, remove Caddy route
#   tenant.sh list               Show all active tenants

WORK_IMAGE="${WORK_IMAGE:-localhost/feather-work:latest}"
TENANT_FILE="/tmp/tenants.json"
PORT_MIN=9001
PORT_MAX=9010
HEALTH_TIMEOUT=120
DOMAIN_SUFFIX="users.inceptel.ai"

log() { echo "[tenant] $(date '+%H:%M:%S') $*"; }

# --- Initialize tenant file ---
if [ ! -f "$TENANT_FILE" ]; then
    echo '{}' > "$TENANT_FILE"
fi

# --- Helpers ---
gen_password() {
    head -c 16 /dev/urandom | base64 | tr -dc 'a-z0-9' | head -c 6
}

next_port() {
    local used
    used=$(jq -r '.[].port // empty' "$TENANT_FILE" 2>/dev/null | sort -n)
    for port in $(seq $PORT_MIN $PORT_MAX); do
        if ! echo "$used" | grep -qx "$port"; then
            echo "$port"
            return 0
        fi
    done
    log "ERROR: No available ports ($PORT_MIN-$PORT_MAX all in use)"
    return 1
}

get_tenant() {
    jq -r --arg name "$1" '.[$name] // empty' "$TENANT_FILE"
}

# --- Collect env vars to pass through ---
collect_env_args() {
    local env_args=()
    while IFS='=' read -r key value; do
        case "$key" in
            FEATHER_ANTHROPIC_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|FEATHER_OPENAI_API_KEY)
                env_args+=(-e "${key}=${value}")
                ;;
        esac
    done < <(env)
    echo "${env_args[@]}"
}

# --- Add tenant ---
cmd_add() {
    local username="$1"

    # Validate username
    if ! [[ "$username" =~ ^[a-z][a-z0-9-]{0,19}$ ]]; then
        log "ERROR: Username must be lowercase alphanumeric (max 20 chars, start with letter)"
        exit 1
    fi

    # Check if already exists
    if [ -n "$(get_tenant "$username")" ]; then
        log "ERROR: Tenant '$username' already exists"
        jq -r --arg name "$username" '.[$name] | "  Port: \(.port)\n  URL: https://\(.subdomain)\n  Container: \(.container)"' "$TENANT_FILE"
        exit 1
    fi

    local port
    port=$(next_port)
    local container_name="feather-user-${username}"
    local volume_name="feather-user-${username}"
    local subdomain="${username}.${DOMAIN_SUFFIX}"
    local password
    password=$(gen_password)

    log "Provisioning tenant: $username"
    log "  Port: $port"
    log "  Container: $container_name"
    log "  Subdomain: $subdomain"

    # Collect env vars
    local env_args=()
    while IFS='=' read -r key value; do
        case "$key" in
            FEATHER_ANTHROPIC_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|FEATHER_OPENAI_API_KEY)
                env_args+=(-e "${key}=${value}")
                ;;
        esac
    done < <(env)

    # Clean up any stale container
    podman stop -t 5 "$container_name" 2>/dev/null || true
    podman rm -f "$container_name" 2>/dev/null || true

    # Start user container with isolated volume
    podman run -d \
        --name "$container_name" \
        --dns 8.8.8.8 --dns 1.1.1.1 \
        -p "127.0.0.1:${port}:8080" \
        -v "${volume_name}:/home/user:Z" \
        -e "FEATHER_PASSWORD=${password}" \
        "${env_args[@]}" \
        "$WORK_IMAGE"

    log "Container started, waiting for health..."

    # Health check
    local healthy=false
    for i in $(seq 1 "$HEALTH_TIMEOUT"); do
        if curl -sf "http://127.0.0.1:${port}/health" > /dev/null 2>&1; then
            healthy=true
            break
        fi
        sleep 1
    done

    if [ "$healthy" != "true" ]; then
        log "ERROR: Container failed health check after ${HEALTH_TIMEOUT}s"
        podman logs "$container_name" 2>&1 | tail -20
        podman stop -t 5 "$container_name" 2>/dev/null || true
        podman rm -f "$container_name" 2>/dev/null || true
        exit 1
    fi

    log "Container healthy"

    # Add Caddy route for subdomain
    # Insert before the last route (catch-all). Get route count, insert at N-1.
    local route_id="tenant-${username}"
    local route_count
    route_count=$(curl -sf http://localhost:2020/config/apps/http/servers/main/routes/ | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "1")
    local insert_pos=$((route_count > 0 ? route_count - 1 : 0))

    local route_json
    route_json=$(cat <<ROUTE
{
    "@id": "${route_id}",
    "match": [{"host": ["${subdomain}"]}],
    "handle": [
        {
            "handler": "reverse_proxy",
            "upstreams": [{"dial": "127.0.0.1:${port}"}],
            "flush_interval": -1,
            "transport": {
                "protocol": "http",
                "read_buffer_size": 4096
            }
        }
    ],
    "terminal": true
}
ROUTE
)

    local caddy_response
    caddy_response=$(curl -sf -X POST \
        -H "Content-Type: application/json" \
        -d "$route_json" \
        "http://localhost:2020/config/apps/http/servers/main/routes/${insert_pos}" 2>&1) || {
        log "WARN: Caddy route add failed: $caddy_response"
        log "Container is running but subdomain routing may not work"
    }

    log "Caddy route added for $subdomain"

    # Save to tenant file
    jq --arg name "$username" \
       --argjson port "$port" \
       --arg container "$container_name" \
       --arg volume "$volume_name" \
       --arg subdomain "$subdomain" \
       --arg password "$password" \
       --arg route_id "$route_id" \
       '.[$name] = {port: $port, container: $container, volume: $volume, subdomain: $subdomain, password: $password, route_id: $route_id}' \
       "$TENANT_FILE" > /tmp/tenants-tmp.json && mv /tmp/tenants-tmp.json "$TENANT_FILE"

    log "Tenant provisioned successfully"
    echo ""
    echo "  https://${subdomain} | password: ${password}"
    echo ""
}

# --- Remove tenant ---
cmd_remove() {
    local username="$1"

    local tenant
    tenant=$(get_tenant "$username")
    if [ -z "$tenant" ]; then
        log "ERROR: Tenant '$username' not found"
        exit 1
    fi

    local container_name port route_id
    container_name=$(echo "$tenant" | jq -r '.container')
    port=$(echo "$tenant" | jq -r '.port')
    route_id=$(echo "$tenant" | jq -r '.route_id')

    log "Removing tenant: $username"

    # Remove Caddy route
    curl -sf -X DELETE "http://localhost:2020/id/${route_id}" 2>/dev/null || {
        log "WARN: Could not remove Caddy route (may already be gone)"
    }

    # Stop and remove container
    podman stop -t 10 "$container_name" 2>/dev/null || true
    podman rm -f "$container_name" 2>/dev/null || true

    # Remove from tenant file (volume is preserved for data recovery)
    jq --arg name "$username" 'del(.[$name])' "$TENANT_FILE" > /tmp/tenants-tmp.json \
        && mv /tmp/tenants-tmp.json "$TENANT_FILE"

    log "Tenant '$username' removed (volume preserved)"
}

# --- List tenants ---
cmd_list() {
    local count
    count=$(jq 'length' "$TENANT_FILE")

    if [ "$count" -eq 0 ]; then
        echo "No active tenants"
        return
    fi

    printf "%-15s %-6s %-35s %s\n" "USERNAME" "PORT" "URL" "CONTAINER"
    printf "%-15s %-6s %-35s %s\n" "--------" "----" "---" "---------"

    jq -r 'to_entries[] | [.key, (.value.port|tostring), "https://\(.value.subdomain)", .value.container] | @tsv' "$TENANT_FILE" \
        | while IFS=$'\t' read -r name port url container; do
            local status="?"
            if podman inspect "$container" > /dev/null 2>&1; then
                status=$(podman inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo "?")
            fi
            printf "%-15s %-6s %-35s %s (%s)\n" "$name" "$port" "$url" "$container" "$status"
        done
}

# --- Main ---
case "${1:-}" in
    add)
        if [ -z "${2:-}" ]; then
            echo "Usage: tenant.sh add <username>"
            exit 1
        fi
        cmd_add "$2"
        ;;
    remove)
        if [ -z "${2:-}" ]; then
            echo "Usage: tenant.sh remove <username>"
            exit 1
        fi
        cmd_remove "$2"
        ;;
    list)
        cmd_list
        ;;
    *)
        echo "Usage: tenant.sh {add|remove|list} [username]"
        echo ""
        echo "Commands:"
        echo "  add <username>     Provision a new user container"
        echo "  remove <username>  Stop and remove a user container"
        echo "  list               Show all active tenants"
        exit 1
        ;;
esac
