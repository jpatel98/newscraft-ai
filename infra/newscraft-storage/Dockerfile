FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY server.mjs ./server.mjs

RUN addgroup -S newscraft && adduser -S -G newscraft newscraft \
  && chown newscraft:newscraft /app/server.mjs \
  && chmod 0444 /app/server.mjs \
  && mkdir -p /srv/newscraft-storage \
  && chown -R newscraft:newscraft /srv/newscraft-storage

USER newscraft
EXPOSE 9100
CMD ["node", "server.mjs"]
