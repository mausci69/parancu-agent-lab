FROM node:22-bookworm-slim

# Native ONNX Runtime CPU dependency; model assets come only from the build context.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY services/parancu-api/package.json services/parancu-api/package-lock.json ./services/parancu-api/
RUN npm ci --include=dev \
    && npm ci --prefix services/parancu-api --omit=dev \
    && npm cache clean --force

COPY tsconfig.json ./
COPY src/ ./src/
COPY apps/web/ ./apps/web/
COPY services/parancu-api/src/ ./services/parancu-api/src/
COPY services/parancu-api/assets/e5-manifest.json ./services/parancu-api/assets/
COPY services/parancu-api/assets/models/e5/ ./services/parancu-api/assets/models/e5/

USER node
CMD ["npm", "start"]
