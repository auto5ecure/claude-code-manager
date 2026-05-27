# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++ bash
COPY package.json ./
RUN npm install --omit=optional
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache bash tini ca-certificates
COPY package.json ./
RUN npm install --omit=dev --omit=optional && npm cache clean --force
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data/logs && chown -R node:node /data
USER node
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=4243
ENV HOST=0.0.0.0
EXPOSE 4243
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
