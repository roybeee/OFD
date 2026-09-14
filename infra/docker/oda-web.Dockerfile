# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_ODA_LOCAL=false
ENV VITE_API_BASE=/api/v2
ENV VITE_ODA_LOCAL=${VITE_ODA_LOCAL}
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
RUN npm run build -w @ofd/domain && npm run build:oda -w @ofd/web

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
ENV API_UPSTREAM_HOSTPORT=api:4100 PORT=10000
ARG NGINX_TEMPLATE=infra/nginx/default.conf.template
COPY --chown=nginx:nginx ${NGINX_TEMPLATE} /etc/nginx/templates/default.conf.template
COPY --chown=nginx:nginx infra/docker/web-entrypoint.sh /usr/local/bin/ofd-web-entrypoint
COPY --chown=nginx:nginx --from=build /app/apps/web/dist /usr/share/nginx/html
USER nginx
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -q -O - http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
ENTRYPOINT ["/bin/sh", "/usr/local/bin/ofd-web-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
