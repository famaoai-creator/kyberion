---
name: data-collector
description: 
status: implemented
arguments: 
- name: force
short: f
type: boolean
required: false
category: Intelligence
last_updated: '2026-02-28'
tags: data-engineering,gemini-skill
---

# Data Collector

A utility skill to fetch data from remote sources (URLs) and store it locally with rich metadata. It is designed to be the "Extract" part of an ETL pipeline, focusing on reliable data retrieval and change tracking.

## Features

- **Fetch**: Downloads content from HTTP/HTTPS URLs.
- **Traceability**: Saves a `manifest.json` tracking source URL, fetch time, and content headers.
- **Incremental**: Skips download if the remote content hasn't changed (based on Content-Length or ETag/Hash comparison if implemented).

## Usage

```bash
node dist/index.js --url <URL> --out <output_dir> [options]
```

### Options

- `--url`: The source URL to fetch.
- `--out`: Target directory to save the file.
- `--name`: (Optional) Specific filename to save as. If omitted, derived from URL or Content-Disposition.
- `--force`: Force download even if content hasn't changed.

### Example

```bash
# Fetch a user list and save to ./raw_data
node dist/index.js --url "https://jsonplaceholder.typicode.com/users" --out "./raw_data" --name "users.json"
```

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
