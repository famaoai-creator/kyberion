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

# BUILD ALL SKILLS & LIBS
RUN pnpm run build

# Stage 3: Development & Quality Gate
FROM builder AS development
ENV NODE_ENV=development

# Establish internal links pointing to dist
RUN node dist/scripts/bootstrap.js && \
    find skills -name "core" -type l -path "*/node_modules/@agent/core" -exec rm {} \; && \
    find skills -name "@agent" -type d -path "*/node_modules/@agent" -exec ln -s ../../../../../dist/libs/core {}/core \;

# Setup dummy role config for Governance Audit
RUN mkdir -p knowledge/personal && echo '{"active_role":"Ecosystem Architect","persona":"Mock"}' > knowledge/personal/role-config.json

# Validate ecosystem integrity
RUN pnpm run doctor

# Stage 4: Lean Production Image
FROM base AS production
WORKDIR /app
ENV NODE_ENV=production

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/libs ./libs
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/knowledge ./knowledge

# Prune dev dependencies
RUN pnpm prune --prod

# Establish internal links for runtime (pointing to dist)
RUN node dist/scripts/bootstrap.js && \
    find skills -name "core" -type l -path "*/node_modules/@agent/core" -exec rm {} \; && \
    find skills -name "@agent" -type d -path "*/node_modules/@agent" -exec ln -s ../../../../../dist/libs/core {}/core \;

# Optimized Entrypoint using the unified CLI
ENTRYPOINT ["node", "dist/scripts/cli.js"]
CMD ["list", "implemented"]
