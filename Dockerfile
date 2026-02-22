# Stage 1: Build
FROM docker.io/library/rust:1.83-bookworm AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src/ src/

RUN cargo build --release

# Stage 2: Runtime
FROM docker.io/library/debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash user
USER user
WORKDIR /home/user

# Copy binary and static files
COPY --from=builder /build/target/release/feather-rs /usr/local/bin/feather
COPY static/ /opt/feather/static/

# Session directories
RUN mkdir -p /home/user/.claude/projects \
    /home/user/sessions \
    /home/user/uploads \
    /home/user/memory

WORKDIR /opt/feather

EXPOSE 8080

ENV PORT=8080
ENV FEATHER_UPLOAD_DIR=/home/user/uploads

CMD ["feather"]
