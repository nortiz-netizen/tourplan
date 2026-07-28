#!/usr/bin/env bash
set -e

# Login a Salesforce con la SFDX auth URL (pasada por env SF_AUTH_URL), si viene.
# En Lambda esto se reemplaza por JWT; para probar en EC2/container alcanza la auth URL.
if [ -n "$SF_AUTH_URL" ]; then
  echo "$SF_AUTH_URL" > /tmp/auth.txt
  sf org login sfdx-url --sfdx-url-file /tmp/auth.txt --alias "${SF_ORG:-sayhueque-sb}" --set-default || true
  rm -f /tmp/auth.txt
fi

# Arranca el worker. Los argumentos del `docker run` (ej. --una-vez) pasan tal cual.
exec node src/worker.js "$@"
