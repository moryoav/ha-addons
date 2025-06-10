# ─── Stage 1: build Baileys under Node 20 ──────────────────────────────────────
FROM node:20-alpine AS build-baileys
WORKDIR /Baileys

RUN npm pack baileys@latest \
 && tar -xzf baileys-*.tgz --strip-components=1 \
 \
 # remove devDependencies so npm won’t even try to install ts-jest/etc.
 && sed -i '/"devDependencies": {/,/}/d' package.json \
 \
 # now install only the real runtime deps
 && npm install --production \
 \
 # clean up
 && rm baileys-*.tgz

# ─── Stage 2: your HA addon base ──────────────────────────────────────────────
ARG BUILD_FROM
FROM $BUILD_FROM

# install only what you need at runtime
RUN apk add --no-cache git npm

# bring in the built Baileys code
COPY --from=build-baileys /Baileys /Baileys

# copy your addon on top
COPY . /

RUN chmod a+x /run.sh /finish.sh \
 && npm install -f          # installs your other deps

EXPOSE 3000
CMD [ "/run.sh" ]
