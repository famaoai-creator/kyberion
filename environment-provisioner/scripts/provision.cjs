#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
/**
 * environment-provisioner: Generates Infrastructure as Code from a service
 * definition file. Supports Terraform, Docker, and Kubernetes output formats
 * for AWS, Azure, and GCP providers.
 *
 * Usage:
 *   node provision.cjs --input <services.yaml|services.json> --provider aws --format terraform
 *
 * Input format (YAML or JSON):
 *   services:
 *     - name: web-api
 *       type: compute
 *       size: medium
 *       port: 3000
 *       replicas: 2
 *     - name: main-db
 *       type: database
 *       engine: postgres
 *       size: large
 *     - name: assets
 *       type: storage
 *       size: medium
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to a YAML or JSON service definition file',
  })
  .option('provider', {
    alias: 'p',
    type: 'string',
    default: 'aws',
    description: 'Cloud provider (aws, azure, gcp)',
  })
  .option('format', {
    alias: 'f',
    type: 'string',
    default: 'terraform',
    description: 'Output format (terraform, docker, k8s)',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path for the report',
  })
  .check((parsed) => {
    const validProviders = ['aws', 'azure', 'gcp'];
    if (!validProviders.includes(parsed.provider.toLowerCase())) {
      throw new Error(
        `Invalid provider "${parsed.provider}". Must be one of: ${validProviders.join(', ')}`
      );
    }
    const validFormats = ['terraform', 'docker', 'k8s'];
    if (!validFormats.includes(parsed.format.toLowerCase())) {
      throw new Error(
        `Invalid format "${parsed.format}". Must be one of: ${validFormats.join(', ')}`
      );
    }
    return true;
  })
  .help().argv;

// --- Resource mappings per provider ---
const PROVIDER_RESOURCES = {
  aws: {
    compute: { resource: 'aws_instance', ami: 'ami-0c55b159cbfafe1f0' },
    database: {
      resource: 'aws_db_instance',
      engines: { postgres: 'postgres', mysql: 'mysql', mariadb: 'mariadb' },
    },
    storage: { resource: 'aws_s3_bucket' },
    cache: { resource: 'aws_elasticache_cluster' },
    queue: { resource: 'aws_sqs_queue' },
    loadbalancer: { resource: 'aws_lb' },
  },
  azure: {
    compute: { resource: 'azurerm_linux_virtual_machine' },
    database: {
      resource: 'azurerm_postgresql_flexible_server',
      engines: { postgres: 'postgres', mysql: 'mysql' },
    },
    storage: { resource: 'azurerm_storage_account' },
    cache: { resource: 'azurerm_redis_cache' },
    queue: { resource: 'azurerm_servicebus_queue' },
    loadbalancer: { resource: 'azurerm_lb' },
  },
  gcp: {
    compute: { resource: 'google_compute_instance' },
    database: {
      resource: 'google_sql_database_instance',
      engines: { postgres: 'POSTGRES', mysql: 'MYSQL' },
    },
    storage: { resource: 'google_storage_bucket' },
    cache: { resource: 'google_redis_instance' },
    queue: { resource: 'google_pubsub_topic' },
    loadbalancer: { resource: 'google_compute_forwarding_rule' },
  },
};

const SIZE_MAP = {
  aws: { small: 't3.small', medium: 't3.medium', large: 't3.large', xlarge: 't3.xlarge' },
  azure: {
    small: 'Standard_B1s',
    medium: 'Standard_B2s',
    large: 'Standard_D2s_v3',
    xlarge: 'Standard_D4s_v3',
  },
  gcp: { small: 'e2-small', medium: 'e2-medium', large: 'e2-standard-2', xlarge: 'e2-standard-4' },
};

const DB_SIZE_MAP = {
  aws: {
    small: 'db.t3.small',
    medium: 'db.t3.medium',
    large: 'db.r5.large',
    xlarge: 'db.r5.xlarge',
  },
  azure: {
    small: 'B_Standard_B1ms',
    medium: 'GP_Standard_D2s_v3',
    large: 'GP_Standard_D4s_v3',
    xlarge: 'GP_Standard_D8s_v3',
  },
  gcp: {
    small: 'db-f1-micro',
    medium: 'db-custom-2-7680',
    large: 'db-custom-4-15360',
    xlarge: 'db-custom-8-30720',
  },
};

/**
 * Parse a config file (YAML or JSON).
 * @param {string} filePath
 * @returns {Object}
 */
