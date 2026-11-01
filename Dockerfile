# syntax=docker/dockerfile:1
#
# Development image with Node.js, pnpm and the dependencies. compose.yaml bind-mounts the source
# over /app, so rebuild only when the toolchain changes.

ARG NODE_VERSION=26.12.1
FROM node:${NODE_VERSION}-trixie-slim

ARG PNPM_VERSION=11.13.1
# git for tooling inside the dev container; ca-certificates for outbound HTTPS (npm, webhooks).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@${PNPM_VERSION} \
  && mkdir -p /app /pnpm/store \
  && chown -R node:node /app /pnpm

ENV NODE_ENV=development
USER node
WORKDIR /app

# Dependencies first, so source edits don't invalidate this layer.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=ecom-pnpm-store,target=/pnpm/store,uid=1000,gid=1000 \
  pnpm install --frozen-lockfile --store-dir /pnpm/store

COPY --chown=node:node . .

EXPOSE 4000
# Run through sh: the bind-mounted script may lack its executable bit on some hosts.
ENTRYPOINT ["sh", "/app/docker/entrypoint.sh"]
CMD ["pnpm", "dev"]
