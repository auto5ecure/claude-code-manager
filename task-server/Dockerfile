# syntax=docker/dockerfile:1.7

# Build stage — uses official Playwright image so the production stage and the
# build stage share the same Node version + system deps. Keeps everything aligned.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# Runtime stage — Playwright base image already ships:
#   - Node 20.x
#   - Chromium, Firefox, WebKit at /ms-playwright/
#   - All system libs the browsers need
FROM mcr.microsoft.com/playwright:v1.60.0-jammy AS runtime
WORKDIR /app
# Extra tools task scripts commonly want.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates curl jq python3 python3-requests bash \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --omit=optional && npm cache clean --force
COPY --from=builder /app/dist ./dist

RUN mkdir -p /data/logs && \
    # The playwright image already has a `node` user (uid 1000). Keep using it.
    chown -R node:node /data /app
USER node
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=4243 \
    HOST=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 4243
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
