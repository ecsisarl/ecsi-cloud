# syntax=docker/dockerfile:1.7
# Image d'une application Next.js du monorepo (dashboard ou portail), en mode « standalone ».
# Construction depuis la racine du dépôt :
#   docker build -f infra/docker/next.Dockerfile --build-arg APP=web --build-arg PORT=3000 .
#   docker build -f infra/docker/next.Dockerfile --build-arg APP=portal --build-arg PORT=3001 .

ARG APP=web

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS pruner
ARG APP
RUN npm install -g turbo@2.11.7
COPY . .
RUN turbo prune @ecsi/${APP} --docker

FROM base AS builder
ARG APP
COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
# Configuration TypeScript commune (non incluse par « turbo prune »).
COPY tsconfig.base.json ./
RUN pnpm turbo run build --filter=@ecsi/${APP}

FROM node:22-alpine AS runtime
ARG APP
ARG PORT=3000
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=${PORT} APP=${APP}
WORKDIR /app
RUN addgroup -S ecsi && adduser -S ecsi -G ecsi
COPY --from=builder --chown=ecsi:ecsi /repo/apps/${APP}/.next/standalone ./
COPY --from=builder --chown=ecsi:ecsi /repo/apps/${APP}/.next/static ./apps/${APP}/.next/static
USER ecsi
EXPOSE ${PORT}
CMD ["sh", "-c", "exec node apps/${APP}/server.js"]
