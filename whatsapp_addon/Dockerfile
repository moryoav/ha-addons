ARG BUILD_FROM
FROM $BUILD_FROM

# RUN apk add --no-cache git npm
# allow edge/community and install nodejs-current (v20+) + npm + git
RUN echo "http://dl-cdn.alpinelinux.org/alpine/edge/community" \
     >> /etc/apk/repositories \
 && apk update \
 && apk add --no-cache nodejs-current npm git

COPY . /
RUN chmod a+x /run.sh
RUN chmod a+x /finish.sh

RUN cd /Baileys && npm i -f && cd .. && npm install -f

EXPOSE 3000
CMD [ "/run.sh" ]