/**
 * services/checksum.js — SHA256 Checksum Verification
 * 
 * Design Decision: Stream-based hashing for large files (ISOs can be 2+ GB).
 * Reports progress during hash computation so the user sees it working.
 */

const crypto = require('crypto');
const fs = require('fs');
const logger = require('../core/logger');

/**
 * Compute SHA256 hash of a file using streams.
 * Emits progress callbacks for large files.
 * 
 * @param {string} filePath - Absolute path to the file
 * @param {function} [onProgress] - Callback(percentage) for progress updates
 * @returns {Promise<string>} Lowercase hex SHA256 hash
 */
async function computeSHA256(filePath, onProgress = null) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    let totalBytes = 0;
    let processedBytes = 0;

    // Get file size for progress reporting
    try {
      const stats = fs.statSync(filePath);
      totalBytes = stats.size;
    } catch (err) {
      return reject(new Error(`Cannot read file: ${filePath} — ${err.message}`));
    }

    logger.info('Checksum', `Computing SHA256 for: ${filePath} (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);

    stream.on('data', (chunk) => {
      hash.update(chunk);
      processedBytes += chunk.length;

      if (onProgress && totalBytes > 0) {
        const percent = Math.round((processedBytes / totalBytes) * 100);
        onProgress(percent);
      }
    });

    stream.on('end', () => {
      const digest = hash.digest('hex');
      logger.success('Checksum', `SHA256: ${digest}`);
      resolve(digest);
    });

    stream.on('error', (err) => {
      logger.error('Checksum', `Hash computation failed: ${err.message}`);
      reject(new Error(`Failed to hash file: ${err.message}`));
    });
  });
}

/**
 * Verify a file's SHA256 hash against an expected value.
 * 
 * @param {string} filePath - Absolute path to the file
 * @param {string} expectedHash - Expected SHA256 hash (hex)
 * @param {function} [onProgress] - Progress callback
 * @returns {Promise<boolean>} True if hash matches
 */
async function verifySHA256(filePath, expectedHash, onProgress = null) {
  logger.info('Checksum', `Verifying checksum for: ${filePath}`);
  logger.info('Checksum', `Expected: ${expectedHash}`);

  const actualHash = await computeSHA256(filePath, onProgress);
  const match = actualHash.toLowerCase() === expectedHash.toLowerCase();

  if (match) {
    logger.success('Checksum', 'Checksum verification PASSED ✓');
  } else {
    logger.error('Checksum', `Checksum MISMATCH — Expected: ${expectedHash}, Got: ${actualHash}`);
  }

  return match;
}

/**
 * Parse a SHA256SUMS file (Ubuntu format) and extract hash for a specific filename.
 * Format: "<hash> *<filename>" or "<hash>  <filename>"
 * 
 * @param {string} sha256sumsContent - Content of SHA256SUMS file
 * @param {string} targetFilename - Filename to find hash for
 * @returns {string|null} Hash if found, null otherwise
 */
function parseHashFromSHA256SUMS(sha256sumsContent, targetFilename) {
  const lines = sha256sumsContent.split('\n');

  for (const line of lines) {
    // Ubuntu SHA256SUMS format: "hash *filename" or "hash  filename"
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/);
    if (match) {
      const [, hash, filename] = match;
      if (filename.trim() === targetFilename) {
        logger.info('Checksum', `Found hash for ${targetFilename}: ${hash}`);
        return hash;
      }
    }
  }

  logger.warn('Checksum', `Hash not found for ${targetFilename} in SHA256SUMS`);
  return null;
}

module.exports = {
  computeSHA256,
  verifySHA256,
  parseHashFromSHA256SUMS
};
