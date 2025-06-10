ARG BUILD_FROM
FROM node:20-alpine AS build-baileys

# we need git to fetch any git‐hosted deps
RUN apk add --no-cache git

WORKDIR /Baileys

# 1) download the latest baileys tarball
# 2) unpack into /Baileys
# 3) remove devDependencies so npm doesn’t even look at ts-jest, etc.
# 4) install only runtime deps AND ignore all lifecycle scripts
# 5) cleanup
RUN npm pack baileys@latest \
 && tar -xzf baileys-*.tgz --strip-components=1 \
 && sed -i '/"devDependencies": {/,/}/d' package.json \
 && npm install --production --ignore-scripts \
 && rm baileys-*.tgz

 # ─── Stage 2: your HA addon base ──────────────────────────────────────────────
 
 FROM ${BUILD_FROM}

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
