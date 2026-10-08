# Filarr Gate — image Docker (utilisateur non root, sonde de santé sur /health).
#
#   docker build -t filarr-gate .
#   docker run -d --name filarr-gate \
#     -e FILARR_GATE_TOKEN=flr_live_… \
#     -p 8443:8443 -p 127.0.0.1:8787:8787 \
#     -v filarr-gate:/var/lib/filarr-gate \
#     filarr-gate
#
# L'interface de gestion (8787) se publie sur 127.0.0.1 de l'hôte : qui y entre lit
# les données en clair. Sa première mise en route demande le code affiché par
# `docker logs filarr-gate`.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vitest.config.ts ./
COPY scripts ./scripts
COPY src ./src
COPY ui ./ui
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production \
    FILARR_GATE_STATE_DIR=/var/lib/filarr-gate \
    FILARR_GATE_HOST=0.0.0.0 \
    FILARR_GATE_ADMIN_HOST=0.0.0.0
WORKDIR /app
RUN mkdir -p /var/lib/filarr-gate && chown node:node /var/lib/filarr-gate
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node LICENSE NOTICE README.md ./
USER node
VOLUME ["/var/lib/filarr-gate"]
EXPOSE 8443 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "dist/cli.js", "health"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
