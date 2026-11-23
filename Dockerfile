# Stage 1: Builder — compila dependências nativas (better-sqlite3) de forma reproduzível
FROM node:22.14-alpine3.21 AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: Runtime mínimo e não-root (sem python3/make/g++)
FROM node:22.14-alpine3.21 AS runtime

LABEL org.opencontainers.image.title="DeepEvil (Perplexity Local)" \
      org.opencontainers.image.description="Worldwide Research & Local AI Answer Engine hardened runtime" \
      org.opencontainers.image.version="1.3.0" \
      org.opencontainers.image.authors="Erik Tonon"

WORKDIR /app

RUN mkdir -p /app/data && chown -R node:node /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node .env.example ./.env.example

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV OLLAMA_MODEL=eriktonon/deepseek-v4.1-flash-1017:9b

EXPOSE 3000

USER node

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "src/server.js"]
