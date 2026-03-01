---
name: visual-imagination
description: Generates and edits images using Google Gemini Image API (Imagen).
status: implemented
category: imagination
r: high
---

# Visual Imagination

Leverages the Gemini Image API to bring ideas to life.

## Actions
- `generate`: Create an image from a prompt.
- `edit`: Modify an existing image (Inpainting/Style Transfer).

## Arguments
- `--prompt`: The description of the image.
- `--file`: (Optional) Base image for editing.
- `--out`: (Optional) Custom output path.

## Examples
```bash
node scripts/cli.cjs run visual-imagination --prompt "An anime style portrait of a cyber-architect"
```
