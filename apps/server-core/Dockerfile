# FlowMic server-core — self-host image (standalone mode by default).
#
# R1 exit criterion #2: `docker compose up` self-host path. AUTHORED on the
# 2026-07-23 dev box which has NO docker installed — build verification is
# OWNER-ENV blocked; verify on any docker host with:
#   docker compose up --build
#   node apps/server-core/scripts/smoke-golden-path.mjs   (against :41879)
#
# The tsup bundle inlines @flowmic/protocol + zod and externalizes only
# socket.io, so the runtime stage installs exactly that one package instead of
# copying the pnpm virtual store. sherpa-local (optional native engine) is NOT
# installed in the image by default — self-hosters wanting the built-in local
# engine add `RUN npm install sherpa-onnx-node@1.13.4` (linux-x64 prebuilt) or
# route STT to LAN/cloud engines via settings.

FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server-core/package.json apps/server-core/
RUN pnpm install --frozen-lockfile --filter "@flowmic/server-core..."
COPY packages/protocol packages/protocol
COPY apps/server-core apps/server-core
RUN pnpm -F @flowmic/protocol build && pnpm -F @flowmic/server-core build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    FLOWMIC_MODE=standalone \
    FLOWMIC_PORT=41879 \
    FLOWMIC_DB_PATH=/data/flowmic.db \
    FLOWMIC_HOME=/data
WORKDIR /app
COPY --from=build /repo/apps/server-core/dist/index.js ./index.js
RUN npm init -y >/dev/null && npm install --omit=dev socket.io@4.8.1 \
    && npm cache clean --force
VOLUME /data
EXPOSE 41879
CMD ["node", "index.js"]
