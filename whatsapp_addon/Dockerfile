FROM rust:1.94-alpine AS dependencies
RUN apk add --no-cache git cmake clang llvm-dev musl-dev openssl-dev opus-dev pkgconf python3
WORKDIR /build
ENV CARGO_BUILD_JOBS=1
COPY voice/native/Cargo.toml ./Cargo.toml
COPY voice/native/Cargo.lock ./Cargo.lock
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo fetch --locked

FROM scratch AS lockfile
COPY --from=dependencies /build/Cargo.lock /Cargo.lock

FROM dependencies AS builder
RUN apk add --no-cache build-base
COPY voice/native/Cargo.lock ./Cargo.lock
COPY voice/patches ./patches
RUN python3 patches/apply.py
COPY voice/native/src ./src
RUN --mount=type=cache,target=/build/target,sharing=locked \
    cargo clean --locked --release -p whatsapp-rust \
    && cargo test --locked --release && cargo build --locked --release \
    && cp target/release/whatsapp-call-worker /build/whatsapp-call-worker

FROM ghcr.io/hassio-addons/base:21.0.1 AS node_dependencies
RUN apk add --no-cache git nodejs npm python3 py3-pip
WORKDIR /app/base
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY voice/requirements.txt /tmp/voice-requirements.txt
RUN python3 -m venv /opt/voice \
    && /opt/voice/bin/pip install --no-cache-dir --requirement /tmp/voice-requirements.txt

FROM ghcr.io/hassio-addons/base:21.0.1
ARG BUILD_ARCH
ARG BUILD_VERSION
LABEL io.hass.arch="${BUILD_ARCH}" io.hass.type="app" io.hass.version="${BUILD_VERSION}"
ENV NODE_ENV=production WHATSAPP_BASE_DIR=/app/base
ENV PATH="/opt/voice/bin:${PATH}"
RUN apk add --no-cache nodejs python3 opus libgcc libstdc++
WORKDIR /app/base
COPY --from=node_dependencies /app/base/node_modules ./node_modules
COPY package.json ./
COPY --from=node_dependencies /opt/voice /opt/voice
COPY api-token.js api.js app-state-sync.js call-log.js chat-archive-store.js decryption-diagnostics.js diagnostics.js event-buffer-flush.js index.js \
    contact-snapshot.js libsignal-log-filter.js media-store.js message-dedupe.js message-inbox.js message-retry-cache.js recovery.js runtime.js \
    lid-sender-receipts.js offline-sync.js pairing.js poll-store.js receipts.js timeout.js validation.js webui.js whatsapp.js ./
COPY logo.png ./
COPY webui ./webui
COPY voice /app/voice
COPY --from=builder /build/whatsapp-call-worker /usr/local/bin/whatsapp-call-worker
COPY healthcheck.sh run.sh /
RUN chmod a+x /healthcheck.sh /run.sh
EXPOSE 3000 8099
HEALTHCHECK --interval=30s --timeout=7s --start-period=20s --retries=3 CMD ["/healthcheck.sh"]
CMD ["/run.sh"]
