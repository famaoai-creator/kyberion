#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');

const ICON_MAP = {
  aws_vpc:
    'https://raw.githubusercontent.com/awslabs/aws-icons-for-plantuml/v18.0/dist/Groups/VPC.png',
  aws_instance:
    'https://raw.githubusercontent.com/awslabs/aws-icons-for-plantuml/v18.0/dist/Compute/EC2.png',
  aws_db_instance:
    'https://raw.githubusercontent.com/awslabs/aws-icons-for-plantuml/v18.0/dist/Database/RDS.png',
  aws_subnet:
    'https://raw.githubusercontent.com/awslabs/aws-icons-for-plantuml/v18.0/dist/Groups/PublicSubnet.png',
  aws_lambda_function:
    'https://raw.githubusercontent.com/awslabs/aws-icons-for-plantuml/v18.0/dist/Compute/Lambda.png',
  aws_s3_bucket:
    'https://raw.githubusercontent.com/awslabs/aws-icons-for-plantuml/v18.0/dist/Storage/SimpleStorageService.png',
};

function generateSVG(resources) {
  const width = 1200;
  const height = 800;
  let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="100%" height="100%" fill="#ffffff" />`;
  svg += `<text x="40" y="40" font-family="Arial" font-size="28" fill="#232f3e" font-weight="bold">AWS System Architecture</text>`;

  // Simple grouping logic: VPC first, then subnets, then others
  const vpcs = resources.filter((r) => r.type === 'aws_vpc');
  const subnets = resources.filter((r) => r.type === 'aws_subnet');
  const others = resources.filter((r) => r.type !== 'aws_vpc' && r.type !== 'aws_subnet');

  const x = 60;
  const y = 80;

  // Draw VPCs as large containers
  vpcs.forEach((vpc) => {
    svg += `
        <g transform="translate(${x}, ${y})">
            <rect width="1000" height="600" rx="15" fill="none" stroke="#ff9900" stroke-width="2" stroke-dasharray="8,4" />
            <image href="${ICON_MAP.aws_vpc}" x="10" y="10" width="40" height="40" opacity="0.6" />
            <text x="60" y="35" font-family="Arial" font-size="16" fill="#ff9900" font-weight="bold">VPC: ${vpc.name}</text>
        </g>`;
  });

  // Draw Subnets inside
  const sx = x + 40;
  let sy = y + 60;
  subnets.forEach((sn) => {
    svg += `
        <g transform="translate(${sx}, ${sy})">
            <rect width="900" height="250" rx="10" fill="#f1faff" stroke="#007dbc" stroke-width="1" />
            <text x="20" y="25" font-family="Arial" font-size="14" fill="#007dbc" font-weight="bold">Subnet: ${sn.name}</text>
        </g>`;

    // Draw Compute inside Subnet (simplified layout)
    let cx = sx + 40;
    const cy = sy + 50;
    others
      .filter((o) => o.type === 'aws_instance')
      .forEach((inst) => {
        svg += `
            <g transform="translate(${cx}, ${cy})">
                <rect width="120" height="120" rx="8" fill="white" stroke="#232f3e" stroke-width="1" />
                <image href="${ICON_MAP.aws_instance}" x="35" y="15" width="50" height="50" />
                <text x="60" y="90" text-anchor="middle" font-family="Arial" font-size="11" fill="#232f3e" font-weight="bold">${inst.name}</text>
            </g>`;
        cx += 160;
      });
    sy += 280;
  });

  // Draw Global Services (S3, Lambda) outside or at the bottom
  let gx = x + 40;
  const gy = 650;
  others
    .filter((o) => o.type !== 'aws_instance')
    .forEach((res) => {
      const iconUrl = ICON_MAP[res.type] || ICON_MAP.aws_instance;
      svg += `
        <g transform="translate(${gx}, ${gy})">
            <rect width="140" height="120" rx="8" fill="#fafafa" stroke="#d5dbdb" stroke-width="1" />
            <image href="${iconUrl}" x="45" y="15" width="50" height="50" />
            <text x="70" y="90" text-anchor="middle" font-family="Arial" font-size="11" fill="#232f3e" font-weight="bold">${res.name}</text>
            <text x="70" y="105" text-anchor="middle" font-family="Arial" font-size="9" fill="#7f8c8d">${res.type}</text>
        </g>`;
      gx += 180;
    });

  svg += `</svg>`;
  return svg;
}

runSkill('terraform-arch-mapper', () => {
  const dirIdx = process.argv.indexOf('--dir');
  const outIdx = process.argv.indexOf('--out');
  const tfDir = dirIdx !== -1 ? path.resolve(process.argv[dirIdx + 1]) : null;
  const outPath = outIdx !== -1 ? path.resolve(process.argv[outIdx + 1]) : 'architecture.svg';

  if (!tfDir) throw new Error('Missing required argument: --dir');

  const files = fs.readdirSync(tfDir).filter((f) => f.endsWith('.tf'));
  const resources = [];

  files.forEach((file) => {
    const content = fs.readFileSync(path.join(tfDir, file), 'utf8');
    const matches = content.matchAll(/resource\s+"([^"]+)"\s+"([^"]+)"/g);
    for (const match of matches) {
      resources.push({ type: match[1], name: match[2] });
    }
  });

  const svgContent = generateSVG(resources);
  safeWriteFile(outPath, svgContent);

  return { status: 'success', resourceCount: resources.length, output: outPath };
});
