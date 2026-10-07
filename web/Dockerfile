# Web image. Build context is the repo root: web imports ../shared, and next.config.mjs reads
# contracts/deployments/<CHAIN>.json at build time for the lighthouse's escrow address.
FROM node:24-slim
WORKDIR /app
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY shared/ shared/
COPY contracts/deployments/ contracts/deployments/
COPY web/ web/
# NEXT_PUBLIC_* are inlined by next build, so they must be present at build time.
ARG NEXT_PUBLIC_ENGINE_WS
ARG NEXT_PUBLIC_ENGINE_HTTP
ARG CHAIN=base-sepolia
ENV NEXT_PUBLIC_ENGINE_WS=$NEXT_PUBLIC_ENGINE_WS \
    NEXT_PUBLIC_ENGINE_HTTP=$NEXT_PUBLIC_ENGINE_HTTP \
    CHAIN=$CHAIN \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/web
RUN npx next build
ENV NODE_ENV=production PORT=3000
CMD ["sh", "-c", "exec npx next start -p ${PORT:-3000} -H 0.0.0.0"]
