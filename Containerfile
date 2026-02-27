# Stage 1: Build Feather
FROM docker.io/library/rust:1.83-bookworm AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src/ src/

ARG FEATHER_GIT_COMMIT=dev
RUN FEATHER_GIT_COMMIT=${FEATHER_GIT_COMMIT} cargo build --release

# Stage 2: Full workspace
FROM docker.io/library/ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System packages
RUN apt-get update && apt-get install -y     curl wget git vim htop tmux     python3 python3-pip python3-venv     ca-certificates gnupg     tre-agrep     supervisor     sudo     && rm -rf /var/lib/apt/lists/*

# Caddy (reverse proxy for all services on one port)
RUN curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy     && chmod +x /usr/local/bin/caddy

# Node.js 22 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash -     && apt-get install -y nodejs     && rm -rf /var/lib/apt/lists/*

# Claude CLI + Codex CLI + Pi coding agent
RUN npm install -g @anthropic-ai/claude-code @openai/codex @mariozechner/pi-coding-agent

# JupyterLab
RUN pip3 install --break-system-packages jupyterlab

# ttyd (web terminal)
RUN curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 -o /usr/local/bin/ttyd     && chmod +x /usr/local/bin/ttyd

# File Browser
n# VS Code (code-server)
RUN curl -fsSL https://code-server.dev/install.sh | sh
RUN curl -fsSL https://raw.githubusercontent.com/filebrowser/get/master/get.sh | bash

# Create non-root user with sudo (uid 1000 to match typical host user)
RUN userdel -r ubuntu 2>/dev/null || true &&     useradd -m -s /bin/bash -u 1000 -G sudo user &&     echo "user ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Copy Feather binary (pre-built for instant first boot)
COPY --from=builder /build/target/release/feather-rs /usr/local/bin/feather

# Copy configs
COPY container/ /opt/feather-config/

# Install configs
RUN cp /opt/feather-config/supervisord.conf /etc/supervisor/conf.d/supervisord.conf &&     mkdir -p /etc/caddy && cp /opt/feather-config/Caddyfile /etc/caddy/Caddyfile &&     cp /opt/feather-config/run-feather.sh /usr/local/bin/run-feather.sh &&     cp /opt/feather-config/entrypoint.sh /entrypoint.sh &&     chmod +x /usr/local/bin/run-feather.sh /entrypoint.sh

# Pre-populate /opt/feather with static files (entrypoint will git clone over this on first boot)
COPY static/ /opt/feather/static/

# Set permissions
RUN mkdir -p /opt/feather/uploads &&     chown -R user:user /opt/feather &&     chown -R user:user /etc/caddy &&     mkdir -p /var/log/supervisor && chown -R user:user /var/log/supervisor &&     mkdir -p /home/user && chown -R user:user /home/user

# Rust toolchain for rebuilding from source
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | su user -c 'sh -s -- -y'

USER user
WORKDIR /home/user

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
