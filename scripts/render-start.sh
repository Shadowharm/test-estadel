#!/bin/sh
# Render start: миграция → seed (идемпотентно) → сервер. Fail fast на любой ошибке.
set -e

node scripts/db.ts migrate
node scripts/db.ts seed
exec node scripts/container-entrypoint.ts
