const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const mime = require('mime-types');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Source URL to fetch',
        demandOption: true
    })
    .option('out', {
        alias: 'o',
        type: 'string',
        description: 'Output directory',
        demandOption: true
    })
    .option('name', {
        alias: 'n',
        type: 'string',
        description: 'Output filename (optional)'
    })
    .option('force', {
        alias: 'f',
        type: 'boolean',
        description: 'Force download ignoring cache/manifest',
        default: false
    })
    .argv;

const MANIFEST_FILE = 'manifest.json';

function calculateHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function getManifest(outDir) {
    const manifestPath = path.join(outDir, MANIFEST_FILE);
    if (fs.existsSync(manifestPath)) {
        try {
            return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (e) {
            console.warn("Warning: existing manifest is corrupt. Starting fresh.");
        }
    }
    return {};
}

function saveManifest(outDir, manifest) {
    fs.writeFileSync(path.join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

async function collect() {
    const { url, out, name, force } = argv;

    // Ensure output directory exists
    if (!fs.existsSync(out)) {
        fs.mkdirSync(out, { recursive: true });
    }

    const manifest = getManifest(out);
    const history = manifest[url] || { history: [] };
    const lastEntry = history.history.length > 0 ? history.history[history.history.length - 1] : null;

    console.log(`Fetching: ${url}`);
    
    try {
        let data, contentType, statusCode;

        if (url.startsWith('http://') || url.startsWith('https://')) {
            // HTTP/HTTPS Request
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                validateStatus: (status) => status < 400
            });
            data = response.data;
            contentType = response.headers['content-type'];
            statusCode = response.status;
        } else {
            // Local File Request
            let localPath = url;
            if (url.startsWith('file://')) {
                localPath = new URL(url).pathname;
            }
            
            // Resolve relative paths based on CWD if necessary, currently treating as provided
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
            console.log("Skipping: Content has not changed (Hash match).");
            return;
        }

        // Determine filename
        let filename = name;
        if (!filename) {
            // Try to get from URL
            let basename;
            try {
                // Handle file URLs or HTTP URLs
                const urlObj = new URL(url);
                basename = path.basename(urlObj.pathname);
            } catch (e) {
                // Handle simple paths
                basename = path.basename(url);
            }

            if (basename && basename.includes('.')) {
                filename = basename;
            } else {
                // Guess extension
                const ext = mime.extension(contentType) || 'dat';
                filename = `data_${Date.now()}.${ext}`;
            }
        }
        
        // Avoid overwriting history files if we want to keep versions?
        // For this version, we overwrite the "current" file but log it in manifest.
        // User requirement: "Store info". We will save as specified filename.
        
        const savePath = path.join(out, filename);
        fs.writeFileSync(savePath, data);

        // Update Manifest
        const newEntry = {
            timestamp: new Date().toISOString(),
            localFile: filename,
            hash: currentHash,
            contentType: contentType,
            size: data.length,
            statusCode: statusCode
        };

        history.latest = newEntry;
        history.history.push(newEntry);
        manifest[url] = history;

        saveManifest(out, manifest);

        console.log(`Saved to: ${savePath}`);
        console.log(`Metadata updated in ${path.join(out, MANIFEST_FILE)}`);

    } catch (error) {
        console.error(`Failed to fetch ${url}:`, error.message);
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
        }
        process.exit(1);
    }
}

collect();
