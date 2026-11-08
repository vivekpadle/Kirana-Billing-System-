# Pise Kirana — works on any Docker host (Railway, Fly.io, a VPS, ...)
FROM node:22-alpine
RUN apk add --no-cache tzdata
ENV NODE_ENV=production TZ=Asia/Kolkata PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--no-warnings", "server/server.js"]
