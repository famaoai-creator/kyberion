/**
 * scripts/lib/network.cjs
 * Standardized network utilities for Gemini Skills.
 */
const axios = require('axios');

/**
 * Perform a secure and tracked HTTP request.
 * @param {Object} options - Axios-compatible options
 * @returns {Promise<Object>} Response data
 */
async function secureFetch(options) {
  try {
    const response = await axios({
      timeout: 10000,
      headers: {
        'User-Agent': 'Gemini-Agent/1.0.0',
      },
      ...options,
    });
    return response.data;
  } catch (err) {
    throw new Error(
      `Network Error: ${err.message}${err.response ? ` (${err.response.status})` : ''}`
    );
  }
}

module.exports = { secureFetch };
