const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const mime = require('mime-types');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('url', {
    alias: 'u',
    type: 'string',
    description: 'Source URL to fetch',
    demandOption: true,
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output directory',
    demandOption: true,
  })
  .option('name', {
    alias: 'n',
    type: 'string',
    description: 'Output filename (optional)',
  })
  .option('force', {
    alias: 'f',
    type: 'boolean',
    description: 'Force download ignoring cache/manifest',
    default: false,
  }).argv;

const MANIFEST_FILE = 'manifest.json';

function calculateHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function getManifest(outDir) {
  const manifestPath = path.join(outDir, MANIFEST_FILE);
  if (fs.existsSync(manifestPath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_e) {
      console.warn('Warning: existing manifest is corrupt. Starting fresh.');
    }
  }
  return {};
}

function saveManifest(outDir, manifest) {
  safeWriteFile(path.join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

runAsyncSkill('data-collector', async () => {
  const { url, out, name, force } = argv;

  // Ensure output directory exists
  if (!fs.existsSync(out)) {
    fs.mkdirSync(out, { recursive: true });
  }

  const manifest = getManifest(out);
  const history = manifest[url] || { history: [] };
  const lastEntry = history.history.length > 0 ? history.history[history.history.length - 1] : null;

  let data, contentType, statusCode;

  // Validate URL format for remote URLs
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      new URL(url);
    } catch (_e) {
      throw new Error(`Invalid URL: ${url}`);
    }

    let response;
    try {
      response = await axios.get(url, {
        responseType: 'arraybuffer',
        validateStatus: (status) => status < 400,
        timeout: 60000,
        maxContentLength: 100 * 1024 * 1024, // 100MB limit
      });
    } catch (_err) {
      if (err.code === 'ECONNABORTED') {
        throw new Error(`Download timed out after 60s: ${url}`);
      }
      if (err.response) {
        throw new Error(`HTTP ${err.response.status}: ${err.response.statusText}`);
      }
      throw new Error(`Download failed: ${err.message}`);
    }
    data = response.data;
    contentType = response.headers['content-type'];
    statusCode = response.status;
  } else {
    let localPath = url;
    if (url.startsWith('file://')) {
      localPath = new URL(url).pathname;
    }

    if (!fs.existsSync(localPath)) {
      throw new Error(`Local file not found: ${localPath}`);
    }

    data = fs.readFileSync(localPath);
    contentType = mime.lookup(localPath) || 'application/octet-stream';
    statusCode = 200;
  }

  const currentHash = calculateHash(data);

  // Check if content changed
  if (!force && lastEntry && lastEntry.hash === currentHash) {
    return { url, skipped: true, reason: 'Content has not changed (Hash match)' };
  }

  // Determine filename
  let filename = name;
  if (!filename) {
    let basename;
    try {
      const urlObj = new URL(url);
      basename = path.basename(urlObj.pathname);
    } catch (_e) {
      basename = path.basename(url);
    }

    if (basename && basename.includes('.')) {
      filename = basename;
    } else {
      const ext = mime.extension(contentType) || 'dat';
      filename = `data_${Date.now()}.${ext}`;
    }
  }

  const savePath = path.join(out, filename);
  safeWriteFile(savePath, data);

  // Update Manifest
  const newEntry = {
    timestamp: new Date().toISOString(),
    localFile: filename,
    hash: currentHash,
    contentType: contentType,
    size: data.length,
    statusCode: statusCode,
  };

  history.latest = newEntry;
  history.history.push(newEntry);
  manifest[url] = history;

  saveManifest(out, manifest);

  return { url, savedTo: savePath, size: data.length, contentType, hash: currentHash };
});
