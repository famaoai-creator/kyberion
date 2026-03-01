#!/usr/bin/env node
/**
 * Visual Imagination Skill v1.1 (@agent/core Edition)
 * Generates and edits images via Gemini Image API using unified core libraries.
 */

const { runSkill } = require('@agent/core');
const { logger } = require('@agent/core/core');
const { safeWriteFile } = require('@agent/core/secure-io');
const pathResolver = require('@agent/core/path-resolver');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

runSkill('visual-imagination', async (args) => {
  const prompt = args.prompt || args._[0];
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set. Please add it to your Personal Tier.');
  }

  if (!prompt) {
    throw new Error('Prompt is required for image generation.');
  }

  // Use pathResolver to identify the correct active artifacts directory
  const outDir = pathResolver.active('shared/imaginations');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const filename = `imagination_${Date.now()}.png`;
  const outputPath = path.join(outDir, filename);

  logger.info(`🎨 [Imagination] Constructing visual reality: "${prompt}"...`);

  try {
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
      
      // Use @agent/core/secure-io for governance-compliant file writing
      safeWriteFile(outputPath, buffer);
      
      logger.success(`✅ Imagination materialized: ${filename}`);

      return {
        skill: 'visual-imagination',
        status: 'success',
        data: {
          id: filename,
          path: outputPath,
          prompt
        }
      };
    } else {
      throw new Error('Incomplete response from Gemini Image API.');
    }
  } catch (err) {
    logger.error(`Imagination Failure: ${err.message}`);
    throw err;
  }
});