function parseConfig(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.json') {
    try {
      return JSON.parse(content);
    } catch (err) {
      throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
    }
  }

  try {
    return yaml.load(content);
  } catch (err) {
    throw new Error(`Invalid YAML in ${filePath}: ${err.message}`);
  }
}

/**
 * Sanitize a service name for use in resource identifiers.
 * @param {string} name
 * @returns {string}
 */
function sanitizeName(name) {
  return (name || 'service').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

// --- Terraform generators ---

/**
 * Generate Terraform HCL for a compute service.
 * @param {Object} svc
 * @param {string} provider
 * @returns {string}
 */
function terraformCompute(svc, provider) {
  const name = sanitizeName(svc.name);
  const size = (svc.size || 'medium').toLowerCase();
  const instanceType = SIZE_MAP[provider][size] || SIZE_MAP[provider].medium;
  const res = PROVIDER_RESOURCES[provider].compute;

  if (provider === 'aws') {
    return `resource "${res.resource}" "${name}" {
  ami           = "${res.ami}"
  instance_type = "${instanceType}"

  tags = {
    Name        = "${svc.name}"
    Environment = "production"
    ManagedBy   = "terraform"
  }

  # Security best practice: use a dedicated security group
  vpc_security_group_ids = [aws_security_group.${name}_sg.id]

  # Health check via user_data
  user_data = <<-EOF
    #!/bin/bash
    echo "Health check endpoint active"
  EOF
}

resource "aws_security_group" "${name}_sg" {
  name        = "${name}-sg"
  description = "Security group for ${svc.name}"

  ingress {
    from_port   = ${svc.port || 80}
    to_port     = ${svc.port || 80}
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}`;
  }

  if (provider === 'azure') {
    return `resource "${res.resource}" "${name}" {
  name                = "${name}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  size                = "${instanceType}"
  admin_username      = "adminuser"

  admin_ssh_key {
    username   = "adminuser"
    public_key = file("~/.ssh/id_rsa.pub")
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  tags = {
    Environment = "production"
    ManagedBy   = "terraform"
  }
}`;
  }

  // GCP
  return `resource "${res.resource}" "${name}" {
  name         = "${name}"
  machine_type = "${instanceType}"
  zone         = "us-central1-a"

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-11"
    }
  }

  network_interface {
    network = "default"
    access_config {}
  }

  labels = {
    environment = "production"
    managed_by  = "terraform"
  }
}`;
}

/**
 * Generate Terraform HCL for a database service.
 * @param {Object} svc
 * @param {string} provider
 * @returns {string}
 */
function terraformDatabase(svc, provider) {
  const name = sanitizeName(svc.name);
  const size = (svc.size || 'medium').toLowerCase();
  const dbSize = DB_SIZE_MAP[provider][size] || DB_SIZE_MAP[provider].medium;
  const engine = (svc.engine || 'postgres').toLowerCase();
  const res = PROVIDER_RESOURCES[provider].database;

  if (provider === 'aws') {
    return `resource "${res.resource}" "${name}" {
  identifier     = "${name}"
  engine         = "${engine}"
  engine_version = "${engine === 'postgres' ? '15.4' : '8.0'}"
  instance_class = "${dbSize}"
  allocated_storage = ${svc.storageGB || 20}

  # Security best practices
  storage_encrypted   = true
  deletion_protection = true
  skip_final_snapshot = false

  backup_retention_period = 7
  multi_az                = ${size === 'large' || size === 'xlarge' ? 'true' : 'false'}

  tags = {
    Name        = "${svc.name}"
    Environment = "production"
    ManagedBy   = "terraform"
  }
}`;
  }

  if (provider === 'azure') {
    return `resource "${res.resource}" "${name}" {
  name                = "${name}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku_name            = "${dbSize}"
  version             = "${engine === 'postgres' ? '15' : '8.0'}"

  storage_mb = ${(svc.storageGB || 20) * 1024}

  # Security best practices
  ssl_enforcement_enabled = true
  backup_retention_days   = 7

  tags = {
    Environment = "production"
    ManagedBy   = "terraform"
  }
}`;
  }

  // GCP
  const engineMap = res.engines || {};
  return `resource "${res.resource}" "${name}" {
  name             = "${name}"
  database_version = "${engineMap[engine] || 'POSTGRES'}_15"
  region           = "us-central1"

  settings {
    tier = "${dbSize}"

    backup_configuration {
      enabled    = true
      start_time = "03:00"
    }

    ip_configuration {
      require_ssl = true
    }
  }

  deletion_protection = true

  labels = {
    environment = "production"
    managed_by  = "terraform"
  }
}`;
}

/**
 * Generate Terraform HCL for a storage service.
 * @param {Object} svc
 * @param {string} provider
 * @returns {string}
 */
function terraformStorage(svc, provider) {
  const name = sanitizeName(svc.name);
  const res = PROVIDER_RESOURCES[provider].storage;

  if (provider === 'aws') {
    return `resource "${res.resource}" "${name}" {
  bucket = "${name}-${provider}-bucket"

  # Security best practices
  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        sse_algorithm = "AES256"
      }
    }
  }

  versioning {
    enabled = true
  }

  tags = {
    Name        = "${svc.name}"
    Environment = "production"
    ManagedBy   = "terraform"
  }
}

resource "aws_s3_bucket_public_access_block" "${name}_public_access" {
  bucket = ${res.resource}.${name}.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}`;
  }

  if (provider === 'azure') {
    return `resource "${res.resource}" "${name}" {
  name                     = "${name.replace(/[^a-z0-9]/g, '')}sa"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"

  # Security best practice
  allow_nested_items_to_be_public = false

  tags = {
    Environment = "production"
    ManagedBy   = "terraform"
  }
}`;
  }

  // GCP
  return `resource "${res.resource}" "${name}" {
  name     = "${name}-${provider}-bucket"
  location = "US"

  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  labels = {
    environment = "production"
    managed_by  = "terraform"
  }
}`;
}

/**
 * Generate Terraform for a generic/fallback service type.
 * @param {Object} svc
 * @param {string} provider
 * @returns {string}
 */
function terraformGeneric(svc, provider) {
  const name = sanitizeName(svc.name);
  const type = (svc.type || 'compute').toLowerCase();
  const mapping = PROVIDER_RESOURCES[provider][type];
  const resourceType = mapping ? mapping.resource : `${provider}_generic_resource`;

  return `# TODO: Customize this resource for your specific needs
resource "${resourceType}" "${name}" {
  name = "${name}"

  tags = {
    Name        = "${svc.name}"
    Environment = "production"
    ManagedBy   = "terraform"
  }
}`;
}

/**
 * Generate a Terraform file for all services.
 * @param {Object[]} services
 * @param {string} provider
 * @returns {Object} { name, content }
 */
function generateTerraform(services, provider) {
  const providerBlocks = {
    aws: `terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}`,
    azure: `terraform {
  required_version = ">= 1.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "main" {
  name     = "production-rg"
  location = "East US"
}`,
    gcp: `terraform {
  required_version = ">= 1.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = "my-project-id"
  region  = "us-central1"
}`,
  };

  const blocks = [providerBlocks[provider]];

  for (const svc of services) {
    const type = (svc.type || 'compute').toLowerCase();
    blocks.push('');
    blocks.push(`# --- ${svc.name} (${type}) ---`);

    if (type === 'compute') {
      blocks.push(terraformCompute(svc, provider));
    } else if (type === 'database') {
      blocks.push(terraformDatabase(svc, provider));
    } else if (type === 'storage') {
      blocks.push(terraformStorage(svc, provider));
    } else {
      blocks.push(terraformGeneric(svc, provider));
    }
  }

  return {
    name: 'main.tf',
    content: blocks.join('\n'),
  };
}

/**
 * Generate a Dockerfile for services.
 * @param {Object[]} services
 * @returns {Object} { name, content }
 */
function generateDockerfile(services) {
  const computeServices = services.filter((s) => (s.type || 'compute').toLowerCase() === 'compute');
  const primaryService = computeServices[0] || services[0];
  const port = primaryService.port || 3000;
  const name = sanitizeName(primaryService.name);

  const content = `# Multi-stage build for ${primaryService.name}
# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Stage 2: Production
FROM node:20-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S appgroup && \\
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy built artifacts from builder
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app .

# Security: drop all capabilities, use non-root
USER appuser

EXPOSE ${port}

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD wget --no-verbose --tries=1 --spider http://localhost:${port}/health || exit 1

# Use dumb-init for proper signal handling
RUN apk add --no-cache dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]

# Labels
LABEL maintainer="${name}"
LABEL version="1.0"
LABEL description="Production container for ${primaryService.name}"
`;

  return {
    name: 'Dockerfile',
    content,
  };
}

/**
 * Generate a docker-compose.yml for multi-service setups.
 * @param {Object[]} services
 * @returns {Object} { name, content }
 */
function generateDockerCompose(services) {
  const composeServices = {};

  for (const svc of services) {
    const name = sanitizeName(svc.name);
    const type = (svc.type || 'compute').toLowerCase();

    if (type === 'compute') {
      composeServices[name] = {
        build: '.',
        ports: [`${svc.port || 3000}:${svc.port || 3000}`],
        environment: ['NODE_ENV=production'],
        restart: 'unless-stopped',
        deploy: {
          resources: {
            limits: { cpus: '1.0', memory: '512M' },
            reservations: { cpus: '0.25', memory: '128M' },
          },
        },
        healthcheck: {
          test: ['CMD', 'wget', '--spider', '-q', `http://localhost:${svc.port || 3000}/health`],
          interval: '30s',
          timeout: '3s',
          retries: 3,
        },
      };
    } else if (type === 'database') {
      const engine = (svc.engine || 'postgres').toLowerCase();
      const images = {
        postgres: 'postgres:15-alpine',
        mysql: 'mysql:8.0',
        mariadb: 'mariadb:10.11',
      };
      composeServices[name] = {
        image: images[engine] || images.postgres,
        environment:
          engine === 'postgres'
            ? ['POSTGRES_DB=app', 'POSTGRES_USER=app', 'POSTGRES_PASSWORD=changeme']
            : [
                'MYSQL_DATABASE=app',
                'MYSQL_USER=app',
                'MYSQL_PASSWORD=changeme',
                'MYSQL_ROOT_PASSWORD=changeme',
              ],
        volumes: [`${name}_data:/var/lib/${engine === 'postgres' ? 'postgresql/data' : 'mysql'}`],
        restart: 'unless-stopped',
      };
    } else if (type === 'cache') {
      composeServices[name] = {
        image: 'redis:7-alpine',
        restart: 'unless-stopped',
      };
    }
  }

  // Build YAML manually for cleaner output
  let yamlContent = 'version: "3.8"\n\nservices:\n';
  for (const [name, config] of Object.entries(composeServices)) {
    yamlContent += `  ${name}:\n`;
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string') {
        yamlContent += `    ${key}: ${value}\n`;
      } else if (Array.isArray(value)) {
        yamlContent += `    ${key}:\n`;
        for (const item of value) {
          if (typeof item === 'string') {
            yamlContent += `      - "${item}"\n`;
          } else {
            yamlContent += `      - ${JSON.stringify(item)}\n`;
          }
        }
      } else if (typeof value === 'object') {
        yamlContent += `    ${key}:\n`;
        yamlContent += formatYamlObject(value, 6);
      }
    }
    yamlContent += '\n';
  }

  // Volumes
  const dbServices = services.filter((s) => (s.type || '').toLowerCase() === 'database');
  if (dbServices.length > 0) {
    yamlContent += 'volumes:\n';
    for (const svc of dbServices) {
      yamlContent += `  ${sanitizeName(svc.name)}_data:\n`;
    }
  }

  return {
    name: 'docker-compose.yml',
    content: yamlContent,
  };
}

