# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY infra/scripts ./infra/scripts
COPY tsconfig.base.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
RUN npm run build -w @ofd/domain \
    && npm run build -w @ofd/db \
    && npm run build -w @ofd/integrations \
    && npm run build -w @ofd/worker
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production APP_MODE=production
WORKDIR /app
RUN addgroup -S ofd && adduser -S -G ofd ofd
COPY --from=build --chown=ofd:ofd /app/package.json /app/package-lock.json ./
COPY --from=build --chown=ofd:ofd /app/node_modules ./node_modules
COPY --from=build --chown=ofd:ofd /app/apps/worker ./apps/worker
COPY --from=build --chown=ofd:ofd /app/packages ./packages
COPY --from=build --chown=ofd:ofd /app/infra/scripts ./infra/scripts
USER ofd
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD ["node", "-e", "try{process.kill(1,0)}catch{process.exit(1)}"]
STOPSIGNAL SIGTERM
CMD ["node", "apps/worker/dist/main.js"]
