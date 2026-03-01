# Stage 1: Base Runtime Environment
FROM node:23-slim AS base
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
RUN pnpm install --no-frozen-lockfile

# BUILD ALL SKILLS: Essential for 'doctor' to validate entrypoints
RUN pnpm run build

# Stage 3: Development & Quality Gate
FROM builder AS development
ENV NODE_ENV=development
# Establish internal link to @agent/core
RUN node scripts/bootstrap.cjs

# Setup dummy role config for Governance Audit during doctor
RUN mkdir -p knowledge/personal && echo '{"active_role":"Ecosystem Architect","persona":"Mock"}' > knowledge/personal/role-config.json

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
