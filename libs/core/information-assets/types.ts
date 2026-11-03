/** Pure contracts shared by information asset catalogs, collectors and intake recipes. */
export type InformationJson =
  null | boolean | number | string | InformationJson[] | { [key: string]: InformationJson };
export type InformationObject = { [key: string]: InformationJson };
export interface InformationAssetScope {
  tenant_slug: string;
  organization_id: string;
  project_id?: string;
}
export interface InformationAssetDefinition {
  asset_type: string;
  title: string;
  description: string;
  aliases: string[];
  schema_ref?: string;
  default_freshness_seconds: number;
}
export interface InformationAssetLocation {
  location_id: string;
  asset_type: string;
  scope: InformationAssetScope;
  binding_id: string;
  service_id: string;
  collector_id: string;
  selectors: InformationObject;
  tier: 'confidential' | 'personal';
  authoritative: boolean;
  freshness_seconds: number;
  enabled: boolean;
  version: number;
  updated_at: string;
}
export interface InformationAssetCatalog {
  version: number;
  scope: InformationAssetScope;
  locations: InformationAssetLocation[];
}
export interface InformationAssetObservation {
  event_id: string;
  scope: InformationAssetScope;
  asset_type: string;
  location_id: string;
  binding_id: string;
  service_id: string;
  subject_id: string;
  change_id: string;
  event_type: string;
  source_url?: string;
  occurred_at?: string;
  observed_at: string;
  content_sha256: string;
  data: InformationObject;
}
export interface InformationAssetCoverage {
  status: 'complete' | 'partial' | 'failed' | 'full_sync_required';
  observed_at: string;
  page_count: number;
  accepted_count: number;
  covered_through?: string;
  reason?: string;
}
export interface InformationAssetServiceRequest {
  service_id: string;
  action: string;
  params: Record<string, unknown>;
}
export type InformationAssetServiceCall = (
  request: InformationAssetServiceRequest
) => Promise<unknown>;
