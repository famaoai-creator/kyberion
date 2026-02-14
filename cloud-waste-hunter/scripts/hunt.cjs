#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { getAllFiles } = require('../../scripts/lib/fs-utils.cjs');

const argv = createStandardYargs().option('dir', {
  alias: 'd',
  type: 'string',
  default: '.',
  description: 'Directory with cloud configs',
}).argv;

const scanDir = path.resolve(argv.dir);

// Oversized instance patterns across cloud providers
const OVERSIZED_INSTANCE_PATTERNS = [
  /\b(m5\.4xlarge|m5\.8xlarge|m5\.12xlarge|m5\.16xlarge|m5\.24xlarge|m5\.metal)\b/,
  /\b(c5\.4xlarge|c5\.9xlarge|c5\.12xlarge|c5\.18xlarge|c5\.24xlarge|c5\.metal)\b/,
  /\b(r5\.4xlarge|r5\.8xlarge|r5\.12xlarge|r5\.16xlarge|r5\.24xlarge|r5\.metal)\b/,
  /\b(x1\.16xlarge|x1\.32xlarge|x1e\.xlarge|x1e\.32xlarge)\b/,
  /\b(p3\.8xlarge|p3\.16xlarge|p3dn\.24xlarge)\b/,
  /\b(i3\.4xlarge|i3\.8xlarge|i3\.16xlarge|i3\.metal)\b/,
  /\bStandard_D(8|16|32|48|64)s?_v[0-9]+\b/,
  /\bStandard_E(8|16|32|48|64)s?_v[0-9]+\b/,
  /\bn1-standard-(16|32|64|96)\b/,
  /\bn1-highmem-(16|32|64|96)\b/,
];

function isTerraformFile(filePath) {
  return /\.tf$/.test(filePath);
}

function isCloudFormationFile(filePath, content) {
  if (!/\.(ya?ml|json)$/.test(filePath)) return false;
  return /AWSTemplateFormatVersion/.test(content);
}

function isDockerFile(filePath) {
  const basename = path.basename(filePath);
  return (
    basename === 'Dockerfile' ||
    basename === 'docker-compose.yml' ||
    basename === 'docker-compose.yaml'
  );
}

function isKubernetesFile(_filePath, content) {
  return (
    /apiVersion:/.test(content) && /kind:\s*(Deployment|Service|Pod|StatefulSet)/.test(content)
  );
}

function checkOversizedInstances(content, filePath) {
  const findings = [];
  for (const pattern of OVERSIZED_INSTANCE_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      findings.push({
        type: 'oversized-instance',
        severity: 'high',
        file: filePath,
        detail: `Potentially oversized instance type: ${match[0]}. Consider right-sizing based on actual utilization.`,
      });
    }
  }
  return findings;
}

function checkMissingAutoScaling(content, filePath) {
  const findings = [];

  // Terraform: EC2 instances without auto-scaling group
  if (
    /resource\s+"aws_instance"/.test(content) &&
    !/resource\s+"aws_autoscaling_group"/.test(content)
  ) {
    findings.push({
      type: 'missing-autoscaling',
      severity: 'medium',
      file: filePath,
      detail:
        'EC2 instance defined without an auto-scaling group. Consider using ASG for better cost efficiency.',
    });
  }

  // Kubernetes: Deployment without HPA
  if (/kind:\s*Deployment/.test(content) && !/HorizontalPodAutoscaler/.test(content)) {
    findings.push({
      type: 'missing-autoscaling',
      severity: 'low',
      file: filePath,
      detail:
        'Kubernetes Deployment without HorizontalPodAutoscaler reference. Consider adding HPA for dynamic scaling.',
    });
  }

  return findings;
}

