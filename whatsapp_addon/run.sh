#!/usr/bin/with-contenv bashio
set +u

sed -i "s/{{HOSTNAME}}/$HOSTNAME/g" custom_component/whatsapp.py

mkdir -p config/custom_components/whatsapp
cp --recursive /custom_component/* config/custom_components/whatsapp/
bashio::log.info "Installed custom component."

# log the installed Baileys version
BAILEYS_VER=$(node -e "console.log(require('baileys/package.json').version)")
bashio::log.info "Baileys version: $BAILEYS_VER"

node index
