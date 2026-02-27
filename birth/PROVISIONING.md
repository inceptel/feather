# Feather Multi-Tenant Provisioning

## What "provisioning" means

Each Feather user gets their own isolated **work container** — a full instance of Feather with its own password, data volume, and subdomain. The architecture:

```
NYC Server (185.209.178.175)
  └── Birth Container (feather-birth, host networking)
        ├── Caddy (port 80, subdomain routing)
        ├── Podman (manages all inner containers)
        ├── feather-work-blue (admin instance, port 8080)
        ├── feather-user-alice (port 9001) → alice.users.inceptel.ai
        ├── feather-user-bob (port 9002)   → bob.users.inceptel.ai
        └── ... (up to 10 users, ports 9001-9010)
```

When you "provision" a user:
1. A new container starts from the `feather-work` image
2. It gets its own persistent volume (`feather-user-{name}:/home/user`)
3. A random password is generated
4. Caddy gets a new route: `{name}.users.inceptel.ai → 127.0.0.1:{port}`
5. API keys are inherited from the birth container's environment

Each user's data is fully isolated. They can't see each other's sessions, code, or credentials.

## Commands

All commands run **inside the birth container**:

```bash
# SSH into the NYC server
ssh -i ~/.ssh/latitude_test ubuntu@185.209.178.175

# Run tenant commands inside birth
sudo podman exec feather-birth tenant.sh add <username>
sudo podman exec feather-birth tenant.sh remove <username>
sudo podman exec feather-birth tenant.sh list
```

### Add a user
```bash
sudo podman exec feather-birth tenant.sh add alice
# Output: https://alice.users.inceptel.ai | password: x7k9m2
```

### Remove a user
```bash
sudo podman exec feather-birth tenant.sh remove alice
# Container stopped, Caddy route removed
# Volume preserved (feather-user-alice) for data recovery
```

### List all users
```bash
sudo podman exec feather-birth tenant.sh list
# USERNAME        PORT   URL                                 CONTAINER
# alice           9001   https://alice.users.inceptel.ai     feather-user-alice (running)
```

## DNS

Wildcard DNS is configured via Dynadot API:
```
*.users.inceptel.ai → 185.209.178.175 (A record, TTL 300)
```

Any subdomain under `users.inceptel.ai` resolves to the NYC server. Caddy inside the birth container routes each subdomain to the correct user container.

## How migration works

The migration from one server to another (or from a standalone instance to multi-tenant) follows this pattern:

### 1. The birth container
The birth container is the orchestrator. It runs:
- **Caddy** for TLS and routing
- **Podman** for container management
- **tenant.sh** for user lifecycle

It's built from `/home/user/feather/birth/Containerfile` and started with host networking:
```bash
sudo podman run -d --name feather-birth \
    --privileged --network=host \
    -v /home/user:/home/user:Z \
    -v podman-storage:/var/lib/containers:Z \
    -e ANTHROPIC_API_KEY=... \
    -e OPENAI_API_KEY=... \
    -e FEATHER_ANTHROPIC_API_KEY=... \
    -e FEATHER_OPENAI_API_KEY=... \
    localhost/feather-birth:latest
```

### 2. Building the work image
The work image is what each user actually runs. It's built from the main `/home/user/feather/Containerfile`:
```bash
# On the target server, or build locally and transfer:
podman build -t feather-work /opt/feather-src
# Or load from a tar:
podman load -i feather-work.tar
```

The work image must be available inside the birth container's podman storage. The birth container's entrypoint handles loading it from `/opt/feather-work.tar` if mounted.

### 3. Migrating a sister container

To set up a second birth container on a different server:

```bash
# 1. On the NEW server, install podman
apt-get update && apt-get install -y podman

# 2. Clone the feather repo
git clone https://github.com/inceptel/feather.git /opt/feather-src

# 3. Build both images
podman build -t feather-birth -f /opt/feather-src/birth/Containerfile /opt/feather-src/birth/
podman build -t feather-work /opt/feather-src/

# 4. Save the work image for the birth container to load
podman save -o /opt/feather-work.tar feather-work

# 5. Start the birth container
podman run -d --name feather-birth \
    --privileged --network=host \
    -v /home/user:/home/user:Z \
    -v podman-storage:/var/lib/containers:Z \
    -v /opt/feather-work.tar:/opt/feather-work.tar:ro \
    -e ANTHROPIC_API_KEY="your-key" \
    -e OPENAI_API_KEY="your-key" \
    -e FEATHER_ANTHROPIC_API_KEY="your-key" \
    -e FEATHER_OPENAI_API_KEY="your-key" \
    feather-birth

# 6. Copy tenant.sh into the birth container
podman cp /opt/feather-src/birth/tenant.sh feather-birth:/usr/local/bin/tenant.sh
podman exec feather-birth chmod +x /usr/local/bin/tenant.sh

# 7. Set up DNS (wildcard A record for your subdomain → new server IP)

# 8. Provision users
podman exec feather-birth tenant.sh add alice
```

### 4. Migrating user data between servers

To move a user's data from one server to another:

```bash
# On the OLD server — export the volume
podman volume export feather-user-alice > /tmp/alice-data.tar

# Transfer to new server
scp /tmp/alice-data.tar newserver:/tmp/

# On the NEW server — create volume and import
podman volume create feather-user-alice
podman volume import feather-user-alice /tmp/alice-data.tar

# Provision the user (will use the existing volume)
podman exec feather-birth tenant.sh add alice
```

## File locations

| File | Purpose |
|------|---------|
| `birth/Containerfile` | Birth container image definition |
| `birth/entrypoint.sh` | Birth startup: Caddy + Podman + watchdog |
| `birth/caddy.json` | Base Caddy config (modified at runtime) |
| `birth/swap.sh` | Blue-green deploy for the admin work container |
| `birth/tenant.sh` | Multi-tenant user management |
| `birth/waitlist.py` | Email signup endpoint |
| `/tmp/tenants.json` | Runtime tenant state (inside birth container) |
| `/tmp/waitlist.txt` | Collected signup emails (inside birth container) |

## Port map

| Port | Service |
|------|---------|
| 80 | Caddy (HTTP, subdomain routing) |
| 443 | Caddy (HTTPS, when DOMAIN is set) |
| 2020 | Caddy admin API (localhost only) |
| 8080 | Admin work container (feather-work-blue) |
| 8081 | Standby work container (feather-work-green, during swaps) |
| 9001-9010 | User containers |
| 9099 | Waitlist signup server |
