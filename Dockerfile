FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm exec playwright install --with-deps chromium
COPY --from=build /app/dist ./dist
COPY fixtures ./fixtures
VOLUME ["/app/data", "/app/artifacts"]
ENV NOVA_DATABASE_PATH=/app/data/nova.sqlite
ENV NOVA_ARTIFACTS_DIR=/app/artifacts
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["mcp", "serve"]
