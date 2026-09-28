/** Domain barrel — public surface for libs/core/plugin */
export * from './plugin-contributions.js';
export * from './plugin-grant-runtime.js';
export * from './plugin-host.js';
export * from './plugin-lifecycle.js';
export * from './plugin-managed-install.js';
export * from './plugin-manifest-candidates.js';
export * from './plugin-pack.js';
export type {
  PluginNetworkMode,
  PluginFsMode,
  PluginPermissionTier,
  PluginFsPathScope,
  PluginPermissionRequest,
  PluginPermissionCeiling,
  PluginPermissionPolicy,
  PluginPermissionCapability,
  NarrowPluginPermissionsOptions,
  NarrowPluginPermissionsResult,
} from './plugin-permissions.js';
export {
  findDisallowedOfficialOnlySeam,
  PLUGIN_PERMISSION_POLICY_RELATIVE_PATH,
  isLegacyCoworkPermissionsBlock,
  parsePluginPermissionRequest,
  parsePluginPermissionGrant,
  normalizeTierPrefix,
  narrowPluginPermissions,
  permissionsDigest,
  summarizePermissionDiff,
  loadPluginPermissionPolicy,
} from './plugin-permissions.js';
export * from './plugin-source-trust.js';
export * from './plugin-view-actions.js';
export * from './plugin-view-contract.js';
export {
  PLUGIN_VIEW_FRAME_MAX_BYTES,
  PLUGIN_VIEW_ACTION_REQUEST_CAPABILITY,
  PLUGIN_VIEW_FRAME_PROTOCOL,
  isPluginViewFrameDocumentPath,
  findPluginViewFrameViolation,
  decodePluginViewFrameHtml,
  pluginViewFrameResponseHeaders,
} from './plugin-view-frame.js';
export * from './skill-index.js';
export * from './skill-install-package-map.js';
export * from './skill-plugin-loader.js';
export * from './skill-resource-loader.js';
export * from './skill-wrapper.js';
