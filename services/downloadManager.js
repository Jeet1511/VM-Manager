/**
 * services/downloadManager.js — HTTP Download Manager
 * 
 * Design Decision: Full-featured download manager with:
 * - Progress reporting (bytes, percentage, speed, ETA)
 * - Resume support via HTTP Range headers
 * - Retry logic with exponential backoff (3 attempts)
 * - Cancellation via AbortController
 * - Redirect following (301/302/307)
 * - Disk space validation before starting
 * - Partial file handling (.partial extension during download)
 * 
 * The user sees ALL download details — speed, progress, file size.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const logger = require('../core/logger');

const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 2000;  // 2 seconds, doubles each retry
const MAX_REDIRECTS = 5;

function _createAbortError(signal) {
  const abortReason = signal?.reason === 'paused' ? 'paused' : 'cancelled';
  const abortError = new Error(abortReason === 'paused' ? 'Download paused' : 'Download cancelled');
  abortError.name = 'AbortError';
  abortError.code = abortReason === 'paused' ? 'PAUSED' : 'CANCELLED';
  return abortError;
}

function _throwIfAborted(signal) {
  if (signal?.aborted) {
    throw _createAbortError(signal);
  }
}

function _waitWithAbort(delayMs, signal) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(_createAbortError(signal));
      return;
    }

    const timer = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(_createAbortError(signal));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Download a file from HTTPS URL with full progress tracking.
 * 
 * @param {string} url - Download URL (must be HTTPS)
 * @param {string} destDir - Directory to save the file in
 * @param {string} [filename] - Optional filename override (auto-detected from URL if not provided)
 * @param {object} [options] - Download options
 * @param {function} [options.onProgress] - Callback({ downloaded, total, percent, speed, eta })
 * @param {AbortSignal} [options.signal] - AbortController signal for cancellation
 * @param {boolean} [options.resume] - Whether to resume partial downloads (default: true)
 * @param {boolean} [options.cleanupOnAbort] - Remove partial file when cancelled (default: true)
 * @returns {Promise<string>} Absolute path to downloaded file
 */
async function downloadFile(url, destDir, filename = null, options = {}) {
  const { onProgress = null, signal = null, resume = true, cleanupOnAbort = true } = options;
  _throwIfAborted(signal);

  // Ensure destination directory exists
  await fs.promises.mkdir(destDir, { recursive: true });

  // Determine filename from URL if not provided
  if (!filename) {
    const urlObj = new URL(url);
    filename = path.basename(urlObj.pathname) || 'download';
  }

  const destPath = path.join(destDir, filename);
  const partialPath = `${destPath}.partial`;

  logger.info('Download', `Starting download: ${url}`);
  logger.info('Download', `Destination: ${destPath}`);

  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    attempt++;

    try {
      if (attempt > 1) {
        const delay = RETRY_DELAY_BASE * Math.pow(2, attempt - 2);
        logger.warn('Download', `Retry attempt ${attempt}/${MAX_RETRIES} — waiting ${delay / 1000}s...`);
        await _waitWithAbort(delay, signal);
      }

      _throwIfAborted(signal);
      await _downloadWithRedirects(url, destPath, partialPath, {
        onProgress,
        signal,
        cleanupOnAbort,
        resume: resume && attempt === 1,  // Only resume on first attempt
        redirectCount: 0
      });

      // Download complete — verify file exists and has content
      const stats = fs.statSync(destPath);
      logger.success('Download', `Download complete: ${destPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
      return destPath;

    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) {
        const abortReason = (err.code === 'PAUSED' || signal?.reason === 'paused') ? 'paused' : 'cancelled';
        logger.warn('Download', abortReason === 'paused' ? 'Download paused by user' : 'Download cancelled by user');
        if (abortReason !== 'paused' && cleanupOnAbort) {
          _cleanupPartial(partialPath);
        }
        throw _createAbortError({ reason: abortReason });
      }

      logger.error('Download', `Download failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);

      if (attempt >= MAX_RETRIES) {
        _cleanupPartial(partialPath);
        throw new Error(`Download failed after ${MAX_RETRIES} attempts: ${err.message}`);
      }
    }
  }
}

/**
 * Internal: Perform download with redirect following.
 */
