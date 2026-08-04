#!/bin/sh
set -eu

: "${API_UPSTREAM_HOSTPORT:?API_UPSTREAM_HOSTPORT is required}"
: "${PORT:=10000}"

envsubst '${API_UPSTREAM_HOSTPORT} ${PORT}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

exec "$@"
