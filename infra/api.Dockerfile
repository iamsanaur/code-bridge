# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @codebridge/api... --ignore-scripts
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @codebridge/protocol --filter @codebridge/shared build && pnpm --filter @codebridge/api build
RUN pnpm --filter @codebridge/api deploy --prod --legacy /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/migrations ./migrations
USER node
EXPOSE 8080
CMD ["node", "dist/src/server.js"]
