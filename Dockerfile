# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS pnpm-base

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable \
    && corepack prepare pnpm@11.9.0 --activate

WORKDIR /workspace

FROM pnpm-base AS dependencies

# better-sqlite3 may need to compile when no matching prebuilt binary exists.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN --mount=type=cache,id=clipboard-mate-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @clipboard-mate/api...

FROM dependencies AS build

COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/contracts packages/contracts

RUN pnpm --filter @clipboard-mate/api build \
    && pnpm --filter @clipboard-mate/api --prod deploy /prod/api

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    CLIPBOARD_MATE_HOST=0.0.0.0 \
    CLIPBOARD_MATE_PORT=43120 \
    CLIPBOARD_MATE_DB_PATH=/data/clipboard-mate.sqlite

WORKDIR /app

# The official Node image provides the unprivileged `node` user (UID/GID 1000).
# Owning /data here also gives a newly-created named volume the correct owner.
RUN mkdir --parents /data \
    && chown node:node /data

# Keep application code root-owned; the service user only needs to write /data.
COPY --from=build /prod/api/ ./

USER node

EXPOSE 43120
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:43120/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/server.js"]
