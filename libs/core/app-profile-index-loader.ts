import { pathResolver } from './path-resolver.js';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import {
  assertValidMobileAppProfileIndex,
  assertValidWebAppProfileIndex,
} from './mobile-profile-validators.js';
import type { MobileAppProfileIndex } from './types.js';
import type { WebAppProfileIndex } from './mobile-profile-validators.js';

const MOBILE_APP_PROFILE_INDEX_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mobile-app-profile-index.schema.json'
);
const WEB_APP_PROFILE_INDEX_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/web-app-profile-index.schema.json'
);
const mobileCatalogCache = new Map<string, GovernedCatalog<MobileAppProfileIndex>>();
const webCatalogCache = new Map<string, GovernedCatalog<WebAppProfileIndex>>();

function getMobileCatalog(indexPath: string): GovernedCatalog<MobileAppProfileIndex> {
  let catalog = mobileCatalogCache.get(indexPath);
  if (!catalog) {
    catalog = defineCatalog<MobileAppProfileIndex>({
      id: 'mobile-app-profile-index',
      path: indexPath,
      schema: MOBILE_APP_PROFILE_INDEX_SCHEMA_PATH,
    });
    mobileCatalogCache.set(indexPath, catalog);
  }
  return catalog;
}

function getWebCatalog(indexPath: string): GovernedCatalog<WebAppProfileIndex> {
  let catalog = webCatalogCache.get(indexPath);
  if (!catalog) {
    catalog = defineCatalog<WebAppProfileIndex>({
      id: 'web-app-profile-index',
      path: indexPath,
      schema: WEB_APP_PROFILE_INDEX_SCHEMA_PATH,
    });
    webCatalogCache.set(indexPath, catalog);
  }
  return catalog;
}

export function loadMobileAppProfileIndex(
  indexPath: string,
  pathExists: (relativePath: string) => boolean
): MobileAppProfileIndex {
  const index = getMobileCatalog(indexPath).load();
  assertValidMobileAppProfileIndex(index, indexPath, pathExists);
  return index;
}

export function loadWebAppProfileIndex(
  indexPath: string,
  pathExists: (relativePath: string) => boolean
): WebAppProfileIndex {
  const index = getWebCatalog(indexPath).load();
  assertValidWebAppProfileIndex(index, indexPath, pathExists);
  return index;
}
