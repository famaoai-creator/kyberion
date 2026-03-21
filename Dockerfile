# Stage 1: Base Runtime Environment
FROM node:20-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Enable corepack and install pnpm
ENV COREPACK_ENABLE_STRICT=0
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Stage 2: Build & Dependency Consolidation
FROM base AS builder
# Copy workspace configuration and lockfile
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy everything (Respecting .dockerignore)
COPY . .

# Synchronize lockfile for Linux environment and install all dependencies
RUN pnpm install --frozen-lockfile

# Validate runtime/package hygiene before producing artifacts
RUN pnpm run validate

# Build runtime artifacts
RUN pnpm run build

# Stage 3: Development & Quality Gate
FROM builder AS development
ENV NODE_ENV=development

CMD ["node", "dist/scripts/cli.js", "list", "implemented"]

# Stage 4: Lean Production Image
FROM base AS production
WORKDIR /app
ENV NODE_ENV=production

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/libs ./libs
COPY --from=builder /app/knowledge ./knowledge
COPY --from=builder /app/presence ./presence
COPY --from=builder /app/satellites ./satellites

# Prune dev dependencies
RUN pnpm prune --prod

# Optimized Entrypoint using the unified CLI
ENTRYPOINT ["node", "dist/scripts/cli.js"]
CMD ["list", "implemented"]
