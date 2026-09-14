# syntax=docker/dockerfile:1
#
# The platform as one container: the API serving the built frontend, as in
# README "Single-process deployment". PostgreSQL runs separately (see
# docker-compose.yml). Judge0 is not included: it needs a privileged host with
# cgroup v1 and belongs on its own VM (QUESTIONS.md, Risk C).

# --- Build the web app -------------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Production server dependencies ------------------------------------------
FROM node:22-bookworm-slim AS server-deps
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# --- Runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=4000 \
    WEB_DIST=/app/web/dist
WORKDIR /app/server

COPY --from=server-deps /build/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY server/seed ./seed
COPY server/scripts ./scripts
COPY --from=web /build/web/dist /app/web/dist

# Migrations run on start-up; the process never needs to write to its own files.
USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
