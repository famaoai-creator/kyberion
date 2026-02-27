const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import axios from 'axios';
import * as mime from 'mime-types';

export interface ManifestEntry {
  timestamp: string;
  localFile: string;
  hash: string;
  contentType: string;
  size: number;
  statusCode: number;
}

export interface Manifest {
  [url: string]: {
    latest: ManifestEntry;
    history: ManifestEntry[];
  };
}

export function calculateHash(buffer: Buffer | ArrayBuffer): string {
  // Use any to bypass overload resolution issues in specific TS versions
  const buf = buffer instanceof Buffer ? buffer : Buffer.from(buffer as any);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export async function collectData(
  url: string,
  outDir: string,
  options: { name?: string; force?: boolean } = {}
): Promise<any> {
  const { name, force = false } = options;
  const manifestPath = path.join(outDir, 'manifest.json');

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  let manifest: Manifest = {};
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(safeReadFile(manifestPath, 'utf8'));
    } catch (_e) {
      // ignore
    }
  }

  const history = manifest[url] || { history: [] };
  const lastEntry = history.history.length > 0 ? history.history[history.history.length - 1] : null;

  let data: any, contentType: string, statusCode: number;

  if (url.startsWith('http://') || url.startsWith('https://')) {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      maxContentLength: 100 * 1024 * 1024,
    });
    data = response.data;
    contentType = response.headers['content-type'] as string;
    statusCode = response.status;
  } else {
    let localPath = url.startsWith('file://') ? new URL(url).pathname : url;
    if (!fs.existsSync(localPath)) throw new Error(`File not found: ${localPath}`);
    data = safeReadFile(localPath);
    contentType = (mime.lookup(localPath) as string) || 'application/octet-stream';
    statusCode = 200;
  }

  const currentHash = calculateHash(data);
  if (!force && lastEntry && lastEntry.hash === currentHash) {
    return { url, skipped: true, reason: 'Unchanged' };
  }

  let filename = name;
  if (!filename) {
    try {
      filename = path.basename(new URL(url).pathname);
    } catch {
      filename = path.basename(url);
    }
    if (!filename || !filename.includes('.')) {
      const ext = mime.extension(contentType) || 'dat';
      filename = `data_${Date.now()}.${ext}`;
    }
  }

  const savePath = path.join(outDir, filename);
  safeWriteFile(savePath, Buffer.from(data));

  const newEntry: ManifestEntry = {
    timestamp: new Date().toISOString(),
    localFile: filename,
    hash: currentHash,
    contentType,
    size: data.byteLength || data.length,
    statusCode,
  };

  history.latest = newEntry;
  history.history.push(newEntry);
  manifest[url] = history;

  safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2));

  return { url, savedTo: savePath, size: newEntry.size, contentType, hash: currentHash };
}
