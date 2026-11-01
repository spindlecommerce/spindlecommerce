#!/bin/sh
# Prepare the development container, then run its command (default: pnpm dev).
set -eu

# node_modules is a named volume that outlives image rebuilds, so sync it with the lockfile.
pnpm install --frozen-lockfile --prefer-offline --store-dir /pnpm/store --config.confirm-modules-purge=false

if [ "${MIGRATE_ON_START:-true}" = "true" ]; then
  pnpm db:migrate
fi

# The seed does nothing once the database has channels.
if [ "${SEED_ON_START:-true}" = "true" ]; then
  pnpm db:seed
fi

exec "$@"
