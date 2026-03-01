#!/usr/bin/env node
/**
 * Visual Imagination Skill v1.0
 * Generates and edits images via Gemini Image API.
 */

const { runSkill } = require('../../../scripts/lib/skill-wrapper.cjs');
const { logger, pathResolver, safeWriteFile } = require('../../../libs/core/core.cjs');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); // Use axios for REST API calls to Image API

runSkill('visual-imagination', async (args) => {
  const prompt = args.prompt || args._[0];
  const baseFile = args.file;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set.');
  }

  if (!prompt) {
    throw new Error('Prompt is required for image generation.');
  }

  const outDir = pathResolver.active('shared/imaginations');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const filename = `imagination_${Date.now()}.png`;
  const outputPath = path.join(outDir, filename);

  logger.info(`🎨 Imagining: "${prompt}"...`);

  try {
    // Current Gemini Image API (Imagen 3) implementation via REST
    // Note: This follows the official Google AI Studio REST protocol
    const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3:predict?key=${apiKey}`;
    
    const payload = {
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: "1:1",
        outputMimeType: "image/png"
      }
    };

    const response = await axios.post(url, payload);
    
    if (response.data && response.data.predictions && response.data.predictions[0]) {
      const b64Data = response.data.predictions[0].bytesBase64Encoded;
      const buffer = Buffer.from(b64Data, 'base64');
      
      fs.writeFileSync(outputPath, buffer);
      logger.success(`✅ Imagination captured: ${filename}`);

      return {
        id: filename,
        path: outputPath,
        prompt,
        status: 'success'
      };
    } else {
      throw new Error('Failed to receive image data from API.');
    }
  } catch (err) {
    logger.error(`Imagination Failure: ${err.message}`);
    if (err.response?.data) {
      logger.error('API Error Details: ' + JSON.stringify(err.response.data));
    }
    throw err;
  }
});
