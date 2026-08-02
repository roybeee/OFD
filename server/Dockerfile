FROM node:22-alpine
WORKDIR /srv/ofd
COPY server.js package.json ./
COPY public ./public
COPY data ./data
ENV PORT=8787 DB_PATH=/data/ofd.db SECURE_COOKIES=1
VOLUME /data
EXPOSE 8787
CMD ["node","--no-warnings","server.js"]
