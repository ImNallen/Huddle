FROM node:24-bookworm-slim AS build
RUN npm install --global pnpm@11.23.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/server apps/server
COPY apps/desktop/package.json apps/desktop/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @huddle/server build

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
WORKDIR /app/apps/server
EXPOSE 3000 3001
CMD ["node", "--import", "tsx", "runtime/production.ts"]
