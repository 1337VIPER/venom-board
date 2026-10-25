# The Venom Board server, with the app it serves at /app. Build it from the repository's root folder:
#   docker build -f server/Dockerfile -t venom-board-server .
# or use docker-compose.yml in this folder, which adds automatic HTTPS.

# better-sqlite3 normally downloads a ready-made build; these tools are only there in case it has to compile one
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /venom-board/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
WORKDIR /venom-board
# the app (one HTML file), its icon and the picture link previews use, then the server
COPY index.html LICENSE ./
COPY assets/ assets/
COPY docs/banner.png docs/banner.png
COPY --from=deps /venom-board/server/node_modules server/node_modules
COPY server/ server/
RUN rm -f server/.env && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/session').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/src/index.js"]
