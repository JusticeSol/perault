# Perault x402 facilitator. Build from the repo root:
#   docker build -f packages/x402/Dockerfile -t perault-facilitator .
#   docker run --rm -p 4020:4020 --env-file packages/x402/.env perault-facilitator
FROM node:22-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate

# Every workspace manifest (so the frozen lockfile matches), but only the facilitator and its
# dependencies get installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/aevum/package.json packages/aevum/
COPY packages/perault-sdk/package.json packages/perault-sdk/
COPY packages/x402/package.json packages/x402/
COPY web/package.json web/
COPY examples/package.json examples/
RUN pnpm install --frozen-lockfile --filter "@perault/x402..."

COPY packages/perault-sdk/src packages/perault-sdk/src
COPY packages/x402/src packages/x402/src

ENV NODE_ENV=production PORT=4020
EXPOSE 4020
USER node
WORKDIR /app/packages/x402
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4020/health >/dev/null || exit 1
CMD ["node_modules/.bin/tsx", "src/main.ts"]
