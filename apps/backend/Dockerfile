FROM docker.io/oven/bun:1
WORKDIR /app
ENV NODE_ENV=production

# Every workspace package.json must be present for a workspace-aware install.
COPY package.json bun.lock ./
COPY apps/backend/package.json ./apps/backend/
RUN bun install --frozen-lockfile --production

COPY tsconfig.json tsconfig.base.json ./
COPY config ./config
COPY apps/backend ./apps/backend

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT??3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["bun", "apps/backend/src/main.ts"]
