# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_API_BASE=/api/v2
ARG VITE_DEMO_MODE=false
ENV VITE_API_BASE=${VITE_API_BASE}
ENV VITE_DEMO_MODE=${VITE_DEMO_MODE}

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
RUN npm run build -w @ofd/web

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
ENV API_UPSTREAM_HOSTPORT=api:4100
COPY --chown=nginx:nginx infra/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chown=nginx:nginx --from=build /app/apps/web/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -q -O - http://127.0.0.1:8080/healthz >/dev/null || exit 1
STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
