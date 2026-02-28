# Stage 1: Base Runtime Environment
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Install pnpm
RUN npm install -g pnpm

# Install system dependencies (e.g. for python skills or native modules)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Stage 2: Build & Dependency Consolidation
FROM base AS builder
# Copy root package config and pnpm files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# Copy core library definition (needed for workspace linking)
COPY libs/core/package.json ./libs/core/
# Copy all skill package definitions (needed for workspace linking)
# We copy everything first to ensure workspaces resolve, relying on .dockerignore
COPY . .

# Install all dependencies including dev (for building TS)
RUN pnpm install

# Stage 3: Development & Quality Gate
FROM builder AS development
ENV NODE_ENV=development
# Bootstrap links @agent/core to libs/core
RUN node scripts/bootstrap.cjs
# Validate ecosystem integrity
RUN pnpm run doctor

# Stage 4: Lean Production Image
FROM base AS production
ENV NODE_ENV=production

# Copy all files
COPY . .

# Re-install only production deps
RUN pnpm install --prod

# Establish internal links
RUN node scripts/bootstrap.cjs

# Cleanup source artifacts not needed for runtime
RUN rm -rf tests scripts/templates scratch active/missions/* \
    skills/**/tests skills/**/.tsbuildinfo

# Optimized Entrypoint using the unified CLI
ENTRYPOINT ["node", "scripts/cli.cjs"]
CMD ["list", "implemented"]
