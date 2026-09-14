# syntax=docker/dockerfile:1
# CarbBook server + web PWA. Built on the Raspberry Pi (arm64) by deploy/deploy.sh.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV CI=true
RUN npm install -g pnpm@10.33.2 && pnpm --version
WORKDIR /app

# ---- web PWA build (needs dev dependencies) ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY server server
COPY web web
COPY testdata testdata
RUN pnpm --dir web run build && test -f web/dist/index.html

# ---- production dependencies for the server (+ @carbbook/core as source) ----
FROM base AS prod
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --prod --filter "@carbbook/server..."
COPY packages/core packages/core
COPY server server

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 \
 && rm -rf /var/lib/apt/lists/* \
 && printf '#!/bin/sh\ncd /app/server && exec node --import tsx src/cli.ts "$@"\n' > /usr/local/bin/carbbook \
 && chmod 755 /usr/local/bin/carbbook \
 && mkdir -p /data /backups && chown node:node /data /backups
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/carbbook.db \
    USDA_DIR=/data/usda \
    WEB_DIR=/app/web/dist
COPY --from=prod /app /app
COPY --from=build /app/web/dist /app/web/dist
WORKDIR /app/server
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/main.ts"]
