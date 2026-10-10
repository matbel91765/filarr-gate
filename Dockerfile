# Filarr Gate — image Docker (utilisateur non root, état dans /data, sonde de santé sur /health).
#
#   docker build -t filarr-gate .
#   docker run -d --name filarr-gate \
#     -e FILARR_GATE_TOKEN=flr_live_… \
#     -p 8443:8443 -v filarr-gate:/data \
#     filarr-gate
#   docker exec filarr-gate filarr-gate keys create --name ERP      # une clé, montrée une fois
#
# Le volume /data garde l'état (clés, webhooks, réglages), le cache CHIFFRÉ des blocs,
# le journal et les ombres chiffrées des synchros : sans lui, tout repart de zéro.
# L'interface de gestion (8787) n'est publiée que si vous l'ajoutez, sur 127.0.0.1 de
# l'hôte (`-p 127.0.0.1:8787:8787`) : qui y entre lit les données en clair.

# Image de base figée par son empreinte (index multi-architecture de node:22-alpine, Node 22.23.3, 2026-09-23) :
# la même base à chaque construction. Pour la mettre à jour :
#   docker buildx imagetools inspect node:22-alpine     → recopier le « Digest » de l'index (sha256:…) ci-dessous.
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/gate/package.json packages/gate/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/cloudflare/package.json packages/cloudflare/
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY packages ./packages
RUN npm run build -w filarr-gate && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Filarr Gate" \
      org.opencontainers.image.description="Serve a Filarr database as an API, without Filarr ever seeing your data." \
      org.opencontainers.image.source="https://github.com/filarr-work/filarr-gate" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    FILARR_GATE_STATE_DIR=/data \
    FILARR_GATE_HOST=0.0.0.0 \
    FILARR_GATE_ADMIN_HOST=0.0.0.0
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/packages/cli/package.json ./package.json
COPY --from=build --chown=node:node /src/packages/cli/dist ./dist
COPY --chown=node:node LICENSE NOTICE README.md ./
RUN chmod 755 /app/dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/filarr-gate
USER node
VOLUME ["/data"]
EXPOSE 8443 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["filarr-gate", "health"]
ENTRYPOINT ["filarr-gate"]
CMD ["serve"]
