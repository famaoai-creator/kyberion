import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface MediaAwsIconRuleEntry {
  match_type: 'starts_with' | 'contains';
  match_value: string;
  icons: string[];
}

interface MediaAwsIconRuleCatalog {
  version: string;
  exact_resources: Record<string, string[]>;
  rules: MediaAwsIconRuleEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-aws-icon-rules.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-aws-icon-rules.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MediaAwsIconRuleCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_RULES: MediaAwsIconRuleEntry[] = [
  {
    match_type: 'starts_with',
    match_value: 'aws_iam_',
    icons: [
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.png',
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.svg',
    ],
  },
  {
    match_type: 'contains',
    match_value: 'cloudwatch',
    icons: [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Management-Tools/48/Arch_Amazon-CloudWatch_48.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Management-Tools/48/Arch_Amazon-CloudWatch_48.svg',
    ],
  },
  {
    match_type: 'contains',
    match_value: 'security_group',
    icons: [
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.png',
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.svg',
    ],
  },
  {
    match_type: 'contains',
    match_value: 'autoscaling',
    icons: [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2-Auto-Scaling_48.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2-Auto-Scaling_48.svg',
    ],
  },
];

const FALLBACK_EXACT_RESOURCES: Record<string, string[]> = {
  aws_provider: [
    'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Compute_32.png',
    'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Compute_32.svg',
  ],
  aws_vpc: [
    'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-VPC_Virtual-private-cloud-VPC_48.png',
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Virtual-private-cloud-VPC_32.svg',
    'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-VPC_Virtual-private-cloud-VPC_48.svg',
  ],
  aws_subnet: [
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Public-subnet_32.png',
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Private-subnet_32.png',
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Public-subnet_32.svg',
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Private-subnet_32.svg',
  ],
  aws_region: [
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Region_32.png',
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Region_32.svg',
  ],
  aws_internet_gateway: [
    'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-VPC_Internet-Gateway_48.png',
    'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-VPC_Internet-Gateway_48.svg',
  ],
  aws_nat_gateway: [
    'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-VPC_NAT-Gateway_48.png',
    'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-VPC_NAT-Gateway_48.svg',
  ],
  aws_route_table: [
    'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-Route-53_Route-Table_48.png',
    'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-Route-53_Route-Table_48.svg',
  ],
  aws_availability_zones: [
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Cloud_32.png',
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Cloud_32.svg',
  ],
  aws_lb: [
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Networking-Content-Delivery/48/Arch_Elastic-Load-Balancing_48.png',
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Networking-Content-Delivery/48/Arch_Elastic-Load-Balancing_48.svg',
  ],
  aws_elb: [
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Networking-Content-Delivery/48/Arch_Elastic-Load-Balancing_48.png',
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Networking-Content-Delivery/48/Arch_Elastic-Load-Balancing_48.svg',
  ],
  aws_instance: [
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2_48.png',
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2_48.svg',
  ],
  aws_launch_configuration: [
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/EC2-instance-contents_32.png',
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2_48.png',
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/EC2-instance-contents_32.svg',
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2_48.svg',
  ],
  aws_autoscaling_group: [
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2-Auto-Scaling_48.png',
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Auto-Scaling-group_32.png',
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2-Auto-Scaling_48.svg',
    'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Auto-Scaling-group_32.svg',
  ],
  aws_rds_instance: [
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Databases/48/Arch_Amazon-RDS_48.png',
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Databases/48/Arch_Amazon-RDS_48.svg',
  ],
  aws_db_instance: [
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Databases/48/Arch_Amazon-RDS_48.png',
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Databases/48/Arch_Amazon-RDS_48.svg',
  ],
  aws_s3_bucket: [
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Storage/48/Arch_Amazon-Simple-Storage-Service_48.png',
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Storage/48/Arch_Amazon-Simple-Storage-Service_48.svg',
  ],
  aws_cloudwatch_metric_alarm: [
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Management-Tools/48/Arch_Amazon-CloudWatch_48.png',
    'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Management-Governance/Res_Amazon-CloudWatch_Alarm_48.png',
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Management-Tools/48/Arch_Amazon-CloudWatch_48.svg',
    'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Management-Governance/Res_Amazon-CloudWatch_Alarm_48.svg',
  ],
  terraform_remote_state: [
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Storage/48/Arch_Amazon-Simple-Storage-Service_48.png',
    'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Storage/48/Arch_Amazon-Simple-Storage-Service_48.svg',
  ],
  aws_security_group: [
    'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.png',
    'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.svg',
  ],
  aws_security_group_rule: [
    'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.png',
    'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.svg',
  ],
};

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validateCatalog(value: unknown, label: string): MediaAwsIconRuleCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid media aws icon rule catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MediaAwsIconRuleCatalog;
}

export function loadMediaAwsIconRuleCatalog(): MediaAwsIconRuleCatalog {
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;
  if (!safeExistsSync(CATALOG_PATH)) {
    cachedCatalog = { version: '1.0.0', exact_resources: FALLBACK_EXACT_RESOURCES, rules: FALLBACK_RULES };
    cachedCatalogPath = CATALOG_PATH;
    return cachedCatalog;
  }
  const parsed = validateCatalog(
    JSON.parse(safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) as string),
    CATALOG_PATH
  );
  cachedCatalog = parsed;
  cachedCatalogPath = CATALOG_PATH;
  return parsed;
}

export function resolveMediaAwsIconCandidates(resourceType: string): string[] {
  const normalized = String(resourceType || '').trim();
  if (!normalized) return [];
  const catalog = loadMediaAwsIconRuleCatalog();
  const exact = catalog.exact_resources[normalized];
  if (Array.isArray(exact) && exact.length > 0) return exact;
  for (const rule of catalog.rules) {
    if (rule.match_type === 'starts_with' && normalized.startsWith(rule.match_value)) return rule.icons;
    if (rule.match_type === 'contains' && normalized.includes(rule.match_value)) return rule.icons;
  }
  return [];
}

export function resetMediaAwsIconRuleCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
