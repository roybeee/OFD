# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
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
USER ofd
CMD ["node", "apps/worker/dist/main.js"]
