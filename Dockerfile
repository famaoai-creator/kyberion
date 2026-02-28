# Stage 1: Base Runtime Environment
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Enable corepack and install pnpm
ENV COREPACK_ENABLE_STRICT=0
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

# Install system dependencies (e.g. for python skills or native modules)
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

# Copy all package.json files to allow pnpm to resolve the workspace tree
# (Note: We copy everything here because manually listing 136+ skills is fragile)
# We rely on .dockerignore to keep this lean
COPY . .

# Install all dependencies (including dev)
RUN pnpm install --frozen-lockfile

# Stage 3: Development & Quality Gate
FROM builder AS development
ENV NODE_ENV=development
# Establish internal link to @agent/core
RUN node scripts/bootstrap.cjs
# Validate ecosystem integrity
RUN pnpm run doctor

# Stage 4: Lean Production Image
FROM base AS production
WORKDIR /app
ENV NODE_ENV=production

# Copy built artifacts and necessary files
COPY --from=builder /app ./

# Prune dev dependencies to keep the image small
RUN pnpm prune --prod

# Establish internal links for runtime
RUN node scripts/bootstrap.cjs

# Cleanup artifacts not needed for execution
RUN rm -rf tests scripts/templates scratch \
    skills/**/tests skills/**/.tsbuildinfo

# Optimized Entrypoint using the unified CLI
ENTRYPOINT ["node", "scripts/cli.cjs"]
CMD ["list", "implemented"]
