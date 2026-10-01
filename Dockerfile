FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY services/parancu-api/package.json services/parancu-api/package-lock.json ./services/parancu-api/
# CPU binaries are bundled; skip the optional CUDA download.
RUN npm ci --include=dev \
    && ONNXRUNTIME_NODE_INSTALL=skip npm ci --prefix services/parancu-api --omit=dev

# tsx executes npm start and esbuild generates browser assets at runtime.
# Promote them only in this stage's manifest, then prune development-only tools.
RUN node -e 'const fs = require("node:fs"); const p = require("./package.json"); for (const name of ["tsx", "esbuild"]) p.dependencies[name] = p.devDependencies[name]; delete p.devDependencies; fs.writeFileSync("package.json", JSON.stringify(p));' \
    && npm prune --omit=dev --offline --ignore-scripts

# ONNX ships binaries for multiple platforms. Keep the build target's CPU runtime.
RUN node -e 'const fs = require("node:fs"); const path = require("node:path"); const root = "services/parancu-api/node_modules/onnxruntime-node/bin/napi-v6"; fs.accessSync(path.join(root, process.platform, process.arch, "onnxruntime_binding.node")); for (const platform of fs.readdirSync(root)) { const dir = path.join(root, platform); if (platform !== process.platform) fs.rmSync(dir, { recursive: true }); else for (const arch of fs.readdirSync(dir)) if (arch !== process.arch) fs.rmSync(path.join(dir, arch), { recursive: true }); }'

FROM node:22-bookworm-slim AS runtime

# Native ONNX Runtime CPU dependency; model assets come only from the build context.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY services/parancu-api/package.json services/parancu-api/package-lock.json ./services/parancu-api/
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/services/parancu-api/node_modules ./services/parancu-api/node_modules

COPY tsconfig.json ./
COPY src/ ./src/
COPY apps/web/ ./apps/web/
COPY services/parancu-api/src/ ./services/parancu-api/src/
COPY services/parancu-api/assets/e5-manifest.json ./services/parancu-api/assets/
COPY services/parancu-api/assets/models/e5/ ./services/parancu-api/assets/models/e5/

USER node
CMD ["npm", "start"]