function checkUnusedResources(content, filePath) {
  const findings = [];

  // Terraform: EBS volumes not attached
  if (/resource\s+"aws_ebs_volume"/.test(content) && !/aws_volume_attachment/.test(content)) {
    findings.push({
      type: 'unused-resource',
      severity: 'medium',
      file: filePath,
      detail:
        'EBS volume defined without a volume attachment. May result in orphaned storage costs.',
    });
  }

  // Terraform: Elastic IP without association
  if (/resource\s+"aws_eip"/.test(content) && !/aws_eip_association/.test(content)) {
    findings.push({
      type: 'unused-resource',
      severity: 'medium',
      file: filePath,
      detail: 'Elastic IP allocated without association. Unattached EIPs incur charges.',
    });
  }

  // Terraform: NAT Gateway (expensive)
  if (/resource\s+"aws_nat_gateway"/.test(content)) {
    findings.push({
      type: 'cost-warning',
      severity: 'low',
      file: filePath,
      detail:
        'NAT Gateway detected. These can be expensive; consider NAT instances for dev/test environments.',
    });
  }

  return findings;
}

function checkDockerWaste(content, filePath) {
  const findings = [];
  const basename = path.basename(filePath);

  if (basename === 'Dockerfile') {
    // Large base images
    if (/FROM\s+(ubuntu|debian|centos|amazonlinux)(?::|\s)/m.test(content)) {
      findings.push({
        type: 'inefficient-image',
        severity: 'low',
        file: filePath,
        detail:
          'Using a full OS base image. Consider alpine or distroless images to reduce size and cost.',
      });
    }

    // No multi-stage build
    const fromCount = (content.match(/^FROM\s/gm) || []).length;
    if (fromCount === 1 && content.length > 500) {
      findings.push({
        type: 'inefficient-image',
        severity: 'low',
        file: filePath,
        detail: 'Single-stage Dockerfile. Consider multi-stage builds to reduce final image size.',
      });
    }
  }

  return findings;
}

function calculateWasteScore(findings) {
  let score = 0;
  for (const finding of findings) {
    if (finding.severity === 'high') score += 30;
    else if (finding.severity === 'medium') score += 15;
    else if (finding.severity === 'low') score += 5;
  }
  return Math.min(score, 100);
}

function generateRecommendations(findings) {
  const recommendations = [];
  const types = new Set(findings.map((f) => f.type));

  if (types.has('oversized-instance')) {
    recommendations.push('Right-size instances based on actual CPU/memory utilization metrics.');
  }
  if (types.has('missing-autoscaling')) {
    recommendations.push(
      'Implement auto-scaling to match capacity with demand and reduce idle costs.'
    );
  }
  if (types.has('unused-resource')) {
    recommendations.push('Clean up unattached or unused resources (EBS volumes, Elastic IPs).');
  }
  if (types.has('inefficient-image')) {
    recommendations.push('Optimize Docker images with alpine base images and multi-stage builds.');
  }
  if (types.has('cost-warning')) {
    recommendations.push(
      'Review expensive managed services and consider alternatives for non-production environments.'
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      'No significant waste patterns detected. Consider running cloud provider cost analysis tools for deeper insights.'
    );
  }

  return recommendations;
}

runSkill('cloud-waste-hunter', () => {
  if (!fs.existsSync(scanDir)) {
    throw new Error(`Directory does not exist: ${scanDir}`);
  }

  const allFiles = getAllFiles(scanDir, { maxDepth: 10 });
  const findings = [];
  let totalFiles = 0;

  for (const filePath of allFiles) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (_err) {
      continue;
    }

    const relativePath = path.relative(scanDir, filePath);
    const isRelevant =
      isTerraformFile(filePath) ||
      isCloudFormationFile(filePath, content) ||
      isDockerFile(filePath) ||
      isKubernetesFile(filePath, content);

    if (!isRelevant) continue;

    totalFiles++;

    findings.push(...checkOversizedInstances(content, relativePath));
    findings.push(...checkMissingAutoScaling(content, relativePath));
    findings.push(...checkUnusedResources(content, relativePath));
    findings.push(...checkDockerWaste(content, relativePath));
  }

  const wasteScore = calculateWasteScore(findings);
  const recommendations = generateRecommendations(findings);

  return {
    findings,
    totalFiles,
    wasteScore,
    recommendations,
  };
});
