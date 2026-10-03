# syntax=docker/dockerfile:1.7
# Image de l'API ECSI CLOUD (serveur HTTP et migrations).
# Construction depuis la racine du dépôt : docker build -f infra/docker/api.Dockerfile .

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# 1. Ne garder que les fichiers nécessaires à @ecsi/api (lockfile élagué).
FROM base AS pruner
RUN npm install -g turbo@2.11.7
COPY . .
RUN turbo prune @ecsi/api --docker

# 2. Installer les dépendances (couche mise en cache tant que les package.json ne changent pas), puis compiler.
FROM base AS builder
COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
# Configuration TypeScript commune (non incluse par « turbo prune »).
COPY tsconfig.base.json ./
RUN pnpm turbo run build --filter=@ecsi/api
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @ecsi/api deploy --prod --legacy /prod/api

# 3. Image d'exécution minimale, utilisateur non root.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S ecsi && adduser -S ecsi -G ecsi
COPY --from=builder --chown=ecsi:ecsi /prod/api ./
USER ecsi
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/api/v1/health/live >/dev/null || exit 1
CMD ["node", "dist/main.js"]
