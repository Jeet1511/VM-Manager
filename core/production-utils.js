/**
 * core/production-utils.js
 * 
 * Production-safe utilities for path resolution, file operations, and security.
 * All development-only assumptions replaced with production-safe implementations.
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const os = require('os');

// ─── SAFE PATH RESOLUTION ─────────────────────────────────────────────────────

/**
 * Get resource path that works in both development and production (ASAR-packaged).
 * In dev: returns __dirname relative path
 * In prod: returns process.resourcesPath or extraResources path
 */
function getResourcePath(relativePath = '') {
  if (!app.isPackaged) {
    // Development: use __dirname relative to app root
    return path.join(__dirname, '..', relativePath);
  }

  // Production: resources are in extraResources folder or root
  // electron-builder extracts extraResources outside ASAR
  const resourcesPath = process.resourcesPath;
  if (resourcesPath) {
    return path.join(resourcesPath, relativePath);
  }

  // Fallback: use app directory
  return path.join(app.getAppPath(), relativePath);
}

/**
 * Get user data directory safely (respects platform conventions)
 */
function getAppDataDir() {
  return app.getPath('userData');
}

/**
 * Get temporary directory safely
 */
function getTempDir() {
  return app.getPath('temp');
}

/**
 * Get downloads directory safely
 */
function getDownloadsDir() {
  return app.getPath('downloads');
}

/**
 * Get logs directory safely
 */
function getLogsDir() {
  const appDataDir = getAppDataDir();
  return path.join(appDataDir, 'logs');
}

/**
 * Ensure directory exists synchronously
 */
function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Ensure directory exists asynchronously
 */
async function ensureDir(dirPath) {
  return fs.promises.mkdir(dirPath, { recursive: true });
}

// ─── SECURITY UTILITIES ─────────────────────────────────────────────────────────

/**
 * Validate that a path is within allowed boundaries (path traversal prevention)
 */
function validatePath(candidatePath, allowedRoots = []) {
  if (!candidatePath || typeof candidatePath !== 'string') {
    throw new Error('Invalid path: must be non-empty string');
  }

  const normalized = path.resolve(candidatePath);
  
  // If no roots specified, allow any path under user home/temp/appdata
  if (!allowedRoots || allowedRoots.length === 0) {
    const homeDir = os.homedir();
    const tempDir = getTempDir();
    const appDataDir = getAppDataDir();
    allowedRoots = [homeDir, tempDir, appDataDir];
  }

  const isAllowed = allowedRoots.some(root => {
    const normalizedRoot = path.resolve(root);
    return (
      normalized === normalizedRoot ||
      normalized.startsWith(normalizedRoot + path.sep)
    );
  });

  if (!isAllowed) {
    throw new Error(`Path escape attempt detected: ${candidatePath} not in allowed roots`);
  }

  return normalized;
}

/**
 * Validate URL against whitelist of trusted domains
 */
function validateDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    
    const trustedHosts = [
      'raw.githubusercontent.com',
      'releases.ubuntu.com',
      'cdimage.debian.org',
      'download.fedoraproject.org',
      'mirror.example.com',
      'linuxmint.com'
    ];

    const isAllowed = trustedHosts.some(host => 
      parsed.hostname === host || parsed.hostname.endsWith('.' + host)
    );

    if (!isAllowed) {
      throw new Error(`Untrusted download host: ${parsed.hostname}`);
    }

    return parsed.href;
  } catch (err) {
    throw new Error(`Invalid download URL: ${err.message}`);
  }
}

/**
 * Sanitize filename to prevent directory traversal
 */
function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Invalid filename: must be non-empty string');
  }

  // Remove path separators and parent directory references
  return filename
    .replace(/\.\./g, '')
    .replace(/[\/\\]/g, '_')
    .replace(/^\./, '')
    .trim();
}

/**
 * Construct safe download destination path
 */
function getDownloadDestination(downloadDir, filename) {
  const sanitized = sanitizeFilename(filename);
  const validated = validatePath(downloadDir, [getDownloadsDir(), getTempDir(), getAppDataDir()]);
  
  return {
    filePath: path.join(validated, sanitized),
    partialPath: path.join(validated, `${sanitized}.partial`)
  };
}

// ─── VIRTUALBOX PATH RESOLUTION ─────────────────────────────────────────────────

/**
 * Find VirtualBox installation on Windows using environment variables and registry.
 * This replaces hardcoded paths and works on non-English Windows.
 */
function findVirtualBoxOnWindows() {
  const candidates = [];

  // Try environment variables (most reliable)
  if (process.env['VBOX_INSTALL_PATH']) {
    candidates.push(path.join(process.env['VBOX_INSTALL_PATH'], 'VBoxManage.exe'));
  }

  if (process.env['VBOX_MSI_INSTALL_PATH']) {
    candidates.push(path.join(process.env['VBOX_MSI_INSTALL_PATH'], 'VBoxManage.exe'));
  }

  // Try common installation paths (including non-English)
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  candidates.push(
    path.join(programFiles, 'Oracle', 'VirtualBox', 'VBoxManage.exe'),
    path.join(programFilesX86, 'Oracle', 'VirtualBox', 'VBoxManage.exe')
  );

  // Try PATH environment variable
  const pathDirs = (process.env['PATH'] || '').split(path.delimiter);
  pathDirs.forEach(dir => {
    candidates.push(path.join(dir, 'VBoxManage.exe'));
  });

  // Test each candidate
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Continue to next candidate
    }
  }

  return null;
}

/**
 * Find VirtualBox configuration directory
 */
function getVirtualBoxConfigDir() {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), '.VirtualBox');
  }
  // Linux/macOS
  return path.join(os.homedir(), '.VirtualBox');
}

/**
 * Get VirtualBox config file path
 */
function getVirtualBoxConfigFile() {
  return path.join(getVirtualBoxConfigDir(), 'VirtualBox.xml');
}

// ─── ASSET PATH RESOLUTION ─────────────────────────────────────────────────────

/**
 * Get icon path (works in both dev and prod)
 */
function getAppIconPath() {
  const candidates = [
    getResourcePath('logos/icon-app.ico'),
    getResourcePath('icons/icon-app.ico'),
    getResourcePath('assets/icon.ico'),
    getResourcePath('icon.ico')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback: return first candidate even if it doesn't exist
  // (Electron will use default icon)
  return candidates[0];
}

/**
 * Get HTML file path (for loadFile)
 */
function getRendererHtmlPath() {
  const htmlPath = getResourcePath('renderer/index.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Renderer HTML not found at: ${htmlPath}`);
  }
  return htmlPath;
}

/**
 * Get preload script path (for preload)
 */
function getPreloadScriptPath() {
  // Preload must be outside ASAR for security
  // electron-builder moves it to extraResources
  const preloadPath = getResourcePath('preload.js');
  if (!fs.existsSync(preloadPath)) {
    throw new Error(`Preload script not found at: ${preloadPath}`);
  }
  return preloadPath;
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  // Path resolution
  getResourcePath,
  getAppDataDir,
  getTempDir,
  getDownloadsDir,
  getLogsDir,
  ensureDirSync,
  ensureDir,

  // Security
  validatePath,
  validateDownloadUrl,
  sanitizeFilename,
  getDownloadDestination,

  // VirtualBox
  findVirtualBoxOnWindows,
  getVirtualBoxConfigDir,
  getVirtualBoxConfigFile,

  // Assets
  getAppIconPath,
  getRendererHtmlPath,
  getPreloadScriptPath
};
