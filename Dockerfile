# syntax=docker/dockerfile:1

# ---- builder: install deps (with native toolchain) + build the admin UI ----
FROM node:20-bookworm AS builder
WORKDIR /app

# Root (server) dependencies — better-sqlite3 needs a toolchain to compile if no
# prebuilt binary is available for the platform.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Build the React/HeroUI admin UI into web/dist
COPY web/package*.json ./web/
RUN npm --prefix web install --no-audit --no-fund
COPY web ./web
RUN npm --prefix web run build

# App source
COPY src ./src

# ---- runtime: slim image with just what we need ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/src ./src
COPY package*.json ./

# data dir for the SQLite fallback (ignored when DB_DRIVER=mysql)
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8787
CMD ["node", "src/server.js"]
