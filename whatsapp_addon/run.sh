#!/usr/bin/with-contenv bashio
set +u

if [ -f config/custom_components/whatsapp/manifest.json ]; then
  bashio::log.info "Existing WhatsApp custom component found; leaving it in place."
else
  sed -i "s/{{HOSTNAME}}/$HOSTNAME/g" custom_component/whatsapp.py

  mkdir -p config/custom_components/whatsapp
  cp --recursive /custom_component/* config/custom_components/whatsapp/
  mv \
    config/custom_components/whatsapp/manifest.json.template \
    config/custom_components/whatsapp/manifest.json
  bashio::log.info "Installed bundled custom component."
fi

node index
