FROM ghcr.io/hassio-addons/base:21.0.1 AS dependencies

RUN apk add --no-cache git nodejs npm

COPY package.json package-lock.json /

RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM ghcr.io/hassio-addons/base:21.0.1

ARG BUILD_ARCH
ARG BUILD_VERSION

LABEL \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="app" \
    io.hass.version="${BUILD_VERSION}"

ENV NODE_ENV=production

RUN apk add --no-cache nodejs

COPY --from=dependencies /node_modules /node_modules
COPY package.json package-lock.json /
COPY api.js index.js libsignal-log-filter.js message-dedupe.js runtime.js \
    validation.js webui.js whatsapp.js /
COPY logo.png /
COPY run.sh /

RUN chmod a+x /run.sh

EXPOSE 3000 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["curl", "--fail", "--silent", "--output", "/dev/null", \
    "http://127.0.0.1:3000/health"]
CMD ["/run.sh"]
