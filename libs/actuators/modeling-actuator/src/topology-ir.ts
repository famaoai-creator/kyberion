export type TerraformBlock = {
  kind: string;
  type: string;
  name: string;
  id: string;
  dir: string;
  body: string;
  filePath: string;
  module_origin?: string;
};

export type TerraformTopologyIr = {
  kind: 'terraform_topology_ir';
  version: '1.0.0';
  source_kind: 'terraform';
  source_root: string;
  title: string;
  provider: 'aws';
  tfFiles: string[];
  allBlocks: TerraformBlock[];
  runtimeBlocks: TerraformBlock[];
  moduleSourceDirs: string[];
  callerBlocksBySource: Record<string, TerraformBlock[]>;
};
