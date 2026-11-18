# anki-glasses server and web app in one image.
#
# The server has no runtime npm dependencies (only node: built-ins), so the
# final stage carries the build output and package.json, nothing from
# node_modules. Works with docker and podman.

FROM docker.io/library/node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM docker.io/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    ANKI_GLASSES_CONFIG=/config/anki-glasses.config.json
# package.json anchors the path to dist/app (see packageRoot in src/server/index.ts).
COPY --from=build /src/package.json ./
COPY --from=build /src/dist ./dist
USER node
EXPOSE 8710
CMD ["node", "dist/server/server/index.js"]
