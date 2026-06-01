ARG BUILD_FROM
FROM node:20-alpine AS build-baileys

RUN apk add --no-cache git
WORKDIR /Baileys

RUN npm pack @whiskeysockets/baileys@6.7.23 \
 && tar -xzf whiskeysockets-baileys-*.tgz --strip-components=1 \
 && sed -i '/"devDependencies": {/,/}/d' package.json \
 && npm install --production --ignore-scripts \
 && rm whiskeysockets-baileys-*.tgz

FROM ${BUILD_FROM}

RUN apk add --no-cache git npm

COPY . /
COPY --from=build-baileys /Baileys /Baileys

RUN chmod a+x /run.sh /finish.sh \
 && npm install -f

EXPOSE 3000 8099
CMD [ "/run.sh" ]