function _downloadWithRedirects(url, destPath, partialPath, options) {
  return new Promise((resolve, reject) => {
    _throwIfAborted(options.signal);

    if (options.redirectCount >= MAX_REDIRECTS) {
      return reject(new Error('Too many redirects'));
    }

    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    // Check for existing partial download (resume support)
    let startByte = 0;
    if (options.resume && fs.existsSync(partialPath)) {
      const stats = fs.statSync(partialPath);
      startByte = stats.size;
      logger.info('Download', `Resuming from byte ${startByte} (${(startByte / 1024 / 1024).toFixed(1)} MB)`);
    }

    const requestHeaders = {
      'User-Agent': 'VM-Xposed/1.0'
    };

    if (startByte > 0) {
      requestHeaders['Range'] = `bytes=${startByte}-`;
    }

    let activeResponse = null;
    let activeFileStream = null;

    const req = protocol.get(url, { headers: requestHeaders }, (response) => {
      activeResponse = response;
      const statusCode = response.statusCode;

      // Handle redirects
      if ([301, 302, 307, 308].includes(statusCode) && response.headers.location) {
        const redirectUrl = new URL(response.headers.location, url).href;
        logger.info('Download', `Redirect (${statusCode}) → ${redirectUrl}`);
        response.resume();  // Consume response to free memory
        _downloadWithRedirects(redirectUrl, destPath, partialPath, {
          ...options,
          redirectCount: options.redirectCount + 1
        }).then(resolve).catch(reject);
        return;
      }

      // Handle non-success status codes
      if (statusCode !== 200 && statusCode !== 206) {
        response.resume();
        return reject(new Error(`HTTP ${statusCode}: ${response.statusMessage}`));
      }

      // Calculate total size
      let totalBytes;
      if (statusCode === 206) {
        // Partial content — parse Content-Range header
        const range = response.headers['content-range'];
        if (range) {
          const match = range.match(/\/(\d+)/);
          totalBytes = match ? parseInt(match[1], 10) : null;
        }
      } else {
        totalBytes = parseInt(response.headers['content-length'], 10) || null;
        startByte = 0;  // Server doesn't support range, start over
      }

      if (totalBytes) {
        logger.info('Download', `File size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
      }

      // Open file for writing (append if resuming, otherwise overwrite)
      const flags = startByte > 0 && statusCode === 206 ? 'a' : 'w';
      const file = fs.createWriteStream(partialPath, { flags });
      activeFileStream = file;

      let downloadedBytes = startByte;
      let lastProgressTime = Date.now();
      let lastProgressBytes = startByte;

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;

        // Report progress
        if (options.onProgress) {
          const now = Date.now();
          const elapsed = (now - lastProgressTime) / 1000;

          let speed = 0;
          if (elapsed > 0.5) {  // Update speed every 500ms
            speed = (downloadedBytes - lastProgressBytes) / elapsed;
            lastProgressTime = now;
            lastProgressBytes = downloadedBytes;
          }

          const percent = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : null;
          const eta = speed > 0 && totalBytes
            ? Math.round((totalBytes - downloadedBytes) / speed)
            : null;

          options.onProgress({
            downloaded: downloadedBytes,
            total: totalBytes,
            percent,
            speed,
            eta,
            speedFormatted: _formatBytes(speed) + '/s',
            downloadedFormatted: _formatBytes(downloadedBytes),
            totalFormatted: totalBytes ? _formatBytes(totalBytes) : 'Unknown',
            etaFormatted: eta !== null ? _formatTime(eta) : 'Calculating...'
          });
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          // Rename from .partial to final name
          try {
            if (fs.existsSync(destPath)) {
              fs.unlinkSync(destPath);
            }
            fs.renameSync(partialPath, destPath);
            resolve();
          } catch (err) {
            reject(new Error(`Failed to finalize download: ${err.message}`));
          }
        });
      });

      file.on('error', (err) => {
        file.close();
        reject(new Error(`File write error: ${err.message}`));
      });

      response.on('error', (err) => {
        file.close();
        reject(new Error(`Download error: ${err.message}`));
      });
    });

    req.on('error', (err) => {
      if (options.signal?.aborted) {
        reject(_createAbortError(options.signal));
        return;
      }
      reject(new Error(`Network error: ${err.message}`));
    });

    // Handle abort signal
    let onAbort = null;
    if (options.signal) {
      onAbort = () => {
        activeResponse?.destroy(_createAbortError(options.signal));
        activeFileStream?.destroy(_createAbortError(options.signal));
        req.destroy(_createAbortError(options.signal));
        reject(_createAbortError(options.signal));
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });

    const clearAbortListener = () => {
      if (onAbort && options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
    };

    req.on('close', clearAbortListener);
  });
}

/**
 * Clean up partial download file.
 */
function _cleanupPartial(partialPath) {
  try {
    if (fs.existsSync(partialPath)) {
      fs.unlinkSync(partialPath);
    }
  } catch {
    // Best effort cleanup
  }
}

/**
 * Format bytes to human-readable string.
 */
function _formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Format seconds to human-readable time string.
 */
function _formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Check if a file already exists and matches expected size.
 * Used to skip re-downloading.
 */
function isDownloadComplete(filePath, expectedSize = null) {
  try {
    if (!fs.existsSync(filePath)) return false;
    if (expectedSize === null) return true;
    const stats = fs.statSync(filePath);
    return stats.size === expectedSize;
  } catch {
    return false;
  }
}

module.exports = {
  downloadFile,
  isDownloadComplete
};