/**
 * Format an object as indented YAML lines.
 * @param {Object} obj
 * @param {number} indent
 * @returns {string}
 */
function formatYamlObject(obj, indent) {
  let result = '';
  const pad = ' '.repeat(indent);
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result += `${pad}${key}: ${value}\n`;
    } else if (Array.isArray(value)) {
      result += `${pad}${key}:\n`;
      for (const item of value) {
        if (typeof item === 'string') {
          result += `${pad}  - "${item}"\n`;
        } else {
          result += `${pad}  - ${JSON.stringify(item)}\n`;
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      result += `${pad}${key}:\n`;
      result += formatYamlObject(value, indent + 2);
    }
  }
  return result;
}

/**
 * Generate Kubernetes YAML manifests.
 * @param {Object[]} services
 * @param {string} _provider - unused but kept for interface consistency
 * @returns {Object} { name, content }
 */
function generateK8s(services, _provider) {
  const manifests = [];

  for (const svc of services) {
    const name = sanitizeName(svc.name);
    const type = (svc.type || 'compute').toLowerCase();
    const replicas = svc.replicas || (type === 'compute' ? 2 : 1);
    const port = svc.port || 3000;

    if (type === 'compute') {
      // Deployment
      manifests.push(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app: ${name}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      # Security: run as non-root
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        fsGroup: 1001
      containers:
        - name: ${name}
          image: ${name}:latest
          ports:
            - containerPort: ${port}
          # Resource limits (best practice)
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          # Health checks
          livenessProbe:
            httpGet:
              path: /health
              port: ${port}
            initialDelaySeconds: 15
            periodSeconds: 20
          readinessProbe:
            httpGet:
              path: /health
              port: ${port}
            initialDelaySeconds: 5
            periodSeconds: 10
          # Security context per container
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL`);

      // Service
      manifests.push(`---
apiVersion: v1
kind: Service
metadata:
  name: ${name}-svc
spec:
  selector:
    app: ${name}
  ports:
    - protocol: TCP
      port: 80
      targetPort: ${port}
  type: ClusterIP`);
    } else if (type === 'database') {
      const engine = (svc.engine || 'postgres').toLowerCase();
      const images = { postgres: 'postgres:15-alpine', mysql: 'mysql:8.0' };
      const dbPort = engine === 'postgres' ? 5432 : 3306;

      // StatefulSet for databases
      manifests.push(`apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${name}
spec:
  serviceName: ${name}
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
        - name: ${name}
          image: ${images[engine] || images.postgres}
          ports:
            - containerPort: ${dbPort}
          env:
            - name: ${engine === 'postgres' ? 'POSTGRES_DB' : 'MYSQL_DATABASE'}
              value: "app"
            - name: ${engine === 'postgres' ? 'POSTGRES_PASSWORD' : 'MYSQL_ROOT_PASSWORD'}
              valueFrom:
                secretKeyRef:
                  name: ${name}-secret
                  key: password
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "1000m"
              memory: "1Gi"
          volumeMounts:
            - name: ${name}-data
              mountPath: /var/lib/${engine === 'postgres' ? 'postgresql/data' : 'mysql'}
  volumeClaimTemplates:
    - metadata:
        name: ${name}-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: ${svc.storageGB || 10}Gi`);

      // Service for database
      manifests.push(`---
apiVersion: v1
kind: Service
metadata:
  name: ${name}-svc
spec:
  selector:
    app: ${name}
  ports:
    - protocol: TCP
      port: ${dbPort}
      targetPort: ${dbPort}
  type: ClusterIP`);
    } else if (type === 'storage') {
      // PVC for storage
      manifests.push(`apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${name}-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: ${svc.storageGB || 10}Gi`);
    }
  }

  return {
    name: 'k8s-manifests.yaml',
    content: manifests.join('\n---\n'),
  };
}

/**
 * Generate recommendations based on the services and configuration.
 * @param {Object[]} services
 * @param {string} provider
 * @param {string} format
 * @returns {string[]}
 */
function generateRecommendations(services, provider, format) {
  const recommendations = [];

  // Check for missing health checks
  const computeWithoutPort = services.filter(
    (s) => (s.type || 'compute').toLowerCase() === 'compute' && !s.port
  );
  if (computeWithoutPort.length > 0) {
    recommendations.push(
      `${computeWithoutPort.length} compute service(s) have no port defined. Default port 3000 was used. Specify "port" for accurate health check configuration.`
    );
  }

  // Database security
  const databases = services.filter((s) => (s.type || '').toLowerCase() === 'database');
  if (databases.length > 0) {
    recommendations.push(
      'Database credentials should be managed via secrets management (AWS Secrets Manager, Azure Key Vault, or GCP Secret Manager). Do not commit plaintext credentials.'
    );
  }

  // Replication for production
  const singleReplica = services.filter(
    (s) => (s.type || 'compute').toLowerCase() === 'compute' && (!s.replicas || s.replicas < 2)
  );
  if (singleReplica.length > 0 && format === 'k8s') {
    recommendations.push(
      `${singleReplica.length} compute service(s) have fewer than 2 replicas. Consider increasing replicas for high availability.`
    );
  }

  // Terraform state
  if (format === 'terraform') {
    recommendations.push(
      'Configure remote state backend (S3, Azure Blob, or GCS) for team collaboration and state locking.'
    );
  }

  // Docker security
  if (format === 'docker') {
    recommendations.push(
      'Scan container images for vulnerabilities using tools like Trivy or Snyk before deploying to production.'
    );
  }

  // Multi-service networking
  if (services.length > 3) {
    recommendations.push(
      `${services.length} services defined. Consider implementing a service mesh (Istio, Linkerd) for observability and traffic management.`
    );
  }

  // Provider-specific
  if (provider === 'aws') {
    recommendations.push('Enable AWS CloudTrail and GuardDuty for security monitoring.');
  } else if (provider === 'azure') {
    recommendations.push(
      'Enable Azure Security Center for threat detection and compliance monitoring.'
    );
  } else if (provider === 'gcp') {
    recommendations.push('Enable Cloud Audit Logs and Security Command Center for visibility.');
  }

  return recommendations;
}

runSkill('environment-provisioner', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }

  const config = parseConfig(resolved);

  if (!config || !Array.isArray(config.services) || config.services.length === 0) {
    throw new Error('Config must contain a "services" array with at least one service definition.');
  }

  const provider = argv.provider.toLowerCase();
  const format = argv.format.toLowerCase();

  const generatedFiles = [];

  if (format === 'terraform') {
    generatedFiles.push(generateTerraform(config.services, provider));
  } else if (format === 'docker') {
    generatedFiles.push(generateDockerfile(config.services));
    if (config.services.length > 1) {
      generatedFiles.push(generateDockerCompose(config.services));
    }
  } else if (format === 'k8s') {
    generatedFiles.push(generateK8s(config.services, provider));
  }

  const recommendations = generateRecommendations(config.services, provider, format);

  const report = {
    provider,
    format,
    services: config.services.length,
    generatedFiles,
    recommendations,
  };

  if (argv.out) {
    safeWriteFile(argv.out, JSON.stringify(report, null, 2));
  }

  return report;
});
