# Stage 1: Build Feather
FROM docker.io/library/rust:1.83-bookworm AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src/ src/

RUN cargo build --release

# Stage 2: Full workspace
FROM docker.io/library/ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System packages
RUN apt-get update && apt-get install -y \
    curl wget git vim htop tmux \
    python3 python3-pip python3-venv \
    ca-certificates gnupg \
    tre-agrep \
    supervisor \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Caddy (reverse proxy for all services on one port)
RUN curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy \
    && chmod +x /usr/local/bin/caddy

# Node.js 22 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude CLI + Codex CLI + Pi coding agent
RUN npm install -g @anthropic-ai/claude-code @openai/codex @mariozechner/pi-coding-agent

# JupyterLab
RUN pip3 install --break-system-packages jupyterlab

# Create non-root user with sudo (uid 1000 to match typical host user)
RUN userdel -r ubuntu 2>/dev/null || true && \
    useradd -m -s /bin/bash -u 1000 -G sudo user && \
    echo "user ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Copy Feather binary
COPY --from=builder /build/target/release/feather-rs /usr/local/bin/feather

# Copy static files and configs
COPY static/ /opt/feather/static/
COPY container/ /opt/feather/container/

# Install configs
RUN cp /opt/feather/container/supervisord.conf /etc/supervisor/conf.d/supervisord.conf && \
    mkdir -p /etc/caddy && cp /opt/feather/container/Caddyfile /etc/caddy/Caddyfile && \
    cp /opt/feather/container/run-feather.sh /usr/local/bin/run-feather.sh && \
    cp /opt/feather/container/entrypoint.sh /entrypoint.sh && \
    chmod +x /usr/local/bin/run-feather.sh /entrypoint.sh

# Set permissions
RUN mkdir -p /opt/feather/uploads && chown user:user /opt/feather/uploads && \
    chown -R user:user /etc/caddy && \
    mkdir -p /var/log/supervisor && chown -R user:user /var/log/supervisor && \
    mkdir -p /home/user && chown -R user:user /home/user

USER user
WORKDIR /home/user

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
