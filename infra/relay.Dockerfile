# syntax=docker/dockerfile:1.7
# A personal CodeBridge relay: one process, embedded database, data in /data.
#   docker run -p 8080:8080 -v relay-data:/data -e PUBLIC_URL=https://relay.example.com <image>
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter codebridge-relay... --ignore-scripts
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @codebridge/protocol --filter @codebridge/shared build \
 && pnpm --filter codebridge-relay bundle
RUN pnpm --filter codebridge-relay deploy --prod --legacy /out \
 && mkdir -p /out/dist && cp apps/api/dist/relay.js /out/dist/ && cp -r apps/api/migrations /out/migrations

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data RELAY_MODE=personal PORT=8080 LOG_LEVEL=warn
WORKDIR /app
COPY --from=build /out .
RUN mkdir -p /data && chown node:node /data
COPY infra/relay-entrypoint.sh /usr/local/bin/relay-entrypoint
RUN chmod 755 /usr/local/bin/relay-entrypoint
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["relay-entrypoint"]
CMD ["node", "dist/relay.js", "start"]
