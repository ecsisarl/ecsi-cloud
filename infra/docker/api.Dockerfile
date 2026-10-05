# syntax=docker/dockerfile:1.7
# Images de l'API ECSI CLOUD (serveur HTTP, migrations, worker de supervision) et de l'agent
# passerelle WireGuard. Construction depuis la racine du dépôt :
#   docker build -f infra/docker/api.Dockerfile .                   (API, cible par défaut)
#   docker build -f infra/docker/api.Dockerfile --target gateway .  (agent passerelle)

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

# 3. Base d'exécution minimale commune, utilisateur non root.
FROM node:22-alpine AS app
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S ecsi && adduser -S ecsi -G ecsi
COPY --from=builder --chown=ecsi:ecsi /prod/api ./

# 4. Agent passerelle WireGuard (Sprint 3B) : docker build --target gateway.
# wg(8) reçoit la seule capacité CAP_NET_ADMIN (capacité de fichier) : l'agent tourne en
# utilisateur non root et seul `wg set` peut modifier les pairs. Le conteneur doit tourner dans
# l'espace réseau de l'hôte (interface WireGuard) avec `cap_add: NET_ADMIN` ; sans cette
# capacité dans son ensemble limitant, wg échoue (aucune élévation possible au-delà).
FROM app AS gateway
USER root
RUN apk add --no-cache wireguard-tools-wg libcap \
  && setcap cap_net_admin+ep /usr/bin/wg \
  && apk del libcap
USER ecsi
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/healthcheck.js", "gateway"]
CMD ["node", "dist/gateway.js"]

# 5. API (cible par défaut) ; le worker de supervision utilise la même image avec son propre
# healthcheck (docker-compose.yml).
FROM app AS runtime
USER ecsi
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/api/v1/health/live >/dev/null || exit 1
CMD ["node", "dist/main.js"]
