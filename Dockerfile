# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
COPY scripts/check-runtime.mjs ./scripts/check-runtime.mjs
RUN npm ci

FROM dependencies AS builder
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production HOST=0.0.0.0 HOSTNAME=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/events.db
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# Runtime entrypoint validates before binding; schema imports this pure JS package.
COPY --from=builder --chown=node:node /app/node_modules/zod ./node_modules/zod
COPY --from=builder --chown=node:node /app/scripts/check-runtime.mjs /app/scripts/container-entrypoint.ts ./scripts/
COPY --from=builder --chown=node:node /app/src/server/config/schema.ts ./src/server/config/schema.ts
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "scripts/container-entrypoint.ts"]
