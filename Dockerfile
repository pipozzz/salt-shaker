# Production image: the Salt Shaker server (Hono on Node) serving the built UI and the API.
FROM node:24-alpine AS build
# toolchain in case better-sqlite3 has no prebuilt binary for this platform
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server
# the server is bundled into one file; only the native SQLite driver stays external
RUN mkdir -p /runtime/node_modules && cp -r node_modules/better-sqlite3 /runtime/node_modules/

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data STATIC_DIR=/app/dist
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist-server/index.js"]
