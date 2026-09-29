# On This Day: a pay-per-request API on Curvy (x402 + human checkout).
FROM node:24-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
