---
title: "Standard: PDF 2.0 (ISO 32000-2) for Native PDF Engine"
category: Standards
tags: [standards, media, pdf, iso-32000-2]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-13
---

# Standard: PDF 2.0 (ISO 32000-2) for Native PDF Engine

- **Source**: ISO 32000-2:2020, vault/ISO_32000-2_sponsored-ec2.pdf
- **Context**: Media-Actuator Native PDF Generation & Extraction

## 1. File Structure (§7.5)

### Header
- **`%PDF-2.0`** followed by a binary comment line (`%` + 4 bytes > 0x80)
- The binary comment signals to transport layers that the file contains binary data.

### Cross-Reference Stream (§7.5.8)
PDF 2.0 replaces the legacy `xref` table + `trailer` dictionary with a single **Cross-Reference Stream** object:
- `/Type /XRef` — identifies the stream as a cross-reference
- `/W [w1 w2 w3]` — byte widths for each entry field
- `/Size N` — total number of objects
- `/Root`, `/Info` — formerly in the trailer dict, now in the stream dict
- Stream data: binary entries, optionally FlateDecode compressed

**Entry types** (field 1):
| Type | Meaning | Field 2 | Field 3 |
|------|---------|---------|---------|
| 0 | Free | Next free obj | Generation |
| 1 | In-use | Byte offset | Generation |
| 2 | Compressed | Object stream ID | Index within stream |

### Implementation Pattern
```
/W [1 4 1]  →  type(1 byte) + offset(4 bytes) + gen(1 byte) = 6 bytes/entry
```

## 2. Text & Encoding (§7.3, §7.9)

### String Objects
- **Literal strings**: `(text)` — ASCII-safe
- **Hex strings**: `<FEFF...>` — UTF-16BE with BOM for Unicode

### Content Stream Text Operators
- `Tj` — show string: `(text) Tj` or `<hex> Tj`
- `TJ` — show array: `[(text) -100 <hex>] TJ`
- `Td` — move to position: `x y Td`
- `Tf` — set font: `/F1 12 Tf`

## 3. Stream Compression (§7.3.8)

### FlateDecode
- `/Filter /FlateDecode` on stream dictionaries
- zlib deflate/inflate for compression/decompression
- `/Length` refers to compressed byte count

## 4. Metadata (§14.3)

### XMP Metadata (Preferred in PDF 2.0)
- `<x:xmpmeta>` XML block embedded in a metadata stream
- Namespaces: `dc:` (Dublin Core), `xmp:` (XMP Core), `pdf:` (PDF)
- Fields: `dc:title`, `dc:creator`, `xmp:CreateDate`, `pdf:Producer`

### Info Dictionary (Legacy, still valid)
- `/Title`, `/Author`, `/Producer`, `/CreationDate`
- String values may use hex encoding for Unicode

## 5. Kyberion Implementation Pattern (v3.0 Engine)

- [x] `%PDF-2.0` header with binary marker
- [x] Cross-Reference Stream with `/W [1 4 1]` + FlateDecode
- [x] FlateDecode compression on content streams (configurable)
- [x] UTF-16BE hex string encoding for non-ASCII text
- [x] Input validation (source.body, output directory)
- [x] Parser: XRef stream decoding, XMP metadata, hex Tj operator
