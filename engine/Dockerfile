# Engine image. Build context is the repo root: the engine imports ../shared and ../workflow/src.
FROM node:24-slim
WORKDIR /app
COPY engine/package.json engine/package-lock.json engine/
RUN cd engine && npm ci
COPY workflow/package.json workflow/package-lock.json workflow/
RUN cd workflow && npm ci --omit=dev
COPY shared/ shared/
COPY workflow/src/ workflow/src/
COPY engine/src/ engine/src/
COPY engine/tsconfig.json engine/
WORKDIR /app/engine
# ENGINE_ARGS picks the mode, e.g. "--predict-bots 10" or "--predict-only --predict-bots 10".
CMD ["sh", "-c", "exec npx tsx src/server.ts $ENGINE_ARGS"]
