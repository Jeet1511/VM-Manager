/**
 * main.js — Electron Main Process
 */

// Catch any uncaught errors early
process.on('uncaughtException', (err) => {
  console.error('FATAL ERROR:', err.message);
  console.error(err.stack);
});

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeImage, screen, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, exec, execFile, execFileSync, spawn, spawnSync } = require('child_process');
const os = require('os');
const https = require('https');
const { URL } = require('url');
const logger = require('./core/logger');
const orchestrator = require('./core/orchestrator');
const { UBUNTU_RELEASES, OS_CATALOG, VM_DEFAULTS, getDefaultInstallPath, getDefaultSharedFolderPath, getOSCategories, getDownloadDir } = require('./core/config');
const { runSystemCheck } = require('./services/systemChecker');
const { refreshOfficialCatalog } = require('./services/osCatalogUpdater');
const virtualbox = require('./adapters/virtualbox');
const bootFixer = require('./vm/bootFixer');
const accountManager = require('./vm/accountManager');
const { configureGuestFeatures, configureGuestInside } = require('./vm/guestAdditions');
const { setupSharedFolder } = require('./vm/sharedFolder');

// Production-safe utilities for path resolution and security
const prodUtils = require('./core/production-utils');
const adminElevate = require('./core/admin-elevate');

let mainWindow = null;
let runtimeOSCatalog = { ...OS_CATALOG };
let isCatalogRefreshRunning = false;
let catalogRefreshTimer = null;
let isExitShutdownInProgress = false;
const runtimeIntegrationQueue = new Map();
const runtimeIntegrationLastScheduledAt = new Map();
const runtimeIntegrationRetryCounts = new Map();
const vmLastKnownState = new Map();
const VBOX_RUNTIME_BLOCKER_TTL_MS = 10 * 60 * 1000;
const VM_START_FAILURE_TTL_MS = 10 * 60 * 1000;
let lastVBoxRuntimeBlocker = null;
let lastVmStartFailure = null;
const LINUX_GUEST_USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);
const MIN_SUPPORTED_ISO_BYTES = 80 * 1024 * 1024;

function getCatalogCacheFilePath() {
  return path.join(app.getPath('userData'), 'os-catalog-cache.json');
}

function readCatalogCacheFromDisk() {
  try {
    const cachePath = getCatalogCacheFilePath();
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const catalog = parsed.catalog;
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
      return null;
    }

    return {
      catalog,
      updatedAt: parsed.updatedAt || null
    };
  } catch {
    return null;
  }
}

async function writeCatalogCacheToDisk(catalog) {
  const cachePath = getCatalogCacheFilePath();
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.promises.writeFile(
    cachePath,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      catalog: catalog || {}
    }, null, 2),
    'utf8'
  );
}

async function persistRuntimeCatalog(reason = 'update') {
  try {
    await writeCatalogCacheToDisk(runtimeOSCatalog);
    logger.debug('CatalogUpdater', `Catalog cache saved (${reason}).`);
  } catch (err) {
    logger.warn('CatalogUpdater', `Failed to save catalog cache (${reason}): ${err.message}`);
  }
}

function loadRuntimeCatalogFromCache() {
  const cached = readCatalogCacheFromDisk();
  if (!cached?.catalog) return false;

  runtimeOSCatalog = {
    ...OS_CATALOG,
    ...cached.catalog
  };

  logger.info(
    'CatalogUpdater',
    `Loaded cached OS catalog (${Object.keys(runtimeOSCatalog).length} entries${cached.updatedAt ? `, updated ${cached.updatedAt}` : ''}).`
  );
  return true;
}

function getUiPrefsFilePath() {
  return path.join(app.getPath('userData'), 'ui-prefs.json');
}

let uiPrefsWriteQueue = Promise.resolve();

function readUiPrefsFromDisk() {
  try {
    const prefsPath = getUiPrefsFilePath();
    if (!fs.existsSync(prefsPath)) return {};
    const raw = fs.readFileSync(prefsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const prefs = (parsed && typeof parsed === 'object') ? parsed : {};
    prefs.theme = 'dark';
    prefs.visualEffectsMode = String(prefs.visualEffectsMode || '').trim().toLowerCase() === 'full' ? 'full' : 'lite';
    prefs.defaultUserUsername = String(prefs.defaultUserUsername || 'user').trim() || 'user';
    prefs.defaultUserPassword = String(prefs.defaultUserPassword ?? '');
    prefs.guestUsername = String(prefs.guestUsername || prefs.username || 'guest').trim() || 'guest';
    prefs.guestPassword = String(prefs.guestPassword ?? prefs.password ?? '');
    prefs.username = prefs.guestUsername;
    prefs.password = prefs.guestPassword;
    prefs.language = ['en', 'hi'].includes(String(prefs.language || '').toLowerCase()) ? String(prefs.language).toLowerCase() : 'en';
    prefs.startupView = ['dashboard', 'machines', 'wizard', 'library', 'snapshots', 'storage', 'network', 'settings', 'download', 'credits'].includes(String(prefs.startupView || '').toLowerCase())
      ? String(prefs.startupView).toLowerCase()
      : 'dashboard';
    prefs.notificationLevel = ['all', 'important', 'minimal'].includes(String(prefs.notificationLevel || '').toLowerCase())
      ? String(prefs.notificationLevel).toLowerCase()
      : 'important';
    prefs.adminModePolicy = 'manual';
    prefs.autoRepairLevel = ['none', 'safe', 'full'].includes(String(prefs.autoRepairLevel || '').toLowerCase())
      ? String(prefs.autoRepairLevel).toLowerCase()
      : 'safe';
    prefs.maxHostRamPercent = Math.max(40, Math.min(95, parseInt(prefs.maxHostRamPercent, 10) || 75));
    prefs.maxHostCpuPercent = Math.max(40, Math.min(95, parseInt(prefs.maxHostCpuPercent, 10) || 75));
    prefs.vmDefaultPreset = ['beginner', 'balanced', 'advanced'].includes(String(prefs.vmDefaultPreset || '').toLowerCase())
      ? String(prefs.vmDefaultPreset).toLowerCase()
      : 'balanced';
    prefs.credentialStorage = ['keychain', 'session'].includes(String(prefs.credentialStorage || '').toLowerCase())
      ? String(prefs.credentialStorage).toLowerCase()
      : 'keychain';
    prefs.telemetryEnabled = prefs.telemetryEnabled === true;
    prefs.trustedPaths = String(prefs.trustedPaths || '').trim();
    prefs.logLevel = ['error', 'warning', 'info', 'debug'].includes(String(prefs.logLevel || '').toLowerCase())
      ? String(prefs.logLevel).toLowerCase()
      : 'info';
    prefs.logRetentionDays = Math.max(1, Math.min(365, parseInt(prefs.logRetentionDays, 10) || 14));
    return prefs;
  } catch {
    return {};
  }
}

async function writeUiPrefsToDisk(prefs) {
  const prefsPath = getUiPrefsFilePath();
  const writeTask = async () => {
    await fs.promises.mkdir(path.dirname(prefsPath), { recursive: true });
    await fs.promises.writeFile(prefsPath, JSON.stringify(prefs, null, 2), 'utf8');
  };

  uiPrefsWriteQueue = uiPrefsWriteQueue.then(writeTask, writeTask);
  return uiPrefsWriteQueue;
}

function getCategoriesFromCatalog(catalog) {
  const categories = {};
  for (const [name, info] of Object.entries(catalog || {})) {
    const category = info.category || 'Other';
    if (!categories[category]) categories[category] = [];
    categories[category].push(name);
  }
  return categories;
}

function applyPreferredVirtualBoxPath(prefs = {}) {
  try {
    if (typeof virtualbox?.setPreferredManagePath !== 'function') return;
    const rawPath = prefs && typeof prefs === 'object' ? prefs.virtualBoxPath : '';
    virtualbox.setPreferredManagePath(rawPath || '');
  } catch {}
}

function parsePathList(rawValue = '') {
  return String(rawValue || '')
    .split(/[;\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePathForTrust(pathValue = '') {
  const raw = String(pathValue || '').trim().replace(/\//g, '\\');
  const isUnc = raw.startsWith('\\\\');
  const collapsed = raw.replace(/[\\]+/g, '\\');
  const normalized = isUnc ? `\\\\${collapsed.replace(/^\\+/, '')}` : collapsed;
  if (!normalized) return '';
  const dequoted = normalized.replace(/^"+|"+$/g, '');
  const withoutTrailing = /^[a-z]:\\$/i.test(dequoted) ? dequoted : dequoted.replace(/[\\]+$/, '');
  return withoutTrailing.toLowerCase();
}

function isPathTrustedByPrefs(candidatePath = '', prefs = {}) {
  const candidate = normalizePathForTrust(candidatePath);
  if (!candidate) return true;
  const trustedRoots = parsePathList(prefs?.trustedPaths || '')
    .map(normalizePathForTrust)
    .filter(Boolean);
  if (trustedRoots.length === 0) return true;
  return trustedRoots.some((root) => candidate === root || candidate.startsWith(`${root}\\`));
}

function mergePathListString(existingValue = '', candidates = []) {
  const merged = [];
  const seen = new Set();
  const pushUnique = (value) => {
    const item = String(value || '').trim();
    if (!item) return;
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  };

  parsePathList(existingValue).forEach(pushUnique);
  (Array.isArray(candidates) ? candidates : []).forEach(pushUnique);
  return merged.join('; ');
}

function validateLinuxGuestUsername(value = '', label = 'Guest username') {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  if (!LINUX_GUEST_USERNAME_PATTERN.test(normalized)) {
    throw new Error(`${label} must start with a letter/underscore and contain only letters, numbers, underscores, or hyphens.`);
  }
  return normalized;
}

async function ensurePathTrustedByPrefs(candidatePath = '', prefs = null) {
  const selectedPath = String(candidatePath || '').trim();
  const basePrefs = (prefs && typeof prefs === 'object') ? prefs : readUiPrefsFromDisk();
  if (!selectedPath) return basePrefs;
  if (isPathTrustedByPrefs(selectedPath, basePrefs)) return basePrefs;

  const updatedPrefs = {
    ...basePrefs,
    trustedPaths: mergePathListString(basePrefs.trustedPaths, [selectedPath])
  };
  await writeUiPrefsToDisk(updatedPrefs);
  logger.info('Security', `Trusted path added automatically for selected shared folder: ${selectedPath}`);
  return updatedPrefs;
}

function normalizeSetupPath(rawPath = '') {
  const value = String(rawPath || '').trim().replace(/^"(.*)"$/, '$1').trim();
  if (!value) return '';
  return path.normalize(value);
}

function hasInvalidWindowsPath(pathValue = '') {
  if (process.platform !== 'win32') return false;
  const normalized = normalizeSetupPath(pathValue);
  if (!normalized) return false;

  let remainder = normalized
    .replace(/^[a-z]:[\\/]?/i, '')
    .replace(/^\\\\[^\\]+\\[^\\]+[\\/]?/, '');

  const segments = remainder.split(/[\\/]+/).filter(Boolean);
  return segments.some((segment) => {
    if (/[<>:"|?*\u0000-\u001F]/.test(segment)) return true;
    if (/[. ]$/.test(segment)) return true;
    const stem = segment.split('.')[0].toLowerCase();
    return WINDOWS_RESERVED_NAMES.has(stem);
  });
}

function validateVmNameForSetup(rawName = '') {
  const vmName = String(rawName || '').trim();
  if (!vmName) {
    throw new Error('V Os name is required.');
  }
  if (/[<>:"/\\|?*\u0000-\u001F]/.test(vmName) || /[. ]$/.test(vmName)) {
    throw new Error('V Os name contains unsupported characters. Avoid: < > : " / \\ | ? * and trailing dots/spaces.');
  }
  return vmName;
}

async function resolveWritableDirectory(candidates = [], label = 'folder') {
  const seen = new Set();
  const attemptedErrors = [];

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const normalized = normalizeSetupPath(candidate);
    if (!normalized) continue;

    const compareKey = normalizePathForTrust(normalized) || normalized.toLowerCase();
    if (seen.has(compareKey)) continue;
    seen.add(compareKey);

    if (hasInvalidWindowsPath(normalized)) {
      attemptedErrors.push(`${normalized} (unsupported path characters)`);
      continue;
    }

    try {
      await fs.promises.mkdir(normalized, { recursive: true });
      const testFile = path.join(normalized, `.vmxposed-write-test-${process.pid}-${Date.now()}.tmp`);
      await fs.promises.writeFile(testFile, 'ok', 'utf8');
      await fs.promises.unlink(testFile).catch(() => {});
      return normalized;
    } catch (err) {
      attemptedErrors.push(`${normalized} (${err.message})`);
    }
  }

  throw new Error(`Could not use ${label}. Checked: ${attemptedErrors.join(' | ') || 'no valid path candidates'}`);
}

async function normalizeSetupConfig(rawConfig = {}, uiPrefs = {}) {
  const config = (rawConfig && typeof rawConfig === 'object') ? rawConfig : {};
  const warnings = [];

  config.useExistingVm = !!config.useExistingVm;

  if (!config.useExistingVm) {
    config.vmName = validateVmNameForSetup(config.vmName);
  } else if (String(config.vmName || '').trim()) {
    config.vmName = validateVmNameForSetup(config.vmName);
  }

  const requestedInstallPath = normalizeSetupPath(config.installPath);
  const resolvedInstallPath = await resolveWritableDirectory(
    [requestedInstallPath, uiPrefs.installPath, getDefaultInstallPath()],
    'V Os install folder'
  );
  config.installPath = resolvedInstallPath;
  if (requestedInstallPath && normalizePathForTrust(requestedInstallPath) !== normalizePathForTrust(resolvedInstallPath)) {
    warnings.push(`Selected V Os install folder is not writable. Using: ${resolvedInstallPath}`);
  }

  const requestedDownloadPath = normalizeSetupPath(config.downloadPath);
  const resolvedDownloadPath = await resolveWritableDirectory(
    [requestedDownloadPath, uiPrefs.downloadPath, getDownloadDir()],
    'ISO download folder'
  );
  config.downloadPath = resolvedDownloadPath;
  if (requestedDownloadPath && normalizePathForTrust(requestedDownloadPath) !== normalizePathForTrust(resolvedDownloadPath)) {
    warnings.push(`Selected ISO download folder is not writable. Using: ${resolvedDownloadPath}`);
  }

  config.isoSource = String(config.isoSource || 'official').toLowerCase() === 'custom' ? 'custom' : 'official';
  if (!config.useExistingVm && config.isoSource === 'custom') {
    const customIsoPath = normalizeSetupPath(config.customIsoPath);
    if (!customIsoPath) {
      throw new Error('Custom ISO file path is required.');
    }
    if (hasInvalidWindowsPath(customIsoPath)) {
      throw new Error('Custom ISO path contains unsupported characters.');
    }
    if (path.extname(customIsoPath).toLowerCase() !== '.iso') {
      throw new Error('Unsupported file selected. Please choose a valid .iso file.');
    }

    let stats = null;
    try {
      stats = await fs.promises.stat(customIsoPath);
    } catch {
      throw new Error(`Custom ISO file was not found: ${customIsoPath}`);
    }
    if (!stats.isFile()) {
      throw new Error('Custom ISO path must point to a file.');
    }
    if (stats.size < MIN_SUPPORTED_ISO_BYTES) {
      throw new Error('Selected ISO file appears incomplete or unsupported (file size is too small).');
    }
    await fs.promises.access(customIsoPath, fs.constants.R_OK);
    config.customIsoPath = customIsoPath;
  } else {
    config.customIsoPath = '';
  }

  config.enableSharedFolder = !!config.enableSharedFolder;
  if (config.enableSharedFolder) {
    const requestedSharedPath = normalizeSetupPath(config.sharedFolderPath);
    const resolvedSharedPath = await resolveWritableDirectory(
      [requestedSharedPath, uiPrefs.sharedFolderPath, getDefaultSharedFolderPath()],
      'shared folder path'
    );
    config.sharedFolderPath = resolvedSharedPath;
    if (requestedSharedPath && normalizePathForTrust(requestedSharedPath) !== normalizePathForTrust(resolvedSharedPath)) {
      warnings.push(`Selected shared folder is not writable. Using: ${resolvedSharedPath}`);
    }
  } else {
    config.sharedFolderPath = normalizeSetupPath(config.sharedFolderPath);
  }

  if (config.useExistingVm && config.existingVmFolder) {
    const existingVmFolder = normalizeSetupPath(config.existingVmFolder);
    if (hasInvalidWindowsPath(existingVmFolder)) {
      throw new Error('Selected existing V Os folder contains unsupported path characters.');
    }
    try {
      const stats = await fs.promises.stat(existingVmFolder);
      if (!stats.isDirectory()) {
        throw new Error('not-a-directory');
      }
    } catch {
      throw new Error(`Selected existing V Os folder was not found or is not accessible: ${existingVmFolder}`);
    }
    config.existingVmFolder = existingVmFolder;
  } else {
    config.existingVmFolder = '';
  }

  return { config, warnings };
}

function applyLoggerPreferences(prefs = {}) {
  const level = String(prefs?.logLevel || 'info').toLowerCase();
  const levelMap = {
    debug: 0,
    info: 1,
    warning: 2,
    error: 3
  };
  logger.minLevel = Number.isInteger(levelMap[level]) ? levelMap[level] : 1;
}

async function pruneLogFilesByRetention(retentionDays = 14) {
  const days = Math.max(1, Math.min(365, parseInt(retentionDays, 10) || 14));
  const cutoffMs = Date.now() - (days * 24 * 60 * 60 * 1000);
  try {
    await fs.promises.mkdir(logger.logDir, { recursive: true });
    const entries = await fs.promises.readdir(logger.logDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = String(entry.name || '');
      if (!name.includes('.log')) continue;
      const fullPath = path.join(logger.logDir, name);
      try {
        const stats = await fs.promises.stat(fullPath);
        if (stats.mtimeMs < cutoffMs) {
          await fs.promises.unlink(fullPath);
        }
      } catch {}
    }
  } catch {}
}

async function collectWindowsLogicalDisks() {
  const script = [
    "$items = Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,FileSystem,DriveType,Size,FreeSpace",
    "if ($null -eq $items) { @() | ConvertTo-Json -Compress } else { $items | ConvertTo-Json -Compress }"
  ].join('; ');

  const output = await new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', script],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 * 4 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
          return;
        }
        resolve(String(stdout || '').trim());
      }
    );
  });

  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function collectHostPartitions() {
  const mapDriveType = (code) => {
    const type = Number(code || 0);
    if (type === 2) return 'removable';
    if (type === 3) return 'fixed';
    if (type === 4) return 'network';
    if (type === 5) return 'cdrom';
    if (type === 6) return 'ramdisk';
    return 'unknown';
  };

  if (process.platform === 'win32') {
    try {
      const disks = await collectWindowsLogicalDisks();
      const items = disks
        .map((row) => {
          const deviceId = String(row.DeviceID || '').trim();
          if (!deviceId) return null;
          const mountPath = deviceId.endsWith(':') ? `${deviceId}\\` : deviceId;
          const sizeBytes = Math.max(0, Number(row.Size || 0));
          const freeBytes = Math.max(0, Number(row.FreeSpace || 0));
          const usedBytes = Math.max(0, sizeBytes - freeBytes);
          const totalGb = Number((sizeBytes / (1024 ** 3)).toFixed(2));
          const freeGb = Number((freeBytes / (1024 ** 3)).toFixed(2));
          const usedGb = Number((usedBytes / (1024 ** 3)).toFixed(2));
          return {
            deviceId,
            mountPath,
            volumeName: String(row.VolumeName || '').trim(),
            fileSystem: String(row.FileSystem || '').trim(),
            driveTypeCode: Number(row.DriveType || 0),
            driveType: mapDriveType(row.DriveType),
            sizeBytes,
            freeBytes,
            usedBytes,
            totalGb,
            freeGb,
            usedGb,
            usedPercent: sizeBytes > 0 ? Math.round((usedBytes / sizeBytes) * 100) : 0
          };
        })
        .filter(Boolean);

      return items.sort((a, b) => {
        if (a.driveType === 'fixed' && b.driveType !== 'fixed') return -1;
        if (a.driveType !== 'fixed' && b.driveType === 'fixed') return 1;
        return Number(b.freeBytes || 0) - Number(a.freeBytes || 0);
      });
    } catch {
      return [];
    }
  }

  try {
    const rawDf = await new Promise((resolve, reject) => {
      execFile('df', ['-kP'], { timeout: 12000, maxBuffer: 1024 * 1024 * 2 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
          return;
        }
        resolve(String(stdout || ''));
      });
    });

    const lines = rawDf.split(/\r?\n/).filter((line) => line.trim());
    return lines.slice(1).map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return null;
      const sizeBytes = Math.max(0, Number(parts[1] || 0) * 1024);
      const usedBytes = Math.max(0, Number(parts[2] || 0) * 1024);
      const freeBytes = Math.max(0, Number(parts[3] || 0) * 1024);
      return {
        deviceId: parts[0],
        mountPath: parts[5],
        volumeName: '',
        fileSystem: '',
        driveTypeCode: 3,
        driveType: 'fixed',
        sizeBytes,
        freeBytes,
        usedBytes,
        totalGb: Number((sizeBytes / (1024 ** 3)).toFixed(2)),
        freeGb: Number((freeBytes / (1024 ** 3)).toFixed(2)),
        usedGb: Number((usedBytes / (1024 ** 3)).toFixed(2)),
        usedPercent: sizeBytes > 0 ? Math.round((usedBytes / sizeBytes) * 100) : 0
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function recommendAutoPathsFromScan(partitions = [], currentPrefs = {}) {
  const isValidDirectory = (candidate) => {
    const value = String(candidate || '').trim();
    if (!value) return false;
    try {
      return fs.existsSync(value) && fs.statSync(value).isDirectory();
    } catch {
      return false;
    }
  };

  const bestPartition = [...(Array.isArray(partitions) ? partitions : [])]
    .filter((item) => item && String(item.driveType || '').toLowerCase() === 'fixed' && Number(item.freeBytes || 0) > 0)
    .sort((a, b) => Number(b.freeBytes || 0) - Number(a.freeBytes || 0))[0]
    || null;

  const defaultRoot = path.parse(getDefaultInstallPath()).root || process.cwd();
  const rootMount = String(bestPartition?.mountPath || defaultRoot).trim() || defaultRoot;
  const autoRoot = path.join(rootMount, 'VM Xposed');
  const fallbackInstallPath = path.join(autoRoot, 'V Os');
  const fallbackDownloadPath = path.join(autoRoot, 'Downloads');
  const fallbackSharedPath = path.join(autoRoot, 'Shared');

  return {
    installPath: isValidDirectory(currentPrefs.installPath) ? String(currentPrefs.installPath).trim() : fallbackInstallPath,
    downloadPath: isValidDirectory(currentPrefs.downloadPath) ? String(currentPrefs.downloadPath).trim() : fallbackDownloadPath,
    sharedFolderPath: isValidDirectory(currentPrefs.sharedFolderPath) ? String(currentPrefs.sharedFolderPath).trim() : fallbackSharedPath,
    primaryPartition: bestPartition
      ? {
          mountPath: bestPartition.mountPath,
          freeGb: bestPartition.freeGb,
          totalGb: bestPartition.totalGb,
          fileSystem: bestPartition.fileSystem || '',
          volumeName: bestPartition.volumeName || ''
        }
      : null
  };
}

function detectVmPathCandidates(partitions = [], vmStorageItems = [], preferredInstallPath = '') {
  const unique = [];
  const seen = new Set();
  const addPath = (candidatePath = '') => {
    const normalized = String(candidatePath || '').trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    try {
      if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) return;
    } catch {
      return;
    }
    seen.add(key);
    unique.push(normalized);
  };

  (Array.isArray(vmStorageItems) ? vmStorageItems : []).forEach((item) => {
    addPath(item?.vmDir || '');
    if (item?.cfgFile) {
      addPath(path.dirname(String(item.cfgFile)));
    }
  });

  addPath(path.join(os.homedir(), 'VirtualBox VMs'));

  (Array.isArray(partitions) ? partitions : [])
    .filter((entry) => String(entry?.driveType || '').toLowerCase() === 'fixed')
    .forEach((entry) => {
      const root = String(entry?.mountPath || '').trim();
      if (!root) return;
      addPath(path.join(root, 'VirtualBox VMs'));
    });

  addPath(preferredInstallPath);
  return unique;
}

async function runFullSystemScan() {
  const warnings = [];
  const timestamp = new Date().toISOString();
  const currentPrefs = readUiPrefsFromDisk();
  applyPreferredVirtualBoxPath(currentPrefs);

  const partitions = await collectHostPartitions();
  const recommendations = recommendAutoPathsFromScan(partitions, currentPrefs);

  const ensureDirectory = async (targetPath, label) => {
    const value = String(targetPath || '').trim();
    if (!value) return;
    try {
      await fs.promises.mkdir(value, { recursive: true });
    } catch (err) {
      warnings.push(`${label} could not be prepared: ${err.message}`);
    }
  };

  await ensureDirectory(recommendations.installPath, 'Install path');
  await ensureDirectory(recommendations.downloadPath, 'Download path');
  await ensureDirectory(recommendations.sharedFolderPath, 'Shared folder path');

  let vboxPath = '';
  let vboxVersion = null;
  try {
    await virtualbox.init();
    if (virtualbox.isInstalled()) {
      vboxPath = String(virtualbox.vboxManagePath || '').trim();
      vboxVersion = await virtualbox.getVersion();
    }
  } catch (err) {
    warnings.push(`VirtualBox detection warning: ${err.message}`);
  }

  let vmStorage = { success: true, totalBytes: 0, totalGb: 0, items: [] };
  if (vboxPath) {
    try {
      vmStorage = await collectVmStorageUsage();
    } catch (err) {
      vmStorage = { success: false, totalBytes: 0, totalGb: 0, items: [] };
      warnings.push(`V Os path detection warning: ${err.message}`);
    }
  }

  const detectedVmPaths = detectVmPathCandidates(partitions, vmStorage.items, recommendations.installPath);

  let systemReport = null;
  try {
    systemReport = await runSystemCheck(recommendations.installPath, {
      preferredVBoxPath: vboxPath || currentPrefs.virtualBoxPath || ''
    });
  } catch (err) {
    warnings.push(`System report warning: ${err.message}`);
  }

  const mergedPrefs = {
    ...currentPrefs,
    installPath: recommendations.installPath,
    downloadPath: recommendations.downloadPath,
    sharedFolderPath: recommendations.sharedFolderPath,
    enableSharedFolder: !!recommendations.sharedFolderPath,
    virtualBoxPath: vboxPath || String(currentPrefs.virtualBoxPath || '').trim(),
    trustedPaths: mergePathListString(currentPrefs.trustedPaths, [recommendations.sharedFolderPath, ...detectedVmPaths]),
    lastFullScanAt: timestamp,
    fullScanPartitionCount: partitions.length,
    fullScanDetectedVmPathCount: detectedVmPaths.length,
    autoDetectedVmPaths: detectedVmPaths.join('; '),
    preferredVmPath: detectedVmPaths[0] || ''
  };

  await writeUiPrefsToDisk(mergedPrefs);
  applyPreferredVirtualBoxPath(mergedPrefs);
  applyLoggerPreferences(mergedPrefs);
  await pruneLogFilesByRetention(mergedPrefs.logRetentionDays);

  return {
    success: true,
    timestamp,
    warnings,
    prefs: mergedPrefs,
    recommendations,
    partitions,
    systemReport,
    virtualBox: {
      installed: !!vboxPath,
      path: vboxPath,
      version: vboxVersion
    },
    vmStorage: {
      totalBytes: Number(vmStorage?.totalBytes || 0),
      totalGb: Number(vmStorage?.totalGb || 0),
      items: Array.isArray(vmStorage?.items) ? vmStorage.items : []
    },
    detectedVmPaths
  };
}

function resolveAppIconPath() {
  try {
    return prodUtils.getAppIconPath();
  } catch (err) {
    logger.warn('App', `Could not resolve app icon: ${err.message}`);
    return undefined;
  }
}

function createFallbackAppIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0b1222"/>
          <stop offset="100%" stop-color="#142a4a"/>
        </linearGradient>
        <linearGradient id="bolt" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ffd84a"/>
          <stop offset="100%" stop-color="#ffb300"/>
        </linearGradient>
      </defs>
      <rect x="8" y="8" width="240" height="240" rx="48" fill="url(#bg)"/>
      <rect x="52" y="66" width="120" height="34" rx="8" fill="#3b82f6"/>
      <rect x="44" y="108" width="132" height="34" rx="8" fill="#1d4ed8"/>
      <rect x="36" y="150" width="144" height="34" rx="8" fill="#0f3a7a"/>
      <path d="M182 54 L144 124 H182 L136 202 L222 112 H186 L216 54 Z" fill="url(#bolt)"/>
    </svg>
  `;

  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return nativeImage.createFromDataURL(dataUrl);
}

function resolveAppIcon() {
  const iconPath = resolveAppIconPath();
  if (iconPath) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      return image.resize({ width: 256, height: 256, quality: 'best' });
    }
    return iconPath;
  }
  return createFallbackAppIcon();
}

const UPDATE_REPO_OWNER = 'Jeet1511';
const UPDATE_REPO_NAME = 'VM-Manager';
const UPDATE_REPO_BRANCH = 'main';
const UPDATE_INSTALLER_DIR = 'Installer';
const UPDATE_PATCH_NOTES_DIR = 'Patch notes';
const GITHUB_UPDATES_PAGE = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/tree/${encodeURIComponent(UPDATE_REPO_BRANCH)}`;

function normalizeVersionString(version) {
  return String(version || '').trim().replace(/^v/i, '');
}

function parseVersionParts(version) {
  const base = normalizeVersionString(version).split('-')[0];
  const parts = base.split('.').map((part) => parseInt(part, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isVersionNewer(latestVersion, currentVersion) {
  const latest = parseVersionParts(latestVersion);
  const current = parseVersionParts(currentVersion);
  for (let i = 0; i < 3; i++) {
    if (latest[i] > current[i]) return true;
    if (latest[i] < current[i]) return false;
  }
  return false;
}

function compareVersions(a, b) {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

function encodeRepoPath(repoPath) {
  return String(repoPath || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildRepoContentsApiUrl(repoPath) {
  const encodedPath = encodeRepoPath(repoPath);
  const base = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/contents`;
  return `${base}/${encodedPath}?ref=${encodeURIComponent(UPDATE_REPO_BRANCH)}`;
}

function buildRepoCommitsApiUrl(repoPath) {
  const normalizedPath = String(repoPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const base = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/commits`;
  const query = [
    `sha=${encodeURIComponent(UPDATE_REPO_BRANCH)}`,
    `path=${encodeURIComponent(normalizedPath)}`,
    'per_page=1'
  ].join('&');
  return `${base}?${query}`;
}

function buildRepoTreePageUrl(repoPath) {
  const encodedPath = encodeRepoPath(repoPath);
  if (!encodedPath) return GITHUB_UPDATES_PAGE;
  return `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/tree/${encodeURIComponent(UPDATE_REPO_BRANCH)}/${encodedPath}`;
}

function extractVersionFromName(name) {
  const match = String(name || '').match(/v?(\d+\.\d+\.\d+)/i);
  return match ? normalizeVersionString(match[1]) : '';
}

function parseGitHubTimestamp(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : 0;
}

async function fetchLatestCommitForRepoPath(repoPath) {
  try {
    const result = await fetchJsonWithRedirects(buildRepoCommitsApiUrl(repoPath));
    const first = Array.isArray(result) ? result[0] : null;
    if (!first || typeof first !== 'object') {
      return { sha: '', date: '' };
    }
    return {
      sha: String(first.sha || ''),
      date: String(first?.commit?.committer?.date || first?.commit?.author?.date || '')
    };
  } catch {
    return { sha: '', date: '' };
  }
}

async function enrichRepoEntriesWithLatestCommit(entries = [], basePath = '') {
  const list = Array.isArray(entries) ? entries : [];
  return Promise.all(list.map(async (entry) => {
    const pathFromEntry = String(entry?.path || '').trim();
    const name = String(entry?.name || '').trim();
    const repoPath = pathFromEntry || [String(basePath || '').trim(), name].filter(Boolean).join('/');
    const latestCommit = repoPath ? await fetchLatestCommitForRepoPath(repoPath) : { sha: '', date: '' };
    return {
      ...entry,
      parsedVersion: extractVersionFromName(name),
      latestCommitSha: latestCommit.sha,
      latestCommitDate: latestCommit.date,
      latestCommitTs: parseGitHubTimestamp(latestCommit.date)
    };
  }));
}

function isTrustedRepoAssetUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname.toLowerCase();
    const allowedHosts = [
      'raw.githubusercontent.com',
      'objects.githubusercontent.com',
      'github.com'
    ];
    return allowedHosts.includes(host) || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

function fetchJsonWithRedirects(url, redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `VM-Xposed-Updater/${app.getVersion() || '0.0.0'}`
      },
      timeout: 15000
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        if (redirectCount >= MAX_REDIRECTS) {
          response.resume();
          reject(new Error('Too many redirects while checking updates.'));
          return;
        }
        const nextUrl = new URL(response.headers.location, url).toString();
        response.resume();
        fetchJsonWithRedirects(nextUrl, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (statusCode < 200 || statusCode >= 300) {
          const details = body ? ` ${body.slice(0, 240)}` : '';
          reject(new Error(`Update check failed (${statusCode}).${details}`));
          return;
        }
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (err) {
          reject(new Error(`Invalid update response: ${err.message}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Update check timed out.')));
    request.on('error', reject);
  });
}

function fetchTextWithRedirects(url, redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': `VM-Xposed-Updater/${app.getVersion() || '0.0.0'}` },
      timeout: 20000
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        if (redirectCount >= MAX_REDIRECTS) {
          response.resume();
          reject(new Error('Too many redirects while reading patch notes.'));
          return;
        }
        const nextUrl = new URL(response.headers.location, url).toString();
        response.resume();
        fetchTextWithRedirects(nextUrl, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`Patch notes fetch failed (${statusCode}).`));
          return;
        }
        resolve(String(body || '').trim());
      });
    });
    request.on('timeout', () => request.destroy(new Error('Patch notes request timed out.')));
    request.on('error', reject);
  });
}

function pickLatestInstallerFile(entries = [], predicate = () => true) {
  return entries
    .filter((entry) => entry?.type === 'file' && predicate(entry))
    .sort((a, b) => {
      const commitDiff = (Number(b.latestCommitTs) || 0) - (Number(a.latestCommitTs) || 0);
      if (commitDiff !== 0) return commitDiff;
      const versionDiff = compareVersions(b.parsedVersion || '0.0.0', a.parsedVersion || '0.0.0');
      if (versionDiff !== 0) return versionDiff;
      const sizeDiff = (Number(b.size) || 0) - (Number(a.size) || 0);
      if (sizeDiff !== 0) return sizeDiff;
      return String(a.name || '').localeCompare(String(b.name || ''));
    })[0] || null;
}

async function checkForLatestReleaseUpdate() {
  const currentVersion = app.getVersion();
  const installerEntriesRaw = await fetchJsonWithRedirects(buildRepoContentsApiUrl(UPDATE_INSTALLER_DIR));
  const patchNoteEntriesRaw = await fetchJsonWithRedirects(buildRepoContentsApiUrl(UPDATE_PATCH_NOTES_DIR));

  if (!Array.isArray(installerEntriesRaw) || installerEntriesRaw.length === 0) {
    throw new Error(`No installers found in "${UPDATE_INSTALLER_DIR}" folder.`);
  }

  const installerFiles = installerEntriesRaw
    .filter((entry) => entry?.type === 'file' && /\.exe$/i.test(String(entry?.name || '')));
  const installerEntries = await enrichRepoEntriesWithLatestCommit(installerFiles, UPDATE_INSTALLER_DIR);
  const latestInstaller = pickLatestInstallerFile(installerEntries, () => true);
  if (!latestInstaller) {
    throw new Error(`No installer (.exe) file found in "${UPDATE_INSTALLER_DIR}".`);
  }

  const patchFilesRaw = Array.isArray(patchNoteEntriesRaw)
    ? patchNoteEntriesRaw
      .filter((entry) => entry?.type === 'file' && /\.(txt|md)$/i.test(String(entry?.name || '')))
    : [];
  const patchFiles = await enrichRepoEntriesWithLatestCommit(patchFilesRaw, UPDATE_PATCH_NOTES_DIR);
  patchFiles.sort((a, b) => {
    const versionDiff = compareVersions(b.parsedVersion || '0.0.0', a.parsedVersion || '0.0.0');
    if (versionDiff !== 0) return versionDiff;
    const commitDiff = (Number(b.latestCommitTs) || 0) - (Number(a.latestCommitTs) || 0);
    if (commitDiff !== 0) return commitDiff;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  const versionedPatchFiles = patchFiles.filter((entry) => !!entry.parsedVersion);

  let selectedPatch = null;
  if (latestInstaller.parsedVersion) {
    selectedPatch = versionedPatchFiles.find((entry) => entry.parsedVersion === latestInstaller.parsedVersion) || null;
  }
  if (!selectedPatch && patchFiles.length > 0) selectedPatch = patchFiles[0];

  let releaseNotes = '';
  if (selectedPatch?.download_url) {
    try {
      releaseNotes = await fetchTextWithRedirects(selectedPatch.download_url);
    } catch (err) {
      releaseNotes = `Patch notes could not be loaded: ${err.message}`;
    }
  }

  const latestVersion = normalizeVersionString(
    latestInstaller.parsedVersion
    || selectedPatch?.parsedVersion
    || ''
  );
  const hasUpdate = Boolean(latestVersion && isVersionNewer(latestVersion, currentVersion));

  return {
    success: true,
    currentVersion: normalizeVersionString(currentVersion),
    latestVersion: latestVersion || normalizeVersionString(currentVersion),
    hasUpdate,
    releaseName: latestVersion ? `v${latestVersion}` : String(latestInstaller?.name || 'Latest installer'),
    publishedAt: String(latestInstaller?.latestCommitDate || ''),
    releaseNotes: String(releaseNotes || '').trim(),
    installerName: String(latestInstaller?.name || ''),
    installerUrl: String(latestInstaller?.download_url || ''),
    installerSize: Number(latestInstaller?.size || 0),
    installerCommitSha: String(latestInstaller?.latestCommitSha || latestInstaller?.sha || ''),
    installerCommitDate: String(latestInstaller?.latestCommitDate || ''),
    patchNotesName: String(selectedPatch?.name || ''),
    patchNotesUrl: String(selectedPatch?.download_url || ''),
    patchHistory: versionedPatchFiles.map((entry) => ({
      version: String(entry.parsedVersion || ''),
      name: String(entry.name || ''),
      url: String(entry.download_url || ''),
      commitDate: String(entry.latestCommitDate || '')
    })),
    releasesPage: buildRepoTreePageUrl(UPDATE_INSTALLER_DIR),
    patchNotesPage: buildRepoTreePageUrl(UPDATE_PATCH_NOTES_DIR)
  };
}

function shouldRetryDeferredRuntimeIntegration(warnings = []) {
  const text = Array.isArray(warnings)
    ? warnings.map((warning) => String(warning || '').toLowerCase()).join(' | ')
    : '';
  return /drag-?and-?drop runtime apply|clipboard\/drag-drop deferred|guest additions readiness check|guest additions wait failed|verr_timeout/.test(text);
}

function downloadFileWithRedirects(url, destinationPath, redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': `VM-Xposed-Updater/${app.getVersion() || '0.0.0'}` },
      timeout: 30000
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        if (redirectCount >= MAX_REDIRECTS) {
          response.resume();
          reject(new Error('Too many redirects while downloading update installer.'));
          return;
        }
        const nextUrl = new URL(response.headers.location, url).toString();
        response.resume();
        downloadFileWithRedirects(nextUrl, destinationPath, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Installer download failed (${statusCode}).`));
        return;
      }

      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      const fileStream = fs.createWriteStream(destinationPath);
      response.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(() => resolve({ success: true, filePath: destinationPath })));
      fileStream.on('error', (err) => {
        try { fs.unlinkSync(destinationPath); } catch {}
        reject(err);
      });
      response.on('error', (err) => {
        try { fs.unlinkSync(destinationPath); } catch {}
        reject(err);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Installer download timed out.')));
    request.on('error', reject);
  });
}

async function downloadAndInstallLatestRelease(payload = {}) {
  const installerUrl = String(payload.installerUrl || '').trim();
  const targetVersion = normalizeVersionString(payload.version || '');
  const updateInfo = installerUrl
    ? (() => {
      let installerName = 'VM-Xposed-Installer.exe';
      try {
        const parsedUrl = new URL(installerUrl);
        installerName = path.basename(parsedUrl.pathname) || installerName;
      } catch {}
      return {
        success: true,
        currentVersion: normalizeVersionString(app.getVersion()),
        latestVersion: targetVersion || '',
        installerUrl,
        installerName
      };
    })()
    : (() => null)();

  const resolvedUpdateInfo = updateInfo || await checkForLatestReleaseUpdate();

  if (!resolvedUpdateInfo.installerUrl) {
    throw new Error('No installer asset is published for the latest release.');
  }

  const extension = path.extname(resolvedUpdateInfo.installerName || '.exe') || '.exe';
  const safeVersion = normalizeVersionString(resolvedUpdateInfo.latestVersion || resolvedUpdateInfo.currentVersion || 'latest').replace(/[^\w.-]/g, '_');
  const installerPath = path.join(app.getPath('temp'), `VM-Xposed-Installer-${safeVersion}${extension}`);
  await downloadFileWithRedirects(resolvedUpdateInfo.installerUrl, installerPath);

  const launchError = await shell.openPath(installerPath);
  if (launchError) {
    throw new Error(launchError);
  }

  setTimeout(() => {
    try { app.quit(); } catch {}
  }, 900);

  return {
    success: true,
    installerPath,
    launched: true,
    latestVersion: resolvedUpdateInfo.latestVersion || resolvedUpdateInfo.currentVersion
  };
}

function parseVmNamesFromList(rawOutput) {
  return String(rawOutput || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/"(.+)"/);
      return m ? m[1] : '';
    })
    .filter(Boolean);
}

async function getGuestDisplayFullscreenPreference(vmName) {
  try {
    const guestPrefOut = await virtualbox._run(['getextradata', vmName, 'VMXposed/GuestDisplayFullscreen']);
    const prefMatch = String(guestPrefOut || '').match(/Value:\s*(.+)/i);
    if (prefMatch && prefMatch[1]) {
      const value = prefMatch[1].trim().toLowerCase();
      return value !== 'off';
    }
  } catch {}

  try {
    const legacyOut = await virtualbox._run(['getextradata', vmName, 'GUI/Fullscreen']);
    const legacyMatch = String(legacyOut || '').match(/Value:\s*(.+)/i);
    if (legacyMatch && legacyMatch[1]) {
      const value = legacyMatch[1].trim().toLowerCase();
      return value !== 'off';
    }
  } catch {}

  return true;
}

async function getVmIntegrationModePreference(vmName, key) {
  try {
    const out = await virtualbox._run(['getextradata', vmName, key]);
    const match = String(out || '').match(/Value:\s*(.+)/i);
    if (match && match[1]) {
      const value = match[1].trim().toLowerCase();
      if (['disabled', 'hosttoguest', 'guesttohost', 'bidirectional'].includes(value)) {
        return value;
      }
    }
  } catch {}
  return '';
}

async function getPreferredRuntimeIntegrationModes(vmName, vmInfo = null) {
  const normalizeIntegrationMode = (raw, fallback = 'bidirectional') => {
    const value = String(raw || '').toLowerCase();
    return ['disabled', 'hosttoguest', 'guesttohost', 'bidirectional'].includes(value) ? value : fallback;
  };

  const info = vmInfo || await virtualbox.getVMInfo(vmName);
  const persistedClipboard = await getVmIntegrationModePreference(vmName, 'VMXposed/ClipboardMode');
  const persistedDnD = await getVmIntegrationModePreference(vmName, 'VMXposed/DragAndDropMode');

  return {
    clipboardMode: persistedClipboard || normalizeIntegrationMode(info.clipboard || info['clipboard-mode']),
    dragAndDrop: persistedDnD || normalizeIntegrationMode(info.draganddrop || info['drag-and-drop'])
  };
}

function getPrimaryDisplayResolution() {
  try {
    const primary = screen.getPrimaryDisplay();
    const size = primary?.workAreaSize || primary?.size || {};
    const width = Math.max(1024, parseInt(size.width || 0, 10) || 0);
    const height = Math.max(768, parseInt(size.height || 0, 10) || 0);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  } catch {}
  return { width: 1920, height: 1080 };
}

async function waitForVmState(vmName, desiredState = 'running', timeoutMs = 45000, intervalMs = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const state = String(await virtualbox.getVMState(vmName) || '').toLowerCase();
      if (state === String(desiredState || '').toLowerCase()) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function scheduleDeferredRuntimeIntegration(vmName, runtimeOptions = {}, delayMs = 4000) {
  const targetVm = String(vmName || '').trim();
  if (!targetVm || runtimeIntegrationQueue.has(targetVm)) return;

  const forceSchedule = runtimeOptions.forceSchedule === true;
  const cooldownMs = Math.max(5000, Number(runtimeOptions.cooldownMs || 0) || 30000);
  const now = Date.now();
  const last = Number(runtimeIntegrationLastScheduledAt.get(targetVm) || 0);
  if (!forceSchedule && now - last < cooldownMs) return;

  runtimeIntegrationQueue.set(targetVm, true);
  runtimeIntegrationLastScheduledAt.set(targetVm, now);
  setTimeout(async () => {
    let shouldRetry = false;
    try {
      const state = String(await virtualbox.getVMState(targetVm) || '').toLowerCase();
      if (state !== 'running') {
        runtimeIntegrationRetryCounts.delete(targetVm);
        return;
      }

      const result = await virtualbox.applyRuntimeIntegration(targetVm, {
        ...runtimeOptions,
        waitForGuestAdditionsMs: Math.max(120000, Number(runtimeOptions.waitForGuestAdditionsMs || 0))
      });
      const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
      if (warnings.length > 0) {
        logger.warn('App', `Deferred runtime integration warnings for "${targetVm}": ${warnings.join(' | ')}`);
        if (shouldRetryDeferredRuntimeIntegration(warnings)) {
          const retries = Number(runtimeIntegrationRetryCounts.get(targetVm) || 0);
          if (retries < 3) {
            runtimeIntegrationRetryCounts.set(targetVm, retries + 1);
            shouldRetry = true;
            logger.info('App', `Scheduling deferred runtime integration retry ${retries + 1}/3 for "${targetVm}".`);
          }
        } else {
          runtimeIntegrationRetryCounts.delete(targetVm);
        }
      } else {
        runtimeIntegrationRetryCounts.delete(targetVm);
      }
    } catch (err) {
      logger.warn('App', `Deferred runtime integration failed for "${targetVm}": ${err.message}`);
    } finally {
      runtimeIntegrationQueue.delete(targetVm);
      if (shouldRetry) {
        const retries = Number(runtimeIntegrationRetryCounts.get(targetVm) || 1);
        const retryDelayMs = Math.min(180000, 30000 * retries);
        scheduleDeferredRuntimeIntegration(targetVm, {
          ...runtimeOptions,
          forceSchedule: true,
          cooldownMs: 5000
        }, retryDelayMs);
      }
    }
  }, Math.max(0, Number(delayMs) || 0));
}

function rememberVmState(vmName, state = 'unknown') {
  const targetVm = String(vmName || '').trim();
  if (!targetVm) return;
  const normalized = String(state || 'unknown').toLowerCase();
  vmLastKnownState.set(targetVm, normalized);
  if (normalized !== 'running') {
    runtimeIntegrationLastScheduledAt.delete(targetVm);
    runtimeIntegrationQueue.delete(targetVm);
    runtimeIntegrationRetryCounts.delete(targetVm);
  }
}

function shouldAutoApplyOnStart(vmName, state = 'unknown') {
  const targetVm = String(vmName || '').trim();
  if (!targetVm) return false;
  const normalized = String(state || 'unknown').toLowerCase();
  const previous = String(vmLastKnownState.get(targetVm) || 'unknown').toLowerCase();
  rememberVmState(targetVm, normalized);
  return normalized === 'running' && previous !== 'running';
}

function normalizeFilePathForCompare(filePath) {
  return path.resolve(String(filePath || '')).replace(/\\/g, '/').toLowerCase();
}

function findVboxFilesInFolder(rootFolder, maxDepth = 4) {
  const results = [];
  const root = path.resolve(rootFolder);

  function walk(currentDir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.vbox')) {
        results.push(full);
      }
    }
  }

  walk(root, 0);
  return results;
}

function readVmNameFromVboxFile(vboxFilePath) {
  try {
    const xml = fs.readFileSync(vboxFilePath, 'utf8');
    const match = xml.match(/<Machine[^>]*\sname="([^"]+)"/i);
    if (match && match[1]) return match[1].trim();
  } catch {}
  return path.basename(vboxFilePath, '.vbox');
}

async function findRegisteredVmByCfgFile(vboxFilePath) {
  const wanted = normalizeFilePathForCompare(vboxFilePath);
  const listRaw = await virtualbox._run(['list', 'vms']);
  const vmNames = parseVmNamesFromList(listRaw);

  for (const vmName of vmNames) {
    try {
      const info = await virtualbox.getVMInfo(vmName);
      const cfg = info?.CfgFile ? normalizeFilePathForCompare(info.CfgFile) : '';
      if (cfg && cfg === wanted) {
        return vmName;
      }
    } catch {}
  }

  return null;
}

async function resolveVmFromFolder(folderPath, options = {}) {
  const { registerIfNeeded = false } = options;
  const targetFolder = String(folderPath || '').trim();

  if (!targetFolder) {
    return { success: false, error: 'Folder path is required.' };
  }

  if (!fs.existsSync(targetFolder) || !fs.statSync(targetFolder).isDirectory()) {
    return { success: false, error: 'Selected path is not a valid folder.' };
  }

  await virtualbox.init();

  const vboxFiles = findVboxFilesInFolder(targetFolder, 4);
  if (vboxFiles.length === 0) {
    return {
      success: false,
      error: 'No VirtualBox machine file (.vbox) found in selected folder.'
    };
  }

  const selectedVboxFile = vboxFiles[0];
  const vmNameFromFile = readVmNameFromVboxFile(selectedVboxFile);
  const alreadyRegisteredByCfg = await findRegisteredVmByCfgFile(selectedVboxFile);
  if (alreadyRegisteredByCfg) {
    return {
      success: true,
      vmName: alreadyRegisteredByCfg,
      vboxFile: selectedVboxFile,
      registered: true,
      imported: false
    };
  }

  if (!registerIfNeeded) {
    return {
      success: true,
      vmName: vmNameFromFile,
      vboxFile: selectedVboxFile,
      registered: false,
      imported: false
    };
  }

  try {
    await virtualbox._run(['registervm', selectedVboxFile]);
  } catch (err) {
    const existing = await findRegisteredVmByCfgFile(selectedVboxFile);
    if (!existing) {
      return { success: false, error: `Failed to register V Os from folder: ${err.message}` };
    }
  }

  const registeredName = await findRegisteredVmByCfgFile(selectedVboxFile);
  if (!registeredName) {
    return {
      success: false,
      error: 'V Os registration command completed, but V Os could not be detected in VirtualBox list.'
    };
  }

  return {
    success: true,
    vmName: registeredName,
    vboxFile: selectedVboxFile,
    registered: true,
    imported: true
  };
}

async function scanDownloadedVMs(rootPath) {
  const requestedRoot = String(rootPath || '').trim();
  if (!requestedRoot) {
    return { success: true, candidates: [] };
  }

  if (!fs.existsSync(requestedRoot)) {
    return { success: true, candidates: [] };
  }

  let rootStats = null;
  try {
    rootStats = fs.statSync(requestedRoot);
  } catch {
    return { success: true, candidates: [] };
  }

  if (!rootStats?.isDirectory()) {
    return { success: true, candidates: [] };
  }

  await virtualbox.init();

  const vboxFiles = findVboxFilesInFolder(requestedRoot, 6);
  const seen = new Set();
  const candidates = [];

  for (const vboxFile of vboxFiles) {
    const normalized = normalizeFilePathForCompare(vboxFile);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    let registeredVmName = null;
    try {
      registeredVmName = await findRegisteredVmByCfgFile(vboxFile);
    } catch {}

    const vmNameFromFile = readVmNameFromVboxFile(vboxFile);
    candidates.push({
      vmName: registeredVmName || vmNameFromFile,
      vboxFile,
      folderPath: path.dirname(vboxFile),
      registered: !!registeredVmName,
      registeredVmName: registeredVmName || null
    });
  }

  candidates.sort((a, b) => String(a.vmName || '').localeCompare(String(b.vmName || '')));

  return {
    success: true,
    rootPath: requestedRoot,
    candidates
  };
}

async function refreshCatalogInBackground(reason = 'manual') {
  if (isCatalogRefreshRunning) return;
  isCatalogRefreshRunning = true;
  try {
    const refreshed = await refreshOfficialCatalog(runtimeOSCatalog, logger);
    runtimeOSCatalog = refreshed.catalog;
    await persistRuntimeCatalog(`background:${reason}`);
    logger.info('CatalogUpdater', `Background catalog refresh (${reason}) complete. Added ${refreshed.totalAdded || 0} entries.`);
  } catch (err) {
    logger.warn('CatalogUpdater', `Background catalog refresh (${reason}) failed: ${err.message}`);
  } finally {
    isCatalogRefreshRunning = false;
  }
}

function scheduleCatalogRefresh() {
  catalogRefreshTimer = setInterval(() => {
    refreshCatalogInBackground('scheduled');
  }, 4 * 60 * 60 * 1000);

  if (typeof catalogRefreshTimer.unref === 'function') {
    catalogRefreshTimer.unref();
  }
}

async function shutdownRunningVMsOnExit() {
  try {
    await virtualbox.init();
    const runningRaw = await virtualbox._run(['list', 'runningvms']);
    const runningVms = parseVmNamesFromList(runningRaw);
    if (runningVms.length === 0) return;

    logger.info('App', `Stopping ${runningVms.length} running V Os before exit...`);

    for (const vmName of runningVms) {
      try {
        await virtualbox._run(['controlvm', vmName, 'acpipowerbutton']);
      } catch (err) {
        logger.warn('App', `ACPI shutdown failed for ${vmName}: ${err.message}`);
      }
    }

    const waitUntil = Date.now() + 15000;
    let pending = new Set(runningVms);

    while (pending.size > 0 && Date.now() < waitUntil) {
      const nextPending = new Set();
      for (const vmName of pending) {
        const state = String(await virtualbox.getVMState(vmName)).toLowerCase();
        if (state !== 'poweroff' && state !== 'aborted') {
          nextPending.add(vmName);
        }
      }
      pending = nextPending;
      if (pending.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }

    for (const vmName of pending) {
      try {
        await virtualbox._run(['controlvm', vmName, 'poweroff']);
      } catch (err) {
        logger.warn('App', `Forced poweroff failed for ${vmName}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.warn('App', `Failed to stop running V Os on exit: ${err.message}`);
  }
}

// ─── Admin / Permissions Utilities ─────────────────────────────────────

/**
 * Check if the app is running with administrator privileges.
 * (Now uses secure implementation from admin-elevate module)
 */
function isRunningAsAdmin() {
  return adminElevate.isRunningAsAdmin();
}

/**
 * Restart the app with admin privileges (Windows UAC elevation).
 * (Now uses secure implementation from admin-elevate module)
 */
async function restartAsAdmin() {
  return adminElevate.requestAdminElevation();
}

function resolvePreferredVBoxManagePath(rawPath = '') {
  const candidate = String(rawPath || '').trim().replace(/^"(.*)"$/, '$1').trim();
  if (!candidate) return '';

  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  } catch {}

  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      const exeName = process.platform === 'win32' ? 'VBoxManage.exe' : 'VBoxManage';
      const sibling = path.join(candidate, exeName);
      if (fs.existsSync(sibling) && fs.statSync(sibling).isFile()) {
        return sibling;
      }
    }
  } catch {}

  if (process.platform === 'win32' && candidate.toLowerCase().endsWith('virtualbox.exe')) {
    try {
      const sibling = path.join(path.dirname(candidate), 'VBoxManage.exe');
      if (fs.existsSync(sibling) && fs.statSync(sibling).isFile()) {
        return sibling;
      }
    } catch {}
  }

  return '';
}

function resolveVBoxManagePathForChecks() {
  const uiPrefs = readUiPrefsFromDisk();
  const preferredFromPrefs = resolvePreferredVBoxManagePath(uiPrefs?.virtualBoxPath || '');
  if (preferredFromPrefs) return preferredFromPrefs;

  const adapterPath = resolvePreferredVBoxManagePath(virtualbox?.vboxManagePath || virtualbox?.preferredManagePath || '');
  if (adapterPath) return adapterPath;

  if (process.platform === 'win32') {
    return String(prodUtils.findVirtualBoxOnWindows() || '').trim();
  }

  return '';
}

function getVBoxSupDriverState() {
  if (process.platform !== 'win32') {
    return { state: 'unsupported', message: 'VirtualBox kernel drivers apply to Windows hosts only.' };
  }

  const candidates = ['vboxsup', 'vboxdrv'];
  const stoppedService = [];
  const unknownErrors = [];

  for (const serviceName of candidates) {
    try {
      const output = String(execSync(`sc.exe query ${serviceName}`, { encoding: 'utf8', timeout: 5000 }) || '');
      if (/RUNNING/i.test(output)) {
        return {
          state: 'running',
          serviceName,
          message: `${serviceName.toUpperCase()} kernel driver is running.`
        };
      }
      if (/STOPPED/i.test(output)) {
        stoppedService.push(serviceName);
      }
    } catch (err) {
      const details = [
        String(err?.stdout || ''),
        String(err?.stderr || ''),
        String(err?.message || '')
      ].join('\n');
      if (/1060|does not exist/i.test(details)) {
        continue;
      }
      unknownErrors.push(`${serviceName}: ${details || err.message}`);
    }
  }

  if (stoppedService.length > 0) {
    const serviceName = stoppedService[0];
    return {
      state: 'stopped',
      serviceName,
      message: `${serviceName.toUpperCase()} kernel driver is installed and stopped (normal when no VM is active).`
    };
  }

  if (unknownErrors.length > 0) {
    return {
      state: 'unknown',
      message: `Could not query VirtualBox kernel driver services. ${unknownErrors[0]}`
    };
  }

  return {
    state: 'not-installed',
    message: 'VirtualBox kernel driver service was not found (VBoxSup/VBoxDrv).'
  };
}

function getVBoxProbeErrorDetails(err) {
  return [
    String(err?.stdout || ''),
    String(err?.stderr || ''),
    String(err?.message || '')
  ].join('\n').trim();
}

function isVBoxDriverRuntimeSignature(details = '') {
  return /vboxdrvstub|supr3hardenedwinrespawn|verr_open_failed|status_object_name_not_found|\\device\\vboxdrvstub/i.test(String(details || ''));
}

function readFileTail(filePath, maxBytes = 256 * 1024) {
  const target = String(filePath || '').trim();
  if (!target) return '';
  const bytes = Math.max(4096, Number(maxBytes || 0) || 0);
  let fd = null;
  try {
    const stats = fs.statSync(target);
    if (!stats.isFile()) return '';
    const readLength = Math.min(bytes, Number(stats.size || 0));
    if (readLength <= 0) return '';
    const buffer = Buffer.alloc(readLength);
    const start = Math.max(0, Number(stats.size || 0) - readLength);
    fd = fs.openSync(target, 'r');
    fs.readSync(fd, buffer, 0, readLength, start);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

async function detectVBoxRuntimeBlockerFromVmLogs(vmName = '') {
  if (process.platform !== 'win32') return null;
  const targetVmName = String(vmName || '').trim();
  if (!targetVmName) return null;

  try {
    const info = await virtualbox.getVMInfo(targetVmName);
    const cfgFile = String(info?.CfgFile || '')
      .replace(/\\\\/g, '\\')
      .replace(/^"(.*)"$/, '$1')
      .trim();
    if (!cfgFile) return null;

    const logsDir = path.join(path.dirname(cfgFile), 'Logs');
    if (!fs.existsSync(logsDir)) return null;

    const candidates = fs.readdirSync(logsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        name: entry.name,
        fullPath: path.join(logsDir, entry.name)
      }))
      .filter((entry) => /^VBox(?:Hardening)?\.log(?:\.\d+)?$/i.test(entry.name))
      .map((entry) => {
        let mtimeMs = 0;
        try { mtimeMs = Number(fs.statSync(entry.fullPath).mtimeMs || 0); } catch {}
        return { ...entry, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 4);

    for (const candidate of candidates) {
      const tail = readFileTail(candidate.fullPath, 320 * 1024);
      if (!tail || !isVBoxDriverRuntimeSignature(tail)) continue;

      const lines = tail.split(/\r?\n/).map((line) => String(line || '').trim()).filter(Boolean);
      const matchedLine = [...lines].reverse().find((line) => isVBoxDriverRuntimeSignature(line)) || '';
      const detail = matchedLine || `Driver/runtime failure signature found in ${candidate.name}.`;
      return {
        file: candidate.fullPath,
        details: detail,
        message: `VirtualBox logs report host driver/runtime failure (${candidate.name}): ${detail}`
      };
    }
  } catch (err) {
    logger.warn('App', `Could not inspect VirtualBox logs for "${targetVmName}": ${err.message}`);
  }

  return null;
}

function rememberVBoxRuntimeBlocker(details = '', source = 'runtime') {
  if (process.platform !== 'win32') return;
  const text = String(details || '').trim();
  if (!text || !isVBoxDriverRuntimeSignature(text)) return;
  lastVBoxRuntimeBlocker = {
    detectedAt: Date.now(),
    source: String(source || 'runtime').trim() || 'runtime',
    details: text,
    message: 'VirtualBox kernel runtime is unavailable (VBoxDrvStub/VBoxSup). Reboot, then repair/reinstall VirtualBox as administrator.'
  };
}

function rememberRecentVmStartFailure(message = '', options = {}) {
  if (process.platform !== 'win32') return;
  const text = String(message || '').trim();
  if (!text) return;
  lastVmStartFailure = {
    detectedAt: Date.now(),
    message: text,
    hostLikely: options?.hostLikely === true,
    vmName: String(options?.vmName || '').trim()
  };
}

function getActiveRecentVmStartFailure() {
  if (!lastVmStartFailure) return null;
  const ageMs = Date.now() - Number(lastVmStartFailure.detectedAt || 0);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > VM_START_FAILURE_TTL_MS) {
    lastVmStartFailure = null;
    return null;
  }
  return { ...lastVmStartFailure, ageMs };
}

function clearRecentVmStartFailure() {
  lastVmStartFailure = null;
}

function getActiveVBoxRuntimeBlocker() {
  if (!lastVBoxRuntimeBlocker) return null;
  const ageMs = Date.now() - Number(lastVBoxRuntimeBlocker.detectedAt || 0);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > VBOX_RUNTIME_BLOCKER_TTL_MS) {
    lastVBoxRuntimeBlocker = null;
    return null;
  }
  return { ...lastVBoxRuntimeBlocker, ageMs };
}

function clearVBoxRuntimeBlocker() {
  lastVBoxRuntimeBlocker = null;
}

/**
 * Deep-check whether the VirtualBox kernel driver can actually load.
 * VBoxManage CLI commands like 'list hostinfo' do NOT require the kernel driver,
 * but starting a VM does. This function verifies the driver is truly usable by
 * checking the driver binary exists and attempting to start the service.
 */
function probeVBoxKernelDeviceReady() {
  if (process.platform !== 'win32') return { ok: true, message: '' };

  const candidates = ['vboxsup', 'vboxdrv'];
  let foundService = null;

  for (const serviceName of candidates) {
    try {
      const qcOutput = String(execSync(`sc.exe qc ${serviceName}`, {
        encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: 'pipe'
      }) || '');

      // Verify the driver binary exists on disk
      const binaryMatch = qcOutput.match(/BINARY_PATH_NAME\s*:\s*(.+)/i);
      if (binaryMatch) {
        let driverPath = binaryMatch[1].trim().replace(/"/g, '');
        // Resolve \SystemRoot\ and \??\ prefixes
        driverPath = driverPath.replace(/^\\SystemRoot\\/i, `${process.env.SystemRoot || 'C:\\Windows'}\\`);
        driverPath = driverPath.replace(/^\\\?\?\\/, '');
        if (driverPath && !driverPath.startsWith('\\') && !fs.existsSync(driverPath)) {
          return {
            ok: false,
            code: 'driver-binary-missing',
            serviceName,
            message: `VirtualBox kernel driver binary not found at: ${driverPath}. Reinstall VirtualBox as administrator.`
          };
        }
      }

      // Check current state
      const queryOutput = String(execSync(`sc.exe query ${serviceName}`, {
        encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: 'pipe'
      }) || '');

      if (/RUNNING/i.test(queryOutput)) {
        return { ok: true, serviceName, state: 'running', message: `${serviceName.toUpperCase()} driver is running.` };
      }

      if (/STOPPED/i.test(queryOutput)) {
        foundService = serviceName;
        // Try to start the service to verify it can actually load
        try {
          execSync(`sc.exe start ${serviceName}`, { timeout: 10000, stdio: 'pipe', windowsHide: true });
          // Wait briefly for driver init
          try { execSync('ping -n 2 127.0.0.1 >nul', { timeout: 5000, windowsHide: true, shell: true }); } catch {}
          // Verify it actually reached running
          const recheck = String(execSync(`sc.exe query ${serviceName}`, {
            encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: 'pipe'
          }) || '');
          if (/RUNNING/i.test(recheck)) {
            return { ok: true, serviceName, state: 'started', message: `${serviceName.toUpperCase()} driver started successfully.` };
          }
          return {
            ok: false, code: 'driver-start-failed', serviceName,
            message: `${serviceName.toUpperCase()} driver was started but did not reach running state. Reboot or reinstall VirtualBox.`
          };
        } catch (startErr) {
          const details = [String(startErr?.stdout || ''), String(startErr?.stderr || ''), String(startErr?.message || '')].join('\n');
          if (/1056|already running|service has already been started/i.test(details)) {
            return { ok: true, serviceName, state: 'running', message: `${serviceName.toUpperCase()} is already running.` };
          }
          if (/access is denied|error 5[^0-9]/i.test(details) || /\b5\s*$/.test(details.trim())) {
            // Non-admin: can't start the service. The driver MIGHT be fine (demand-start),
            // but we can't verify. Flag as needing admin.
            return {
              ok: false, code: 'driver-needs-admin', serviceName,
              message: `${serviceName.toUpperCase()} driver is stopped and needs administrator privileges to start. Use "Continue with Admin Privilege" or reboot.`
            };
          }
          // Real failure — driver is broken
          const shortDetail = details.trim().split('\n').filter(Boolean)[0] || 'unknown error';
          return {
            ok: false, code: 'driver-start-failed', serviceName,
            message: `${serviceName.toUpperCase()} driver failed to start: ${shortDetail}. Reboot, then reinstall VirtualBox as administrator.`
          };
        }
      }
    } catch (err) {
      const details = [String(err?.stdout || ''), String(err?.stderr || ''), String(err?.message || '')].join('\n');
      if (/1060|does not exist/i.test(details)) continue;
    }
  }

  if (foundService) {
    return { ok: false, code: 'driver-unknown', serviceName: foundService, message: 'VirtualBox kernel driver state could not be determined.' };
  }
  return { ok: false, code: 'driver-not-installed', message: 'VirtualBox kernel driver service was not found (VBoxSup/VBoxDrv).' };
}

function probeVBoxRuntimeHealth(vboxPath = '') {
  const executable = String(vboxPath || '').trim();
  if (!executable) {
    return { ok: false, code: 'missing-vboxmanage', message: 'VBoxManage path was not found.' };
  }

  const probes = [
    ['list', 'hostinfo'],
    ['list', 'systemproperties']
  ];

  let lastDetails = '';
  for (const args of probes) {
    try {
      execFileSync(executable, args, {
        stdio: 'pipe',
        timeout: 10000,
        windowsHide: true
      });

      // VBoxManage CLI commands succeed without the kernel driver.
      // On Windows, also verify the kernel device is actually loadable,
      // because VM starts require it even though CLI queries don't.
      if (process.platform === 'win32') {
        const deviceCheck = probeVBoxKernelDeviceReady();
        if (!deviceCheck.ok) {
          const code = deviceCheck.code === 'driver-needs-admin' ? 'driver-needs-admin' : 'driver-runtime';
          if (code === 'driver-runtime') {
            rememberVBoxRuntimeBlocker(deviceCheck.message, 'kernel-device-probe');
          }
          return { ok: false, code, message: deviceCheck.message };
        }
      }

      return { ok: true, code: 'ok', message: 'VirtualBox runtime is responsive.' };
    } catch (err) {
      const details = getVBoxProbeErrorDetails(err);
      lastDetails = details || lastDetails;
      if (isVBoxDriverRuntimeSignature(details)) {
        rememberVBoxRuntimeBlocker(details, 'runtime-probe');
        return {
          ok: false,
          code: 'driver-runtime',
          message: 'VirtualBox kernel runtime is unavailable (VBoxDrvStub/VBoxSup). Reboot, then repair/reinstall VirtualBox as administrator.'
        };
      }
    }
  }

  return {
    ok: false,
    code: 'runtime-probe-warning',
    message: lastDetails
      ? `VirtualBox runtime probe failed: ${lastDetails}`
      : 'VirtualBox runtime probe failed.'
  };
}

function startVBoxDriverService(preferredService = '') {
  if (process.platform !== 'win32') {
    return { success: false, serviceName: '', message: 'VirtualBox driver service control is only available on Windows.' };
  }

  const candidates = Array.from(new Set(
    [preferredService, 'vboxsup', 'vboxdrv']
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean)
  ));

  const errors = [];
  for (const serviceName of candidates) {
    try {
      execSync(`sc.exe start ${serviceName}`, { timeout: 10000, stdio: 'pipe' });
      return { success: true, serviceName, message: `${serviceName.toUpperCase()} driver start requested.` };
    } catch (err) {
      const details = getVBoxProbeErrorDetails(err);
      if (/1056|already running|service has already been started/i.test(details)) {
        return { success: true, serviceName, message: `${serviceName.toUpperCase()} is already running.` };
      }
      if (/1060|does not exist/i.test(details)) {
        continue;
      }
      errors.push(`${serviceName}: ${details || err.message}`);
    }
  }

  return {
    success: false,
    serviceName: candidates[0] || '',
    message: errors[0] || 'Could not start VirtualBox kernel driver service.'
  };
}

function normalizeWindowsFeatureState(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (raw === 'enabled' || raw === 'enablepending') return 'enabled';
  if (raw === 'disabled' || raw === 'disablepending') return 'disabled';
  return 'unknown';
}

function isFeatureEnabled(state = '') {
  return normalizeWindowsFeatureState(state) === 'enabled';
}

async function collectWindowsVBoxRecoverySignals() {
  if (process.platform !== 'win32') {
    return {
      supported: false,
      hyperV: 'unknown',
      hypervisorPlatform: 'unknown',
      virtualMachinePlatform: 'unknown',
      memoryIntegrityEnabled: false,
      pendingReboot: false,
      warnings: []
    };
  }

  const script = `
    $hyperV = (Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -ErrorAction SilentlyContinue).State
    $hypervisorPlatform = (Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -ErrorAction SilentlyContinue).State
    $vmPlatform = (Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -ErrorAction SilentlyContinue).State

    $hvci = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity' -Name Enabled -ErrorAction SilentlyContinue).Enabled
    $pendingWU = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'
    $pendingCBS = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'
    $pendingFileOps = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations

    [PSCustomObject]@{
      hyperV = "$hyperV"
      hypervisorPlatform = "$hypervisorPlatform"
      virtualMachinePlatform = "$vmPlatform"
      memoryIntegrityEnabled = ([int]$hvci -eq 1)
      pendingReboot = [bool]($pendingWU -or $pendingCBS -or $null -ne $pendingFileOps)
    } | ConvertTo-Json -Compress
  `;

  try {
    const raw = await runPowerShellJson(script);
    return {
      supported: true,
      hyperV: normalizeWindowsFeatureState(raw?.hyperV),
      hypervisorPlatform: normalizeWindowsFeatureState(raw?.hypervisorPlatform),
      virtualMachinePlatform: normalizeWindowsFeatureState(raw?.virtualMachinePlatform),
      memoryIntegrityEnabled: raw?.memoryIntegrityEnabled === true,
      pendingReboot: raw?.pendingReboot === true,
      warnings: []
    };
  } catch (err) {
    return {
      supported: true,
      hyperV: 'unknown',
      hypervisorPlatform: 'unknown',
      virtualMachinePlatform: 'unknown',
      memoryIntegrityEnabled: false,
      pendingReboot: false,
      warnings: [err.message]
    };
  }
}

function buildVBoxHostRecoverySteps({
  isAdmin = false,
  runtimeCode = '',
  driverState = '',
  hostSignals = null
} = {}) {
  const steps = [];
  const addStep = (value) => {
    const text = String(value || '').trim();
    if (!text || steps.includes(text)) return;
    steps.push(text);
  };

  if (!isAdmin) {
    addStep('Use Continue with Admin Privilege in VM Xposed before running host recovery actions.');
  }

  if (hostSignals?.pendingReboot) {
    addStep('Windows has a pending reboot. Restart the host first, then retry VM Xposed.');
  }

  if (hostSignals?.memoryIntegrityEnabled) {
    addStep('Core Isolation / Memory Integrity is enabled. Disable it temporarily, reboot, then repair VirtualBox.');
  }

  if (
    isFeatureEnabled(hostSignals?.hyperV)
    || isFeatureEnabled(hostSignals?.hypervisorPlatform)
    || isFeatureEnabled(hostSignals?.virtualMachinePlatform)
  ) {
    addStep('Disable Hyper-V, Hypervisor Platform, and Virtual Machine Platform for maximum VirtualBox compatibility, then reboot.');
  }

  if (driverState === 'not-installed') {
    addStep('Repair or reinstall VirtualBox as administrator so VBoxSup/VBoxDrv driver services are re-registered.');
  }

  if (runtimeCode === 'driver-runtime') {
    addStep('Run VirtualBox installer in Repair mode as administrator, then reboot Windows.');
  } else if (runtimeCode === 'runtime-probe-warning') {
    addStep('Run "VBoxManage.exe list hostinfo" from an elevated terminal and review host runtime errors.');
  }

  return steps;
}

function getWindowsHostRecoveryActions(hostSignals = null) {
  if (process.platform !== 'win32') return [];

  const actions = [];
  const hasFeatureConflict = !!(
    isFeatureEnabled(hostSignals?.hyperV)
    || isFeatureEnabled(hostSignals?.hypervisorPlatform)
    || isFeatureEnabled(hostSignals?.virtualMachinePlatform)
  );

  if (hasFeatureConflict) {
    actions.push({
      id: 'disable-hypervisor-stack',
      label: 'Disable Hyper-V Stack',
      requiresAdmin: true,
      description: 'Automatically disable Hyper-V, Hypervisor Platform, and Virtual Machine Platform (reboot required).'
    });
    actions.push({
      id: 'open-windows-features',
      label: 'Open Windows Features',
      requiresAdmin: false,
      description: 'Open optional Windows features to turn Hyper-V related features off manually.'
    });
  }

  if (hostSignals?.memoryIntegrityEnabled) {
    actions.push({
      id: 'open-core-isolation',
      label: 'Open Core Isolation',
      requiresAdmin: false,
      description: 'Open Device Security so you can disable Memory Integrity and reboot.'
    });
  }

  return actions;
}

function summarizeWindowsVBoxHostBlockers({
  hostSignals = null,
  runtime = null,
  driver = null,
  hasVBoxAccess = true,
  recentVmStartFailure = null
} = {}) {
  const isWindows = process.platform === 'win32';
  const runtimeCode = String(runtime?.code || '').trim().toLowerCase();
  const runtimeMessage = String(runtime?.message || '').trim();
  const driverState = String(driver?.state || '').trim().toLowerCase();
  const driverMessage = String(driver?.message || '').trim();

  const hasHypervisorConflict = isWindows && (
    isFeatureEnabled(hostSignals?.hyperV)
    || isFeatureEnabled(hostSignals?.hypervisorPlatform)
    || isFeatureEnabled(hostSignals?.virtualMachinePlatform)
  );
  const hasMemoryIntegrityConflict = isWindows && hostSignals?.memoryIntegrityEnabled === true;
  const hasPendingReboot = isWindows && hostSignals?.pendingReboot === true;

  const hasDriverRuntimeIssue = isWindows && (runtimeCode === 'driver-runtime' || runtimeCode === 'driver-needs-admin');
  const hasRuntimeWarning = isWindows
    && runtime
    && runtime.ok === false
    && runtimeCode !== 'driver-runtime'
    && runtimeCode !== 'driver-needs-admin'
    && runtimeCode !== 'missing-vboxmanage';
  const hasMissingVBoxManage = isWindows && runtimeCode === 'missing-vboxmanage';
  const hasMissingDriverService = isWindows && driverState === 'not-installed';
  const recentStartFailureMessage = String(recentVmStartFailure?.message || '').trim();
  const recentStartFailureHostLikely = recentVmStartFailure?.hostLikely === true;
  const hasRecentStartFailure = isWindows && recentStartFailureMessage.length > 0;
  const hasDriverIssue = hasDriverRuntimeIssue || hasMissingDriverService || (hasMissingVBoxManage && !hasVBoxAccess);
  const hasRuntimeIssue = hasDriverRuntimeIssue || hasRuntimeWarning || hasRecentStartFailure;

  const blockerReasons = [];
  const advisoryReasons = [];
  const addUnique = (target, reason) => {
    const text = String(reason || '').trim();
    if (!text || target.includes(text)) return;
    target.push(text);
  };

  if (hasDriverRuntimeIssue) {
    addUnique(blockerReasons, runtimeMessage || 'VirtualBox kernel runtime is unavailable.');
  } else if (hasMissingDriverService) {
    addUnique(blockerReasons, driverMessage || 'VirtualBox kernel driver service is not installed.');
  } else if (hasMissingVBoxManage && !hasVBoxAccess) {
    addUnique(blockerReasons, 'VirtualBox tools are missing or inaccessible.');
  }

  if (hasHypervisorConflict) {
    addUnique(blockerReasons, 'Hyper-V stack is enabled');
  }
  if (hasMemoryIntegrityConflict) {
    addUnique(blockerReasons, 'Memory Integrity is enabled');
  }

  if (hasPendingReboot) {
    addUnique(advisoryReasons, 'Windows restart is pending');
  }
  if (hasRuntimeWarning) {
    addUnique(advisoryReasons, runtimeMessage || 'VirtualBox runtime warning detected.');
  }
  if (hasRecentStartFailure) {
    const failureSummary = `Recent VM start failed: ${recentStartFailureMessage}`;
    if (recentStartFailureHostLikely) {
      addUnique(blockerReasons, failureSummary);
    } else {
      addUnique(advisoryReasons, failureSummary);
    }
  }

  const hasAnyBlocker = blockerReasons.length > 0;
  const hasAnyIssue = hasAnyBlocker || advisoryReasons.length > 0;
  const primaryMessage = hasAnyBlocker
    ? `Host fix needed: ${blockerReasons.join(' · ')}.`
    : (
      advisoryReasons.length > 0
        ? `Host attention needed: ${advisoryReasons.join(' · ')}.`
        : 'Host virtualization checks look healthy.'
    );

  return {
    platform: process.platform,
    hasAnyIssue,
    hasAnyBlocker,
    hasDriverIssue,
    hasRuntimeIssue,
    hasHypervisorConflict,
    hasMemoryIntegrityConflict,
    hasPendingReboot,
    hasRecentStartFailure,
    runtimeCode,
    driverState,
    blockerReasons,
    advisoryReasons,
    primaryMessage
  };
}

function runWindowsCommand(command, args, timeout = 120000) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout
  });

  const stdout = String(result?.stdout || '').trim();
  const stderr = String(result?.stderr || '').trim();
  const details = [stdout, stderr].filter(Boolean).join('\n').trim();

  if (result?.error) {
    return {
      success: false,
      code: -1,
      details: result.error.message
    };
  }

  return {
    success: Number(result?.status) === 0,
    code: Number.isInteger(result?.status) ? Number(result.status) : -1,
    details
  };
}

function isBenignDismFeatureResult(details = '') {
  const msg = String(details || '').toLowerCase();
  return (
    msg.includes('0x800f080c')
    || msg.includes('feature name')
    || msg.includes('unknown')
    || msg.includes('not recognized as a valid feature')
    || msg.includes('already disabled')
  );
}

async function disableWindowsHypervisorStack() {
  if (process.platform !== 'win32') {
    return {
      success: false,
      unsupported: true,
      message: 'This action is available on Windows only.'
    };
  }

  if (!isRunningAsAdmin()) {
    return {
      success: false,
      requiresAdmin: true,
      message: 'Administrator mode is required to disable Windows virtualization blockers.'
    };
  }

  const attemptedActions = [];
  const warnings = [];
  const failures = [];
  const featureNames = [
    'Microsoft-Hyper-V-All',
    'HypervisorPlatform',
    'VirtualMachinePlatform'
  ];

  for (const featureName of featureNames) {
    const result = runWindowsCommand(
      'dism.exe',
      ['/online', '/Disable-Feature', `/FeatureName:${featureName}`, '/NoRestart'],
      180000
    );

    attemptedActions.push(`DISM disable ${featureName}: ${result.success ? 'OK' : `exit ${result.code}`}`);

    if (result.success) continue;
    if (isBenignDismFeatureResult(result.details)) {
      warnings.push(`${featureName}: ${result.details || 'Feature is not present on this Windows edition.'}`);
      continue;
    }

    failures.push(`${featureName}: ${result.details || `exit code ${result.code}`}`);
  }

  const hypervisorLaunch = runWindowsCommand(
    'bcdedit.exe',
    ['/set', 'hypervisorlaunchtype', 'off'],
    20000
  );
  attemptedActions.push(`BCDEdit hypervisorlaunchtype off: ${hypervisorLaunch.success ? 'OK' : `exit ${hypervisorLaunch.code}`}`);

  if (!hypervisorLaunch.success) {
    failures.push(`bcdedit: ${hypervisorLaunch.details || `exit code ${hypervisorLaunch.code}`}`);
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: 'Some Windows virtualization blockers could not be disabled automatically.',
      attemptedActions,
      warnings,
      failures,
      rebootRequired: false
    };
  }

  return {
    success: true,
    message: 'Windows virtualization blockers were disabled. Restart Windows, then run VM Xposed again.',
    attemptedActions,
    warnings,
    rebootRequired: true
  };
}

async function executeWindowsHostRecoveryAction(actionId = '') {
  if (process.platform !== 'win32') {
    return { success: false, unsupported: true, message: 'This action is available on Windows only.' };
  }

  const action = String(actionId || '').trim().toLowerCase();
  if (!action) {
    return { success: false, message: 'Recovery action is required.' };
  }

  if (action === 'disable-hypervisor-stack') {
    return disableWindowsHypervisorStack();
  }

  if (action === 'open-windows-features') {
    try {
      const child = spawn('optionalfeatures.exe', [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();
      return { success: true, message: 'Windows Features opened. Disable Hyper-V related features, then reboot.' };
    } catch (err) {
      return { success: false, message: `Could not open Windows Features: ${err.message}` };
    }
  }

  if (action === 'open-core-isolation') {
    try {
      await shell.openExternal('ms-settings:windowsdefender-device-security');
      return { success: true, message: 'Device Security settings opened. Open Core isolation details and disable Memory Integrity, then reboot.' };
    } catch (err) {
      return { success: false, message: `Could not open Device Security settings: ${err.message}` };
    }
  }

  return { success: false, message: `Unknown recovery action: ${action}` };
}

async function prepareVBoxHostRecovery() {
  if (process.platform !== 'win32') {
    return {
      success: false,
      unsupported: true,
      message: 'Host VBox driver recovery preparation is available on Windows only.',
      steps: [],
      hostActions: []
    };
  }

  const vboxPath = resolveVBoxManagePathForChecks();
  if (!vboxPath) {
    return {
      success: false,
      message: 'VBoxManage was not found. Configure VirtualBox Path in Settings or reinstall VirtualBox.',
      steps: [
        'Install or repair VirtualBox.',
        'Set Settings > Advanced > VirtualBox Path to VBoxManage.exe if it is in a custom location.'
      ],
      hostActions: []
    };
  }

  const admin = isRunningAsAdmin();
  const hostSignals = await collectWindowsVBoxRecoverySignals();
  let runtime = probeVBoxRuntimeHealth(vboxPath);
  let driver = getVBoxSupDriverState();
  const attemptedActions = [];

  if (runtime.code === 'driver-runtime' && admin && driver.state !== 'not-installed') {
    const startResult = startVBoxDriverService(String(driver.serviceName || 'vboxsup'));
    attemptedActions.push(startResult.message);
    if (startResult.success) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      runtime = probeVBoxRuntimeHealth(vboxPath);
      driver = getVBoxSupDriverState();
    }
  }

  const steps = buildVBoxHostRecoverySteps({
    isAdmin: admin,
    runtimeCode: runtime.code,
    driverState: driver.state,
    hostSignals
  });

  if (runtime.ok) {
    const message = attemptedActions.length > 0
      ? 'Host recovery preparation completed and VirtualBox runtime is now responsive.'
      : 'Host checks complete. VirtualBox runtime is already responsive.';
    return {
      success: true,
      prepared: attemptedActions.length > 0,
      message,
      runtime,
      driver,
      hostSignals,
      steps,
      hostActions: getWindowsHostRecoveryActions(hostSignals),
      attemptedActions
    };
  }

  const message = runtime.code === 'driver-runtime'
    ? 'Host recovery preparation completed, but VirtualBox kernel runtime is still unavailable.'
    : `Host recovery preparation completed with runtime warning: ${runtime.message}`;

  return {
    success: false,
    prepared: attemptedActions.length > 0,
    message,
    runtime,
    driver,
    hostSignals,
    steps,
    hostActions: getWindowsHostRecoveryActions(hostSignals),
    attemptedActions,
    requiresAdmin: !admin && runtime.code === 'driver-runtime'
  };
}

/**
 * Get comprehensive system permissions report.
 */
async function getPermissionsReport() {
  const hostSignals = process.platform === 'win32'
    ? await collectWindowsVBoxRecoverySignals()
    : null;
  const report = {
    isAdmin: isRunningAsAdmin(),
    platform: process.platform,
    checks: [],
    hostSignals,
    hostActions: getWindowsHostRecoveryActions(hostSignals)
  };
  const vboxPath = resolveVBoxManagePathForChecks();
  let hasVBoxAccess = false;
  let runtime = null;
  let driver = null;
  const recentVmStartFailure = getActiveRecentVmStartFailure();

  // Check admin status
  report.checks.push({
    name: 'Administrator Privileges',
    status: report.isAdmin ? 'granted' : 'required',
    description: report.isAdmin
      ? 'Running with full administrator access'
      : 'Some operations require admin rights'
  });

  // Check VirtualBox access
  try {
    if (!vboxPath) {
      throw new Error('VBoxManage path not found');
    }
    execFileSync(vboxPath, ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    hasVBoxAccess = true;
    report.checks.push({ name: 'VirtualBox Access', status: 'granted', description: `VBoxManage is accessible (${vboxPath})` });
  } catch {
    report.checks.push({ name: 'VirtualBox Access', status: 'unavailable', description: 'VBoxManage not found or not working' });
  }

  // Check VBoxSup driver (the kernel driver VirtualBox needs)
  if (process.platform === 'win32') {
    driver = getVBoxSupDriverState();
    runtime = probeVBoxRuntimeHealth(vboxPath);
    const activeRuntimeBlocker = getActiveVBoxRuntimeBlocker();
    if (activeRuntimeBlocker && runtime.code !== 'driver-runtime') {
      runtime = {
        ok: false,
        code: 'driver-runtime',
        message: `${activeRuntimeBlocker.message} (Detected during recent VM start checks.)`
      };
    }
    const hasRuntimeWarning = !runtime.ok && runtime.code === 'runtime-probe-warning';
    if (!vboxPath) {
      report.checks.push({ name: 'VBox Kernel Driver', status: 'unavailable', description: 'VirtualBox is not installed or VBoxManage could not be found.' });
    } else if (!runtime.ok && runtime.code === 'driver-runtime') {
      report.checks.push({ name: 'VBox Kernel Driver', status: 'unavailable', description: runtime.message });
    } else if (driver.state === 'running') {
      const description = runtime.ok || runtime.code !== 'runtime-probe-warning'
        ? driver.message
        : `${driver.message} Runtime probe warning: ${runtime.message}`;
      report.checks.push({ name: 'VBox Kernel Driver', status: hasRuntimeWarning ? 'warning' : 'granted', description });
    } else if (driver.state === 'stopped') {
      const baseDescription = `${String(driver.serviceName || 'vboxsup').toUpperCase()} is installed (on-demand).`;
      // When the driver is stopped and runtime probe returned a driver-needs-admin or driver-runtime issue,
      // don't report 'ok' — the driver can't actually load for VM starts.
      if (!runtime.ok && (runtime.code === 'driver-runtime' || runtime.code === 'driver-needs-admin')) {
        report.checks.push({ name: 'VBox Kernel Driver', status: 'unavailable', description: runtime.message });
      } else {
        const description = runtime.ok || runtime.code !== 'runtime-probe-warning'
          ? baseDescription
          : `${baseDescription} Runtime probe warning: ${runtime.message}`;
        report.checks.push({ name: 'VBox Kernel Driver', status: hasRuntimeWarning ? 'warning' : 'ok', description });
      }
    } else if (driver.state === 'not-installed') {
      report.checks.push({ name: 'VBox Kernel Driver', status: 'unavailable', description: driver.message });
    } else if (!runtime.ok && runtime.code === 'runtime-probe-warning') {
      report.checks.push({ name: 'VBox Kernel Driver', status: 'warning', description: runtime.message });
    } else {
      report.checks.push({ name: 'VBox Kernel Driver', status: 'unknown', description: driver.message });
    }
  }

  report.hostBlockers = summarizeWindowsVBoxHostBlockers({
    hostSignals,
    runtime,
    driver,
    hasVBoxAccess,
    recentVmStartFailure
  });

  // Check disk write access
  const installPath = getDefaultInstallPath();
  try {
    const fs = require('fs');
    fs.mkdirSync(installPath, { recursive: true });
    const testFile = path.join(installPath, '.write-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    report.checks.push({ name: 'Disk Write Access', status: 'granted', description: `Can write to: ${installPath}` });
  } catch {
    report.checks.push({ name: 'Disk Write Access', status: 'denied', description: `Cannot write to: ${installPath}` });
  }

  // Check network access
  report.checks.push({ name: 'Network Access', status: 'granted', description: 'Required for downloading Ubuntu ISO' });

  // Check Hyper-V status
  if (process.platform === 'win32') {
    try {
      const result = execSync('powershell -Command "(Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V).State"',
        { encoding: 'utf8', timeout: 10000 }).trim();
      const hyperVEnabled = result === 'Enabled';
      report.checks.push({
        name: 'Hyper-V Status',
        status: hyperVEnabled ? 'warning' : 'ok',
        description: hyperVEnabled ? 'Hyper-V is enabled — may conflict with VirtualBox' : 'Hyper-V is disabled — no conflicts'
      });
    } catch {
      report.checks.push({ name: 'Hyper-V Status', status: 'unknown', description: 'Could not determine Hyper-V status' });
    }
  }

  return report;
}

async function runPowerShellJson(command) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', command],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 * 2 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
          return;
        }
        try {
          const rawOutput = String(stdout || '').trim();
          const candidate = rawOutput || '{}';
          try {
            resolve(JSON.parse(candidate));
            return;
          } catch {
            const firstBrace = candidate.indexOf('{');
            const lastBrace = candidate.lastIndexOf('}');
            if (firstBrace >= 0 && lastBrace > firstBrace) {
              try {
                resolve(JSON.parse(candidate.slice(firstBrace, lastBrace + 1)));
              } catch {
                resolve({});
              }
              return;
            }
            resolve({});
          }
        } catch (parseErr) {
          reject(new Error(`Invalid JSON from PowerShell: ${parseErr.message}`));
        }
      }
    );
  });
}

async function getRealtimeHostMetrics() {
  if (process.platform !== 'win32') {
    return {
      success: true,
      timestamp: new Date().toISOString(),
      cpuLoadPercent: 0,
      memoryUsagePercent: 0,
      totalMemoryGb: 0,
      usedMemoryGb: 0,
      diskReadBytesPerSec: 0,
      diskWriteBytesPerSec: 0,
      netRxBytesPerSec: 0,
      netTxBytesPerSec: 0,
      adapters: []
    };
  }

  const normalizeMetrics = (metrics = {}) => {
    const normalizePercent = (value) => {
      const parsed = Number(value || 0);
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Math.min(100, parsed));
    };
    const rawAdapters = Array.isArray(metrics.adapters)
      ? metrics.adapters
      : (metrics.adapters && typeof metrics.adapters === 'object' ? [metrics.adapters] : []);
    return {
      success: metrics.success !== false,
      timestamp: metrics.timestamp || new Date().toISOString(),
      cpuLoadPercent: normalizePercent(
        metrics.cpuLoadPercent
        ?? metrics.cpuPercent
        ?? metrics.CPULoadPercent
      ),
      memoryUsagePercent: normalizePercent(
        metrics.memoryUsagePercent
        ?? metrics.memUsedPercent
        ?? metrics.MemoryUsagePercent
      ),
      totalMemoryGb: Number(metrics.totalMemoryGb || metrics.memTotalGb || 0),
      usedMemoryGb: Number(metrics.usedMemoryGb || metrics.memUsedGb || 0),
      diskReadBytesPerSec: Number(metrics.diskReadBytesPerSec || 0),
      diskWriteBytesPerSec: Number(metrics.diskWriteBytesPerSec || 0),
      netRxBytesPerSec: Number(metrics.netRxBytesPerSec || 0),
      netTxBytesPerSec: Number(metrics.netTxBytesPerSec || 0),
      adapters: rawAdapters.map((adapter) => ({
        name: String(adapter.Name || adapter.name || ''),
        bytesReceivedPerSec: Number(adapter.BytesReceivedPersec || adapter.bytesReceivedPerSec || 0),
        bytesSentPerSec: Number(adapter.BytesSentPersec || adapter.bytesSentPerSec || 0),
        bytesTotalPerSec: Number(adapter.BytesTotalPersec || adapter.bytesTotalPerSec || 0)
      }))
    };
  };
  const scoreMetrics = (metrics = {}) => {
    const adapterCount = Array.isArray(metrics.adapters) ? metrics.adapters.length : 0;
    const networkThroughput = Number(metrics.netRxBytesPerSec || 0) + Number(metrics.netTxBytesPerSec || 0);
    const diskThroughput = Number(metrics.diskReadBytesPerSec || 0) + Number(metrics.diskWriteBytesPerSec || 0);
    const cpuSignal = Number(metrics.cpuLoadPercent || 0) > 0 ? 3 : 0;
    const memSignal = Number(metrics.memoryUsagePercent || 0) > 0 ? 3 : 0;
    return (adapterCount * 10) + (networkThroughput > 0 ? 4 : 0) + (diskThroughput > 0 ? 2 : 0) + cpuSignal + memSignal;
  };

  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$diskRead = 0; $diskWrite = 0; $rx = 0; $tx = 0; $cpuLoad = 0; $memUsedPct = 0; $memTotalGb = 0; $memUsedGb = 0; $adapters = @()",
    "$excludePattern = 'Loopback|isatap|Teredo|Pseudo|VMware|VirtualBox Host-Only|Npcap|Bluetooth|vEthernet|Hyper-V|TAP-Windows|Host-Only|docker|vethernet'",
    "try {",
    "  $cpuRow = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1 PercentProcessorTime",
    "  if ($cpuRow -and $cpuRow.PSObject.Properties['PercentProcessorTime']) {",
    "    $cpuLoad = [double]$cpuRow.PercentProcessorTime",
    "  }",
    "} catch {}",
    "try {",
    "  $osInfo = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 TotalVisibleMemorySize,FreePhysicalMemory",
    "  if ($osInfo) {",
    "    $totalKb = [double]$osInfo.TotalVisibleMemorySize",
    "    $freeKb = [double]$osInfo.FreePhysicalMemory",
    "    if ($totalKb -gt 0) {",
    "      $usedKb = [math]::Max(0, $totalKb - $freeKb)",
    "      $memUsedPct = ($usedKb / $totalKb) * 100",
    "      $memTotalGb = [math]::Round($totalKb / 1MB, 2)",
    "      $memUsedGb = [math]::Round($usedKb / 1MB, 2)",
    "    }",
    "  }",
    "} catch {}",
    "try {",
    "  $disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1 DiskReadBytesPersec,DiskWriteBytesPersec",
    "  if ($disk) {",
    "    if ($disk.PSObject.Properties['DiskReadBytesPersec']) { $diskRead = [double]$disk.DiskReadBytesPersec }",
    "    if ($disk.PSObject.Properties['DiskWriteBytesPersec']) { $diskWrite = [double]$disk.DiskWriteBytesPersec }",
    "  }",
    "} catch {}",
    "try {",
    "  $netRows = @(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface)",
    "  if ($netRows.Count -eq 0) {",
    "    $netRows = @(Get-CimInstance Win32_PerfFormattedData_Counters_NetworkInterface)",
    "  }",
    "  $netRows = @($netRows | Where-Object { $_.Name -and $_.Name -notmatch $excludePattern })",
    "  foreach ($row in $netRows) {",
    "    $recv = 0; $sent = 0",
    "    if ($row.PSObject.Properties['BytesReceivedPersec']) { $recv = [double]$row.BytesReceivedPersec } elseif ($row.PSObject.Properties['BytesReceivedPerSec']) { $recv = [double]$row.BytesReceivedPerSec }",
    "    if ($row.PSObject.Properties['BytesSentPersec']) { $sent = [double]$row.BytesSentPersec } elseif ($row.PSObject.Properties['BytesSentPerSec']) { $sent = [double]$row.BytesSentPerSec }",
    "    $total = $recv + $sent",
    "    $rx += $recv; $tx += $sent",
    "    $adapters += [PSCustomObject]@{ Name = [string]$row.Name; BytesReceivedPersec = $recv; BytesSentPersec = $sent; BytesTotalPersec = $total }",
    "  }",
    "  $adapters = @($adapters | Sort-Object -Property BytesTotalPersec -Descending | Select-Object -First 8)",
    "} catch {}",
    "[PSCustomObject]@{",
    "  success = $true",
    "  timestamp = (Get-Date).ToString('o')",
    "  cpuLoadPercent = [double]$cpuLoad",
    "  memoryUsagePercent = [double]$memUsedPct",
    "  totalMemoryGb = [double]$memTotalGb",
    "  usedMemoryGb = [double]$memUsedGb",
    "  diskReadBytesPerSec = [double]$diskRead",
    "  diskWriteBytesPerSec = [double]$diskWrite",
    "  netRxBytesPerSec = [double]$rx",
    "  netTxBytesPerSec = [double]$tx",
    "  adapters = $adapters",
    "} | ConvertTo-Json -Compress -Depth 4"
  ].join('; ');

  const fallbackScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$diskRead = 0; $diskWrite = 0; $rx = 0; $tx = 0; $cpuLoad = 0; $memUsedPct = 0; $memTotalGb = 0; $memUsedGb = 0; $adapters = @()",
    "$excludePattern = 'Loopback|isatap|Teredo|Pseudo|VMware|VirtualBox Host-Only|Npcap|Bluetooth|vEthernet|Hyper-V|TAP-Windows|Host-Only|docker|vethernet'",
    "try {",
    "  $cpuCounter = Get-Counter -Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 1",
    "  foreach ($sample in $cpuCounter.CounterSamples) {",
    "    if ($sample.Path -like '*% Processor Time') {",
    "      $cpuLoad = [double]$sample.CookedValue",
    "    }",
    "  }",
    "} catch {}",
    "try {",
    "  $memoryCounter = Get-Counter -Counter '\\Memory\\% Committed Bytes In Use' -SampleInterval 1 -MaxSamples 1",
    "  foreach ($sample in $memoryCounter.CounterSamples) {",
    "    if ($sample.Path -like '*% Committed Bytes In Use') {",
    "      $memUsedPct = [double]$sample.CookedValue",
    "    }",
    "  }",
    "} catch {}",
    "try {",
    "  $osInfo = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 TotalVisibleMemorySize,FreePhysicalMemory",
    "  if ($osInfo) {",
    "    $totalKb = [double]$osInfo.TotalVisibleMemorySize",
    "    $freeKb = [double]$osInfo.FreePhysicalMemory",
    "    if ($totalKb -gt 0) {",
    "      $usedKb = [math]::Max(0, $totalKb - $freeKb)",
    "      if ($memUsedPct -le 0) { $memUsedPct = ($usedKb / $totalKb) * 100 }",
    "      $memTotalGb = [math]::Round($totalKb / 1MB, 2)",
    "      $memUsedGb = [math]::Round($usedKb / 1MB, 2)",
    "    }",
    "  }",
    "} catch {}",
    "try {",
    "  $diskCounter = Get-Counter -Counter @('\\PhysicalDisk(_Total)\\Disk Read Bytes/sec','\\PhysicalDisk(_Total)\\Disk Write Bytes/sec') -SampleInterval 1 -MaxSamples 1",
    "  foreach ($sample in $diskCounter.CounterSamples) {",
    "    if ($sample.Path -like '*Disk Read Bytes/sec') { $diskRead = [double]$sample.CookedValue }",
    "    if ($sample.Path -like '*Disk Write Bytes/sec') { $diskWrite = [double]$sample.CookedValue }",
    "  }",
    "} catch {}",
    "try {",
    "  $netCounter = Get-Counter -Counter @('\\Network Interface(*)\\Bytes Received/sec','\\Network Interface(*)\\Bytes Sent/sec') -SampleInterval 1 -MaxSamples 1",
    "  $map = @{}",
    "  foreach ($sample in $netCounter.CounterSamples) {",
    "    $name = [string]$sample.InstanceName",
    "    if (-not $name -or $name -match $excludePattern) { continue }",
    "    if (-not $map.ContainsKey($name)) {",
    "      $map[$name] = [PSCustomObject]@{ Name = $name; BytesReceivedPersec = 0; BytesSentPersec = 0; BytesTotalPersec = 0 }",
    "    }",
    "    if ($sample.Path -like '*Bytes Received/sec') {",
    "      $map[$name].BytesReceivedPersec = [double]$sample.CookedValue",
    "    } elseif ($sample.Path -like '*Bytes Sent/sec') {",
    "      $map[$name].BytesSentPersec = [double]$sample.CookedValue",
    "    }",
    "  }",
    "  foreach ($item in $map.Values) {",
    "    $item.BytesTotalPersec = [double]$item.BytesReceivedPersec + [double]$item.BytesSentPersec",
    "    $rx += [double]$item.BytesReceivedPersec",
    "    $tx += [double]$item.BytesSentPersec",
    "    $adapters += $item",
    "  }",
    "  $adapters = @($adapters | Sort-Object -Property BytesTotalPersec -Descending | Select-Object -First 8)",
    "} catch {}",
    "[PSCustomObject]@{",
    "  success = $true",
    "  timestamp = (Get-Date).ToString('o')",
    "  cpuLoadPercent = [double]$cpuLoad",
    "  memoryUsagePercent = [double]$memUsedPct",
    "  totalMemoryGb = [double]$memTotalGb",
    "  usedMemoryGb = [double]$memUsedGb",
    "  diskReadBytesPerSec = [double]$diskRead",
    "  diskWriteBytesPerSec = [double]$diskWrite",
    "  netRxBytesPerSec = [double]$rx",
    "  netTxBytesPerSec = [double]$tx",
    "  adapters = $adapters",
    "} | ConvertTo-Json -Compress -Depth 4"
  ].join('; ');

  let primaryMetrics = null;
  let fallbackMetrics = null;
  try {
    primaryMetrics = normalizeMetrics(await runPowerShellJson(psScript));
  } catch {}
  try {
    fallbackMetrics = normalizeMetrics(await runPowerShellJson(fallbackScript));
  } catch {}

  if (primaryMetrics && fallbackMetrics) {
    return scoreMetrics(fallbackMetrics) > scoreMetrics(primaryMetrics)
      ? fallbackMetrics
      : primaryMetrics;
  }
  if (fallbackMetrics) return fallbackMetrics;
  if (primaryMetrics) return primaryMetrics;

  return {
    success: false,
    timestamp: new Date().toISOString(),
    cpuLoadPercent: 0,
    memoryUsagePercent: 0,
    totalMemoryGb: 0,
    usedMemoryGb: 0,
    diskReadBytesPerSec: 0,
    diskWriteBytesPerSec: 0,
    netRxBytesPerSec: 0,
    netTxBytesPerSec: 0,
    adapters: []
  };
}

function getDirectorySizeBytes(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return 0;
  let total = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'logs') continue;
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {}
      }
    }
  }
  return total;
}

async function collectVmStorageUsage() {
  await virtualbox.init();
  const listRaw = await virtualbox._run(['list', 'vms']);
  const vmNames = parseVmNamesFromList(listRaw);
  const items = [];
  for (const vmName of vmNames) {
    try {
      const info = await virtualbox.getVMInfo(vmName);
      const cfgFile = String(info?.CfgFile || '').replace(/"/g, '');
      const vmDir = cfgFile ? path.dirname(cfgFile) : '';
      const sizeBytes = vmDir ? getDirectorySizeBytes(vmDir) : 0;
      items.push({
        name: vmName,
        cfgFile,
        vmDir,
        sizeBytes,
        sizeGb: Number((sizeBytes / (1024 ** 3)).toFixed(2))
      });
    } catch {
      items.push({
        name: vmName,
        cfgFile: '',
        vmDir: '',
        sizeBytes: 0,
        sizeGb: 0
      });
    }
  }
  const totalBytes = items.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  return {
    success: true,
    totalBytes,
    totalGb: Number((totalBytes / (1024 ** 3)).toFixed(2)),
    items
  };
}

// ─── Window Creation ───────────────────────────────────────────────────

/**
 * Create the main application window.
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 650,
    title: 'VM Xposed',
    icon: resolveAppIcon(),
    backgroundColor: '#0f1115',
    darkTheme: true,
    vibrancy: 'sidebar',          // macOS Vibrancy
    visualEffectState: 'active',  // Force acrylic state
    show: false,  // Show after ready-to-show to prevent white flash
    webPreferences: {
      preload: prodUtils.getPreloadScriptPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,  // ✅ SANDBOX ENABLED FOR SECURITY
      enableRemoteModule: false,
      allowRunningInsecureContent: false,
      webSecurity: true,
      spellcheck: true
    }
  });

  // Build application menu
  buildAppMenu();

  // Load the UI using production-safe path
  mainWindow.loadFile(prodUtils.getRendererHtmlPath());

  // Show window when ready (prevents white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    // mainWindow.webContents.openDevTools();
  }
}

/**
 * Build the application menu with Permissions and Help.
 */
function buildAppMenu() {
  const isAdmin = isRunningAsAdmin();

  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Clear Saved State',
          click: async () => {
            const result = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              title: 'Clear Saved State',
              message: 'This will delete all saved progress. You will need to restart the setup from scratch.',
              buttons: ['Cancel', 'Clear State'],
              defaultId: 0,
              cancelId: 0
            });
            if (result.response === 1) {
              await orchestrator.clearSavedState();
              mainWindow.webContents.send('setup:stateCleared');
            }
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Permissions',
      submenu: [
        {
          label: isAdmin ? '🛡️ Running as Administrator' : '⚠️ Not Running as Administrator',
          enabled: false
        },
        { type: 'separator' },
        {
          label: '🔄 Restart as Administrator',
          visible: !isAdmin,
          click: () => {
            restartAsAdmin();
          }
        },
        {
          label: '📋 View Permissions Report',
          click: () => {
            mainWindow.webContents.send('permissions:showReport');
          }
        },
        { type: 'separator' },
        {
          label: '🔧 Fix VirtualBox Config',
          click: async () => {
            try {
              await virtualbox.init();
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'VirtualBox Config',
                message: 'VirtualBox configuration checked and repaired if needed.',
                buttons: ['OK']
              });
            } catch (err) {
              dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'VirtualBox Config Error',
                message: `Could not repair: ${err.message}`,
                buttons: ['OK']
              });
            }
          }
        },
        {
          label: '🗑️ Delete Existing V Os',
          click: async () => {
            const result = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              title: 'Delete V Os',
              message: 'This will list and optionally delete VM Xposed V Os. Continue?',
              buttons: ['Cancel', 'Show V Os'],
              defaultId: 0,
              cancelId: 0
            });
            if (result.response === 1) {
              mainWindow.webContents.send('permissions:showVMCleanup');
            }
          }
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Log File',
          click: async () => {
            const logFile = logger.ensureLogFile();
            if (!logFile) {
              logger.warn('App', 'Could not prepare log file, opening log folder instead.');
              await shell.openPath(logger.logDir);
              return;
            }

            const openResult = await shell.openPath(logFile);
            if (openResult) {
              logger.warn('App', `Could not open log file: ${openResult}`);
              await shell.openPath(logger.logDir);
            }
          }
        },
        {
          label: 'Open VirtualBox Manager',
          click: () => {
            try {
              if (process.platform === 'win32') {
                // Use production-safe VirtualBox detection
                const vboxPath = prodUtils.findVirtualBoxOnWindows();
                if (!vboxPath) {
                  dialog.showErrorBox('VirtualBox Not Found', 'VirtualBox installation could not be located.');
                  return;
                }
                // Use execFile with array args to avoid shell injection
                const { execFile: execFileSync } = require('child_process');
                execFileSync(vboxPath, [], { detached: true, stdio: 'ignore' });
              } else {
                // Linux/macOS
                exec('virtualbox &', { detached: true });
              }
            } catch (err) {
              logger.warn('App', `Could not open VirtualBox Manager: ${err.message}`);
              dialog.showErrorBox('Error', `Could not launch VirtualBox: ${err.message}`);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'About VM Xposed',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About VM Xposed',
              message: `VM Xposed v${normalizeVersionString(app.getVersion())}`,
              detail: `One-click virtual OS setup with full automation.\n\nPlatform: ${process.platform} ${process.arch}\nElectron: ${process.versions.electron}\nNode: ${process.versions.node}\nAdmin: ${isAdmin ? 'Yes' : 'No'}`
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

/**
 * Register all IPC handlers for renderer ↔ main communication.
 */
function registerIPC() {
  const startupPrefs = readUiPrefsFromDisk();
  applyPreferredVirtualBoxPath(startupPrefs);
  applyLoggerPreferences(startupPrefs);

  // ─── Get initial configuration (defaults, versions) ─────────────
  ipcMain.handle('config:getDefaults', async () => {
    return {
      vmDefaults: VM_DEFAULTS,
      ubuntuVersions: Object.keys(UBUNTU_RELEASES),
      osCatalog: runtimeOSCatalog,
      osCategories: getCategoriesFromCatalog(runtimeOSCatalog),
      defaultInstallPath: getDefaultInstallPath(),
      defaultSharedFolder: getDefaultSharedFolderPath(),
      defaultDownloadDir: getDownloadDir()
    };
  });

  ipcMain.handle('config:getUiPrefs', async () => {
    try {
      return { success: true, prefs: readUiPrefsFromDisk() };
    } catch (err) {
      return { success: false, prefs: {}, error: err.message };
    }
  });

  ipcMain.handle('config:saveUiPrefs', async (event, prefs = {}) => {
    try {
      const sanitize = (value, fallback = '') => {
        if (value === undefined || value === null) return fallback;
        return String(value).trim();
      };
      const sanitizeEnum = (value, allowed, fallback) => {
        const normalized = String(value ?? '').trim().toLowerCase();
        return allowed.includes(normalized) ? normalized : fallback;
      };
      const sanitizeInt = (value, min, max, fallback) => {
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(min, Math.min(max, parsed));
      };
      const storedPrefs = readUiPrefsFromDisk();
      const credentialStorage = sanitizeEnum(
        prefs.credentialStorage,
        ['keychain', 'session'],
        sanitizeEnum(storedPrefs.credentialStorage, ['keychain', 'session'], 'keychain')
      );
      const guestUsername = sanitize(
        prefs.guestUsername,
        sanitize(storedPrefs.guestUsername, sanitize(storedPrefs.username, 'guest'))
      ) || 'guest';
      const defaultUserUsername = sanitize(
        prefs.defaultUserUsername,
        sanitize(storedPrefs.defaultUserUsername, 'user')
      ) || 'user';
      const guestPassword = credentialStorage === 'session'
        ? ''
        : String(prefs.guestPassword ?? storedPrefs.guestPassword ?? storedPrefs.password ?? 'guest') || 'guest';
      const defaultUserPassword = credentialStorage === 'session'
        ? ''
        : String(prefs.defaultUserPassword ?? storedPrefs.defaultUserPassword ?? 'user') || 'user';

      const merged = {
        ...storedPrefs,
        installPath: sanitize(prefs.installPath),
        sharedFolderPath: sanitize(prefs.sharedFolderPath),
        downloadPath: sanitize(prefs.downloadPath),
        startFullscreen: prefs.startFullscreen !== false,
        accelerate3d: prefs.accelerate3d === true,
        enableSharedFolder: prefs.enableSharedFolder === undefined
          ? !!storedPrefs.enableSharedFolder
          : !!prefs.enableSharedFolder,
        defaultUserUsername,
        defaultUserPassword,
        guestUsername,
        guestPassword,
        username: guestUsername,
        password: guestPassword,
        theme: 'dark',
        visualEffectsMode: sanitizeEnum(prefs.visualEffectsMode, ['lite', 'full'], sanitizeEnum(storedPrefs.visualEffectsMode, ['lite', 'full'], 'lite')),
        language: sanitizeEnum(prefs.language, ['en', 'hi'], sanitizeEnum(storedPrefs.language, ['en', 'hi'], 'en')),
        startupView: sanitizeEnum(prefs.startupView, ['dashboard', 'machines', 'wizard', 'library', 'snapshots', 'storage', 'network', 'settings', 'download', 'credits'], sanitizeEnum(storedPrefs.startupView, ['dashboard', 'machines', 'wizard', 'library', 'snapshots', 'storage', 'network', 'settings', 'download', 'credits'], 'dashboard')),
        notificationLevel: sanitizeEnum(prefs.notificationLevel, ['all', 'important', 'minimal'], sanitizeEnum(storedPrefs.notificationLevel, ['all', 'important', 'minimal'], 'important')),
        virtualBoxPath: sanitize(prefs.virtualBoxPath, sanitize(storedPrefs.virtualBoxPath)),
        adminModePolicy: 'manual',
        autoRepairLevel: sanitizeEnum(prefs.autoRepairLevel, ['none', 'safe', 'full'], sanitizeEnum(storedPrefs.autoRepairLevel, ['none', 'safe', 'full'], 'safe')),
        maxHostRamPercent: sanitizeInt(prefs.maxHostRamPercent, 40, 95, sanitizeInt(storedPrefs.maxHostRamPercent, 40, 95, 75)),
        maxHostCpuPercent: sanitizeInt(prefs.maxHostCpuPercent, 40, 95, sanitizeInt(storedPrefs.maxHostCpuPercent, 40, 95, 75)),
        vmDefaultPreset: sanitizeEnum(prefs.vmDefaultPreset, ['beginner', 'balanced', 'advanced'], sanitizeEnum(storedPrefs.vmDefaultPreset, ['beginner', 'balanced', 'advanced'], 'balanced')),
        credentialStorage,
        telemetryEnabled: prefs.telemetryEnabled === undefined ? !!storedPrefs.telemetryEnabled : !!prefs.telemetryEnabled,
        trustedPaths: sanitize(prefs.trustedPaths, sanitize(storedPrefs.trustedPaths)),
        logLevel: sanitizeEnum(prefs.logLevel, ['error', 'warning', 'info', 'debug'], sanitizeEnum(storedPrefs.logLevel, ['error', 'warning', 'info', 'debug'], 'info')),
        logRetentionDays: sanitizeInt(prefs.logRetentionDays, 1, 365, sanitizeInt(storedPrefs.logRetentionDays, 1, 365, 14)),
        ignoredUpdateVersion: normalizeVersionString(sanitize(prefs.ignoredUpdateVersion, sanitize(storedPrefs.ignoredUpdateVersion))),
        lastUpdateCheckAt: sanitize(prefs.lastUpdateCheckAt, sanitize(storedPrefs.lastUpdateCheckAt))
      };

      await writeUiPrefsToDisk(merged);
      applyPreferredVirtualBoxPath(merged);
      applyLoggerPreferences(merged);
      await pruneLogFilesByRetention(merged.logRetentionDays);
      return { success: true, prefs: merged };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('app:getVersion', async () => {
    try {
      return { success: true, version: normalizeVersionString(app.getVersion()) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('update:check', async () => {
    try {
      return await checkForLatestReleaseUpdate();
    } catch (err) {
      return { success: false, error: err.message || 'Update check failed.' };
    }
  });

  ipcMain.handle('update:downloadAndInstall', async (event, payload = {}) => {
    try {
      return await downloadAndInstallLatestRelease(payload || {});
    } catch (err) {
      return { success: false, error: err.message || 'Update installation failed.' };
    }
  });

  ipcMain.handle('update:getPatchNote', async (event, payload = {}) => {
    try {
      const patchUrl = String(payload?.url || '').trim();
      if (!patchUrl) return { success: false, error: 'Patch note URL is required.' };
      if (!isTrustedRepoAssetUrl(patchUrl)) return { success: false, error: 'Untrusted patch note URL.' };
      const text = await fetchTextWithRedirects(patchUrl);
      return { success: true, text };
    } catch (err) {
      return { success: false, error: err.message || 'Failed to load patch note.' };
    }
  });

  ipcMain.handle('catalog:refreshOfficial', async () => {
    try {
      const refreshed = await refreshOfficialCatalog(runtimeOSCatalog, logger);
      runtimeOSCatalog = refreshed.catalog;
      await persistRuntimeCatalog('manual');

      return {
        success: true,
        totalAdded: refreshed.totalAdded,
        summary: refreshed.summary,
        osCatalog: runtimeOSCatalog,
        osCategories: getCategoriesFromCatalog(runtimeOSCatalog)
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── System check ───────────────────────────────────────────────
  ipcMain.handle('system:check', async (event, targetPath, options = {}) => {
    return await runSystemCheck(targetPath, options || {});
  });

  ipcMain.handle('system:fullScan', async () => {
    try {
      return await runFullSystemScan();
    } catch (err) {
      return { success: false, error: err.message || 'Full scan failed' };
    }
  });

  ipcMain.handle('system:getRealtimeMetrics', async () => {
    try {
      return await getRealtimeHostMetrics();
    } catch (err) {
      return {
        success: false,
        timestamp: new Date().toISOString(),
        cpuLoadPercent: 0,
        memoryUsagePercent: 0,
        totalMemoryGb: 0,
        usedMemoryGb: 0,
        diskReadBytesPerSec: 0,
        diskWriteBytesPerSec: 0,
        netRxBytesPerSec: 0,
        netTxBytesPerSec: 0,
        adapters: [],
        error: err.message
      };
    }
  });

  // ─── Detect VirtualBox ──────────────────────────────────────────
  ipcMain.handle('vbox:detect', async () => {
    applyPreferredVirtualBoxPath(readUiPrefsFromDisk());
    const installed = await virtualbox.init();
    if (installed) {
      const version = await virtualbox.getVersion();
      return { installed: true, version };
    }
    return { installed: false, version: null };
  });

  ipcMain.handle('vbox:ensureInstalled', async (event, options = {}) => {
    try {
      const result = await orchestrator.ensureVirtualBoxInstalled({
        downloadDir: options?.downloadDir || '',
        installerPath: options?.installerPath || '',
        onProgress: (data) => {
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('vbox:ensureProgress', data || {});
            }
          } catch {}
        }
      });
      return {
        success: true,
        installed: true,
        version: result?.version || null,
        downloaded: !!result?.downloaded,
        usedLocalInstaller: !!result?.usedLocalInstaller,
        installerPath: result?.installerPath || null
      };
    } catch (err) {
      return {
        success: false,
        installed: false,
        code: err?.code || null,
        error: err.message || 'Failed to ensure VirtualBox installation'
      };
    }
  });

  ipcMain.handle('vbox:pauseDownload', async () => {
    const paused = orchestrator.pauseVBoxDownload();
    return { success: paused };
  });

  ipcMain.handle('vbox:cancelDownload', async () => {
    const cancelled = orchestrator.cancelVBoxDownload();
    return { success: cancelled };
  });

  // ─── Folder picker dialog ──────────────────────────────────────
  ipcMain.handle('dialog:selectFolder', async (event, title, defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Select Folder',
      defaultPath: defaultPath || '',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // ─── File picker dialog (for custom ISO) ────────────────────────
  ipcMain.handle('dialog:selectFile', async (event, title, filters) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Select File',
      filters: filters || [
        { name: 'ISO Images', extensions: ['iso'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('shell:openExternal', async (event, url) => {
    try {
      if (!url || typeof url !== 'string') {
        return { success: false, error: 'Invalid URL' };
      }
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Permissions & Admin ────────────────────────────────────────
  ipcMain.handle('permissions:check', async () => {
    return await getPermissionsReport();
  });

  ipcMain.handle('permissions:restartAsAdmin', async () => {
    return restartAsAdmin();
  });

  ipcMain.handle('permissions:isAdmin', async () => {
    return isRunningAsAdmin();
  });

  ipcMain.handle('permissions:prepareHostRecovery', async () => {
    try {
      return await prepareVBoxHostRecovery();
    } catch (err) {
      return {
        success: false,
        message: `Host recovery preparation failed: ${err.message}`,
        steps: []
      };
    }
  });

  ipcMain.handle('permissions:runHostRecoveryAction', async (event, actionId) => {
    try {
      return await executeWindowsHostRecoveryAction(actionId);
    } catch (err) {
      return {
        success: false,
        message: `Host recovery action failed: ${err.message}`
      };
    }
  });

  // ─── Fix VBoxSup Driver ─────────────────────────────────────────
  ipcMain.handle('permissions:fixDriver', async () => {
    try {
      const vboxPath = resolveVBoxManagePathForChecks();
      if (!vboxPath) {
        return {
          success: false,
          message: 'VBoxManage was not found. Configure VirtualBox Path in Settings or reinstall VirtualBox.'
        };
      }

      let runtime = probeVBoxRuntimeHealth(vboxPath);
      if (runtime.ok) {
        return { success: true, message: 'VirtualBox runtime is responsive. Driver is ready.' };
      }

      const current = getVBoxSupDriverState();
      if (current.state === 'not-installed') {
        return { success: false, message: 'VirtualBox kernel driver is not installed. Reinstall or repair VirtualBox as administrator.' };
      }
      if (runtime.code !== 'driver-runtime') {
        return {
          success: true,
          message: `VirtualBox driver service is present. Runtime warning: ${runtime.message}`
        };
      }
      if (!isRunningAsAdmin()) {
        return {
          success: false,
          requiresAdmin: true,
          message: 'Continue with Admin Privilege first, then try Fix Driver again.'
        };
      }

      const startResult = startVBoxDriverService(String(current.serviceName || 'vboxsup'));
      if (!startResult.success) {
        return { success: false, message: startResult.message };
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
      runtime = probeVBoxRuntimeHealth(vboxPath);
      if (runtime.ok) {
        return { success: true, message: `${startResult.message} VirtualBox runtime is now healthy.` };
      }
      if (runtime.code === 'driver-runtime') {
        return {
          success: false,
          message: `${runtime.message} Run Prepare Host in Dashboard, then reboot and repair/reinstall VirtualBox as administrator.`
        };
      }
      return { success: true, message: `Driver service is available. Runtime warning: ${runtime.message}` };
    } catch (err) {
      return { success: false, message: `Failed to start driver: ${err.message}` };
    }
  });

  // ─── VM Management ──────────────────────────────────────────────
  ipcMain.handle('vm:list', async () => {
    try {
      await virtualbox.init();
      const { execFile: ef } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(ef);

      const { stdout } = await execFileAsync(virtualbox.vboxManagePath, ['list', 'vms']);
      const vmLines = stdout.trim().split('\n').filter(l => l.trim());

      // Also get running VMs
      let runningVMs = [];
      try {
        const { stdout: rOut } = await execFileAsync(virtualbox.vboxManagePath, ['list', 'runningvms']);
        runningVMs = rOut.trim().split('\n').filter(l => l.trim()).map(l => {
          const m = l.match(/"(.+)"/); return m ? m[1] : '';
        });
      } catch {}

      const vms = [];
      const seenVmNames = new Set();
      const { width: displayWidth, height: displayHeight } = getPrimaryDisplayResolution();
      for (const line of vmLines) {
        const match = line.match(/"(.+)"\s+\{(.+)\}/);
        if (!match) continue;

        const name = match[1];
        const uuid = match[2];
        seenVmNames.add(name);

        try {
          let info = null;
          try {
            info = await virtualbox.getVMInfo(name);
          } catch {
            info = await virtualbox.getVMInfo(uuid);
          }
          const fullscreenEnabled = await getGuestDisplayFullscreenPreference(name);
          const normalizeNetwork = (raw) => {
            const v = String(raw || '').toLowerCase();
            if (v === 'nat' || v.startsWith('nat')) return 'nat';
            if (v === 'bridged' || v.startsWith('bridged')) return 'bridged';
            if (v === 'intnet' || v === 'internal') return 'internal';
            if (v === 'hostonly' || v.startsWith('hostonly')) return 'hostonly';
            return v || 'none';
          };

          const normalizeClipboard = (raw) => {
            const v = String(raw || '').toLowerCase();
            return ['disabled', 'hosttoguest', 'guesttohost', 'bidirectional'].includes(v) ? v : 'disabled';
          };

          const normalizeDnD = (raw) => {
            const v = String(raw || '').toLowerCase();
            return ['disabled', 'hosttoguest', 'guesttohost', 'bidirectional'].includes(v) ? v : 'disabled';
          };

          const parseAudioEnabled = () => {
            const explicit = String(info.audioenabled || '').toLowerCase();
            if (explicit) return explicit === 'on';
            const audio = String(info.audio || '').toLowerCase();
            if (!audio) return false;
            return !['off', 'false', 'disabled', 'none'].includes(audio);
          };
          
          // Collect shared folders
          const sharedFolders = [];
          for (const [key, val] of Object.entries(info)) {
            if (key.startsWith('SharedFolderNameMachineMapping')) {
              const idx = key.replace('SharedFolderNameMachineMapping', '');
              sharedFolders.push({
                name: val,
                hostPath: info[`SharedFolderPathMachineMapping${idx}`] || ''
              });
            }
          }

          const rawClipboardMode = normalizeClipboard(info.clipboard || info['clipboard-mode']);
          const rawDnDMode = normalizeDnD(info.draganddrop || info['drag-and-drop']);
          let effectiveClipboardMode = rawClipboardMode;
          let effectiveDnDMode = rawDnDMode;
          const reportedState = String(info.VMState || 'poweroff').toLowerCase();
          const isVmRunning = runningVMs.includes(name) || reportedState === 'running';
          const gaReady = !!info.GuestAdditionsVersion && (parseInt(info.GuestAdditionsRunLevel || '0', 10) >= 2);
          const shouldAutoApply = shouldAutoApplyOnStart(name, isVmRunning ? 'running' : reportedState);
          if (isVmRunning && shouldAutoApply) {
            const persistedModes = await getPreferredRuntimeIntegrationModes(name, info);
            effectiveClipboardMode = normalizeClipboard(persistedModes.clipboardMode || rawClipboardMode);
            effectiveDnDMode = normalizeDnD(persistedModes.dragAndDrop || rawDnDMode);
            scheduleDeferredRuntimeIntegration(name, {
              clipboardMode: effectiveClipboardMode,
              dragAndDrop: effectiveDnDMode,
              width: displayWidth,
              height: displayHeight,
              bpp: 32,
              display: 0,
              guestDisplayFullscreen: fullscreenEnabled,
              waitForGuestAdditionsMs: fullscreenEnabled ? 600000 : 180000,
              cooldownMs: 300000
            }, 1800);
          }

          vms.push({
            name,
            uuid,
            state: isVmRunning ? 'running' : (info.VMState || 'poweroff'),
            os: info.ostype || 'Unknown',
            ram: parseInt(info.memory) || 0,
            cpus: parseInt(info.cpus) || 0,
            vram: parseInt(info.vram) || 0,
            network: normalizeNetwork(info.nic1),
            clipboard: effectiveClipboardMode,
            clipboardMode: effectiveClipboardMode,
            draganddrop: effectiveDnDMode,
            dragAndDrop: effectiveDnDMode,
            graphicscontroller: info.graphicscontroller || 'unknown',
            audioEnabled: parseAudioEnabled(),
            audioController: info.audiocontroller || 'default',
            usbEnabled: (String(info.usb || '').toLowerCase() === 'on') || ['usbohci', 'usbehci', 'usbxhci'].some(k => (info[k] || '').toLowerCase() === 'on'),
            accelerate3d: (info.accelerate3d || '').toLowerCase() === 'on',
            efiEnabled: (info.firmware || '').toLowerCase() === 'efi',
            nestedVirtualization: (info['nested-hw-virt'] || '').toLowerCase() === 'on',
            fullscreenEnabled,
            bootOrder: [info.boot1, info.boot2, info.boot3, info.boot4].filter(Boolean),
            sharedFolders,
            primarySharedFolderPath: sharedFolders[0]?.hostPath || '',
            cfgFile: (info.CfgFile || '').replace(/\\\\/g, '\\'),
            guestAdditionsVersion: info.GuestAdditionsVersion || '',
            guestAdditionsRunLevel: parseInt(info.GuestAdditionsRunLevel || '0', 10) || 0,
            integrationChecks: {
              guestAdditions: gaReady,
              fullscreenReady:
                ['vmsvga', 'vboxsvga'].includes(String(info.graphicscontroller || '').toLowerCase())
                && gaReady
                && ((parseInt(info.vram || '0', 10) || 0) >= 128),
              clipboard: gaReady && String(effectiveClipboardMode || '').toLowerCase() === 'bidirectional',
              dragDrop: gaReady && String(effectiveDnDMode || '').toLowerCase() === 'bidirectional',
              sharedFolder: gaReady && sharedFolders.length > 0
            }
          });
        } catch {
          rememberVmState(name, 'unknown');
          vms.push({
            name,
            uuid,
            state: 'unknown',
            os: 'Unknown',
            ram: 0,
            cpus: 0,
            vram: 0,
            network: 'none',
            clipboard: '?',
            clipboardMode: '?',
            draganddrop: '?',
            dragAndDrop: '?',
            graphicscontroller: '?',
            sharedFolders: [],
            primarySharedFolderPath: '',
            cfgFile: ''
          });
        }
      }

      for (const trackedVm of Array.from(vmLastKnownState.keys())) {
        if (seenVmNames.has(trackedVm)) continue;
        vmLastKnownState.delete(trackedVm);
        runtimeIntegrationLastScheduledAt.delete(trackedVm);
        runtimeIntegrationQueue.delete(trackedVm);
      }

      return { success: true, vms };
    } catch (err) {
      return { success: false, vms: [], error: err.message };
    }
  });

  ipcMain.handle('vm:resolveFromFolder', async (event, folderPath, options = {}) => {
    try {
      return await resolveVmFromFolder(folderPath, {
        registerIfNeeded: !!options?.registerIfNeeded
      });
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:scanDownloaded', async (event, rootPath) => {
    try {
      return await scanDownloadedVMs(rootPath);
    } catch (err) {
      return { success: false, candidates: [], error: err.message };
    }
  });

  ipcMain.handle('vm:storageUsage', async () => {
    try {
      return await collectVmStorageUsage();
    } catch (err) {
      return { success: false, totalBytes: 0, totalGb: 0, items: [], error: err.message };
    }
  });

  ipcMain.handle('vm:start', async (event, vmName) => {
    try {
      let uiPrefs = readUiPrefsFromDisk();
      let runtimeProbePath = '';
      const repairLevel = ['none', 'safe', 'full'].includes(String(uiPrefs.autoRepairLevel || '').toLowerCase())
        ? String(uiPrefs.autoRepairLevel).toLowerCase()
        : 'safe';
      if (repairLevel !== 'none') {
        await bootFixer.prebootValidateAndFix(vmName);
      }

      if (process.platform === 'win32') {
        try {
          const vboxPath = resolveVBoxManagePathForChecks();
          runtimeProbePath = vboxPath;
          if (vboxPath) {
            let runtime = probeVBoxRuntimeHealth(vboxPath);
            if (!runtime.ok && (runtime.code === 'driver-runtime' || runtime.code === 'driver-needs-admin')) {
              rememberVBoxRuntimeBlocker(runtime.message, 'vm-start-preflight');
              if (runtime.code === 'driver-needs-admin' && !isRunningAsAdmin()) {
                throw new Error('VirtualBox kernel driver is stopped and needs administrator privileges to start. Use "Continue with Admin Privilege" first, then try starting the V Os again.');
              }
              const driver = getVBoxSupDriverState();
              if (driver.state === 'not-installed') {
                throw new Error('VirtualBox kernel driver service is missing. Repair/reinstall VirtualBox and reboot.');
              }
              if (!isRunningAsAdmin()) {
                throw new Error('VirtualBox kernel driver runtime is unavailable. Use Continue with Admin Privilege and try again.');
              }
              const startResult = startVBoxDriverService(String(driver.serviceName || 'vboxsup'));
              if (!startResult.success) {
                throw new Error(startResult.message);
              }
              await new Promise((resolve) => setTimeout(resolve, 1500));
              runtime = probeVBoxRuntimeHealth(vboxPath);
              if (!runtime.ok && (runtime.code === 'driver-runtime' || runtime.code === 'driver-needs-admin')) {
                rememberVBoxRuntimeBlocker(runtime.message, 'vm-start-preflight');
                throw new Error(runtime.message);
              }
            } else if (!runtime.ok) {
              logger.warn('App', `VirtualBox runtime preflight warning: ${runtime.message}`);
            }
          }
        } catch (e) {
          logger.warn('App', `VBox runtime preflight failed: ${e.message}`);
          throw e;
        }
      }

      const startVmNow = async () => {
        await virtualbox.startVM(vmName);
        const reachedRunning = await waitForVmState(vmName, 'running', 45000, 2000);
        if (reachedRunning) return;

        let currentState = '';
        try {
          currentState = String(await virtualbox.getVMState(vmName) || '').toLowerCase();
        } catch {}

        if (process.platform === 'win32') {
          const logRuntimeBlocker = await detectVBoxRuntimeBlockerFromVmLogs(vmName);
          if (logRuntimeBlocker) {
            rememberVBoxRuntimeBlocker(logRuntimeBlocker.details, 'vm-start-log-timeout');
            throw new Error(logRuntimeBlocker.message);
          }
        }

        if (process.platform === 'win32' && runtimeProbePath) {
          const runtimeAfterStart = probeVBoxRuntimeHealth(runtimeProbePath);
          if (!runtimeAfterStart.ok && runtimeAfterStart.code === 'driver-runtime') {
            rememberVBoxRuntimeBlocker(runtimeAfterStart.message, 'vm-start-timeout');
            throw new Error(runtimeAfterStart.message);
          }
        }

        throw new Error(`Virtual machine did not reach running state (current state: ${currentState || 'unknown'}).`);
      };
      try {
        await startVmNow();
      } catch (startErr) {
        if (repairLevel === 'full') {
          await bootFixer.prebootValidateAndFix(vmName);
          await startVmNow();
        } else {
          throw startErr;
        }
      }
      rememberVmState(vmName, 'running');
      clearVBoxRuntimeBlocker();
      clearRecentVmStartFailure();

      try {
        const vmInfo = await virtualbox.getVMInfo(vmName);
        const integrationModes = await getPreferredRuntimeIntegrationModes(vmName, vmInfo);
        const fullscreenEnabled = await getGuestDisplayFullscreenPreference(vmName);
        const { width, height } = getPrimaryDisplayResolution();
        const runtimeOptions = {
          clipboardMode: integrationModes.clipboardMode,
          dragAndDrop: integrationModes.dragAndDrop,
          width,
          height,
          bpp: 32,
          display: 0,
          guestDisplayFullscreen: fullscreenEnabled,
          waitForGuestAdditionsMs: fullscreenEnabled ? 600000 : 180000
        };
        await virtualbox.applyRuntimeIntegration(vmName, {
          ...runtimeOptions,
          waitForGuestAdditionsMs: 0
        });
        scheduleDeferredRuntimeIntegration(vmName, runtimeOptions, 4500);
      } catch (integrationErr) {
        logger.warn('App', `Runtime guest display integration warning: ${integrationErr.message}`);
      }

      return { success: true };
    } catch (err) {
      const message = String(err?.message || '');
      let mergedMessage = message;
      const logRuntimeBlocker = await detectVBoxRuntimeBlockerFromVmLogs(vmName);
      if (logRuntimeBlocker) {
        rememberVBoxRuntimeBlocker(logRuntimeBlocker.details, 'vm-start-log-catch');
        if (!isVBoxDriverRuntimeSignature(mergedMessage)) {
          mergedMessage = mergedMessage
            ? `${mergedMessage}\n${logRuntimeBlocker.message}`
            : logRuntimeBlocker.message;
        }
      }
      const hasRuntimeSignature = isVBoxDriverRuntimeSignature(message);
      const hostLikely = hasRuntimeSignature
        || !!logRuntimeBlocker
        || /vbox kernel|kernel runtime|driver-runtime|vboxdrv|vboxsup|supr3hardened|verr_open_failed|status_object_name_not_found/i.test(message);
      if (hasRuntimeSignature) {
        rememberVBoxRuntimeBlocker(message, 'vm-start');
      }
      rememberRecentVmStartFailure(mergedMessage || 'Virtual machine start failed.', { hostLikely, vmName });
      return { success: false, error: mergedMessage || err.message };
    }
  });

  ipcMain.handle('vm:stop', async (event, vmName) => {
    try {
      await virtualbox._run(['controlvm', vmName, 'acpipowerbutton']);
      rememberVmState(vmName, 'poweroff');
      return { success: true };
    } catch (err) {
      // Force power off if ACPI fails
      try {
        await virtualbox._run(['controlvm', vmName, 'poweroff']);
        rememberVmState(vmName, 'poweroff');
        return { success: true };
      } catch (err2) {
        return { success: false, error: err2.message };
      }
    }
  });

  ipcMain.handle('vm:pause', async (event, vmName) => {
    try {
      await virtualbox._run(['controlvm', vmName, 'pause']);
      rememberVmState(vmName, 'paused');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:resume', async (event, vmName) => {
    try {
      await virtualbox._run(['controlvm', vmName, 'resume']);
      rememberVmState(vmName, 'running');
      try {
        const vmInfo = await virtualbox.getVMInfo(vmName);
        const integrationModes = await getPreferredRuntimeIntegrationModes(vmName, vmInfo);
        const fullscreenEnabled = await getGuestDisplayFullscreenPreference(vmName);
        const { width, height } = getPrimaryDisplayResolution();
        const runtimeOptions = {
          clipboardMode: integrationModes.clipboardMode,
          dragAndDrop: integrationModes.dragAndDrop,
          width,
          height,
          bpp: 32,
          display: 0,
          guestDisplayFullscreen: fullscreenEnabled,
          waitForGuestAdditionsMs: fullscreenEnabled ? 600000 : 180000
        };
        await virtualbox.applyRuntimeIntegration(vmName, {
          ...runtimeOptions,
          waitForGuestAdditionsMs: 0
        });
        scheduleDeferredRuntimeIntegration(vmName, runtimeOptions, 3000);
      } catch (integrationErr) {
        logger.warn('App', `Runtime integration after resume warning: ${integrationErr.message}`);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:delete', async (event, vmName) => {
    try {
      await virtualbox.deleteVM(vmName);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:edit', async (event, vmName, settings) => {
    try {
      settings = settings || {};
      const uiPrefs = readUiPrefsFromDisk();
      const warnings = [];
      const runSoft = async (label, runner) => {
        try {
          await runner();
        } catch (err) {
          warnings.push(`${label}: ${err.message}`);
        }
      };

      const vmInfo = await virtualbox.getVMInfo(vmName);
      const vmState = (vmInfo?.VMState || '').toLowerCase();
      const normalizeNetwork = (raw) => {
        const value = String(raw || '').toLowerCase();
        if (value === 'nat' || value.startsWith('nat')) return 'nat';
        if (value === 'bridged' || value.startsWith('bridged')) return 'bridged';
        if (value === 'intnet' || value === 'internal') return 'internal';
        if (value === 'hostonly' || value.startsWith('hostonly')) return 'hostonly';
        return 'nat';
      };
      const normalizeIntegrationMode = (raw, fallback = 'disabled') => {
        const value = String(raw || '').toLowerCase();
        return ['disabled', 'hosttoguest', 'guesttohost', 'bidirectional'].includes(value) ? value : fallback;
      };
      const normalizeBootOrder = (bootOrder) => {
        if (!Array.isArray(bootOrder)) return [];
        return bootOrder
          .map((entry) => String(entry || '').trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 4);
      };
      const normalizeSharedFolders = (folders) => {
        if (!Array.isArray(folders)) return [];
        return folders
          .map((folder) => {
            const name = String(folder?.name || '').trim().toLowerCase();
            const hostPath = String(folder?.hostPath || '')
              .trim()
              .replace(/\//g, '\\')
              .toLowerCase();
            const normalizedHostPath = /^[a-z]:\\$/i.test(hostPath)
              ? hostPath
              : hostPath.replace(/[\\]+$/, '');
            if (!name || !normalizedHostPath) return null;
            return `${name}::${normalizedHostPath}`;
          })
          .filter(Boolean)
          .sort();
      };
      const parseAudioEnabled = () => {
        const explicit = String(vmInfo.audioenabled || '').toLowerCase();
        if (explicit) return explicit === 'on';
        const audio = String(vmInfo.audio || '').toLowerCase();
        if (!audio) return false;
        return !['off', 'false', 'disabled', 'none'].includes(audio);
      };

      const currentSharedFolders = [];
      for (const [key, val] of Object.entries(vmInfo)) {
        if (!key.startsWith('SharedFolderNameMachineMapping')) continue;
        const idx = key.replace('SharedFolderNameMachineMapping', '');
        currentSharedFolders.push({
          name: val,
          hostPath: vmInfo[`SharedFolderPathMachineMapping${idx}`] || ''
        });
      }

      const currentHardware = {
        ram: parseInt(vmInfo.memory || '0', 10) || 0,
        cpus: parseInt(vmInfo.cpus || '0', 10) || 0,
        vram: parseInt(vmInfo.vram || '0', 10) || 0,
        graphicsController: String(vmInfo.graphicscontroller || 'vmsvga').toLowerCase(),
        audioController: String(vmInfo.audiocontroller || 'hda').toLowerCase(),
        networkMode: normalizeNetwork(vmInfo.nic1),
        bootOrder: normalizeBootOrder([vmInfo.boot1, vmInfo.boot2, vmInfo.boot3, vmInfo.boot4]),
        audioEnabled: parseAudioEnabled(),
        usbEnabled: (String(vmInfo.usb || '').toLowerCase() === 'on') || ['usbohci', 'usbehci', 'usbxhci'].some(k => (vmInfo[k] || '').toLowerCase() === 'on'),
        accelerate3d: String(vmInfo.accelerate3d || '').toLowerCase() === 'on',
        efiEnabled: String(vmInfo.firmware || '').toLowerCase() === 'efi',
        nestedVirtualization: String(vmInfo['nested-hw-virt'] || '').toLowerCase() === 'on',
        sharedFolders: normalizeSharedFolders(currentSharedFolders)
      };

      const requestedHardwareEdit = (
        (settings.ram !== undefined && (parseInt(settings.ram, 10) || 0) !== currentHardware.ram) ||
        (settings.cpus !== undefined && (parseInt(settings.cpus, 10) || 0) !== currentHardware.cpus) ||
        (settings.vram !== undefined && (parseInt(settings.vram, 10) || 0) !== currentHardware.vram) ||
        (settings.graphicsController !== undefined && String(settings.graphicsController || '').toLowerCase() !== currentHardware.graphicsController) ||
        (settings.audioController !== undefined && String(settings.audioController || '').toLowerCase() !== currentHardware.audioController) ||
        (settings.networkMode !== undefined && normalizeNetwork(settings.networkMode) !== currentHardware.networkMode) ||
        (settings.bootOrder !== undefined && normalizeBootOrder(settings.bootOrder).join('|') !== currentHardware.bootOrder.join('|')) ||
        (settings.audioEnabled !== undefined && !!settings.audioEnabled !== currentHardware.audioEnabled) ||
        (settings.usbEnabled !== undefined && !!settings.usbEnabled !== currentHardware.usbEnabled) ||
        (settings.accelerate3d !== undefined && !!settings.accelerate3d !== currentHardware.accelerate3d) ||
        (settings.efiEnabled !== undefined && !!settings.efiEnabled !== currentHardware.efiEnabled) ||
        (settings.nestedVirtualization !== undefined && !!settings.nestedVirtualization !== currentHardware.nestedVirtualization) ||
        (settings.sharedFolders !== undefined && normalizeSharedFolders(settings.sharedFolders).join('|') !== currentHardware.sharedFolders.join('|'))
      );

      if (vmState && vmState !== 'poweroff' && requestedHardwareEdit) {
        return {
          success: false,
          error: 'Power off the V Os before editing hardware settings (RAM/CPU/graphics/network/USB/shared folders).'
        };
      }

      if (Array.isArray(settings.sharedFolders)) {
        for (const share of settings.sharedFolders) {
          const hostPath = String(share?.hostPath || '').trim();
          if (!hostPath) continue;
          uiPrefs = await ensurePathTrustedByPrefs(hostPath, uiPrefs);
        }
        const untrustedShare = settings.sharedFolders.find((share) => {
          const hostPath = String(share?.hostPath || '').trim();
          if (!hostPath) return false;
          return !isPathTrustedByPrefs(hostPath, uiPrefs);
        });
        if (untrustedShare) {
          return {
            success: false,
            error: `Shared folder path "${String(untrustedShare.hostPath || '').trim()}" is outside Trusted Paths.`
          };
        }
      }

      if (vmState && vmState !== 'poweroff' && !requestedHardwareEdit) {
        const persistedModes = await getPreferredRuntimeIntegrationModes(vmName, vmInfo);
        const runtimeClipboard = settings.clipboardMode
          ? normalizeIntegrationMode(settings.clipboardMode, 'bidirectional')
          : persistedModes.clipboardMode;
        const runtimeDnD = settings.dragAndDrop
          ? normalizeIntegrationMode(settings.dragAndDrop, 'bidirectional')
          : persistedModes.dragAndDrop;
        const currentDnD = normalizeIntegrationMode(vmInfo.draganddrop || vmInfo['drag-and-drop'], 'disabled');
        const runtimeFullscreen = typeof settings.fullscreenEnabled === 'boolean'
          ? settings.fullscreenEnabled
          : await getGuestDisplayFullscreenPreference(vmName);

        if (settings.clipboardMode) {
          await runSoft('Clipboard persistent apply failed', () => virtualbox._run(['modifyvm', vmName, '--clipboard', settings.clipboardMode]));
          await runSoft('Clipboard preference save failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/ClipboardMode', settings.clipboardMode]));
        }
        if (settings.dragAndDrop) {
          await runSoft('Drag & drop persistent apply failed', () => virtualbox._run(['modifyvm', vmName, '--draganddrop', settings.dragAndDrop]));
          await runSoft('Drag & drop preference save failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/DragAndDropMode', settings.dragAndDrop]));
        }
        if (typeof settings.fullscreenEnabled === 'boolean') {
          await runSoft('Guest display fullscreen preference apply failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/GuestDisplayFullscreen', settings.fullscreenEnabled ? 'on' : 'off']));
          await runSoft('VirtualBox window fullscreen disable apply failed', () => virtualbox._run(['setextradata', vmName, 'GUI/Fullscreen', 'off']));
        }
        const { width, height } = getPrimaryDisplayResolution();
        const runtimeResult = await virtualbox.applyRuntimeIntegration(vmName, {
          clipboardMode: runtimeClipboard,
          dragAndDrop: runtimeDnD,
          width,
          height,
          bpp: 32,
          display: 0,
          guestDisplayFullscreen: runtimeFullscreen,
          waitForGuestAdditionsMs: runtimeFullscreen ? 60000 : 0
        });
        scheduleDeferredRuntimeIntegration(vmName, {
          clipboardMode: runtimeClipboard,
          dragAndDrop: runtimeDnD,
          width,
          height,
          bpp: 32,
          display: 0,
          guestDisplayFullscreen: runtimeFullscreen,
          waitForGuestAdditionsMs: runtimeFullscreen ? 600000 : 180000
        }, 2500);
        if (Array.isArray(runtimeResult?.warnings) && runtimeResult.warnings.length > 0) {
          warnings.push(...runtimeResult.warnings.map((warning) => `Runtime integration warning: ${warning}`));
        }

        const requestedGuestToHostDnD = settings.dragAndDrop !== undefined
          && runtimeDnD !== currentDnD
          && ['guesttohost', 'bidirectional'].includes(runtimeDnD);
        if (requestedGuestToHostDnD) {
          const guestUser = String(uiPrefs.guestUsername || uiPrefs.username || '').trim();
          const guestPass = String(uiPrefs.guestPassword ?? uiPrefs.password ?? '');
          if (!guestUser || !guestPass) {
            warnings.push('Guest-to-host drag & drop needs OS admin credentials. Set them in VM Xposed Settings > Account, then run Fix All.');
          } else {
            let guestReady = false;
            try {
              guestReady = await virtualbox.waitForGuestReady(vmName, guestUser, guestPass, 45000);
            } catch (guestReadyErr) {
              warnings.push(`Guest readiness check failed: ${guestReadyErr.message}`);
            }
            if (!guestReady) {
              warnings.push('Guest-to-host drag & drop needs an active guest login session. Sign in to the V Os, then run Fix All once.');
            } else {
              try {
                await configureGuestInside(vmName, guestUser, guestPass, null, {
                  configureSharedFolder: false,
                  sharedFolderName: 'shared'
                });
              } catch (guestErr) {
                const detail = String(guestErr?.message || 'Unknown error');
                if (/wayland|sessionx11|xorg/i.test(detail)) {
                  warnings.push('Guest session is on Wayland. Guest-to-host drag & drop requires Xorg. Log out/restart the V Os with Xorg, then run Fix All.');
                } else {
                  warnings.push(`Guest drag-drop service verification failed: ${detail}`);
                }
              }
            }
          }
        }

        return { success: true, runtimeApplied: true, warnings };
      }

      const args = ['modifyvm', vmName];
      if (settings.ram) args.push('--memory', String(settings.ram));
      if (settings.cpus) args.push('--cpus', String(settings.cpus));
      if (settings.vram) args.push('--vram', String(settings.vram));
      if (settings.graphicsController) args.push('--graphicscontroller', settings.graphicsController);
      if (settings.audioController) args.push('--audiocontroller', settings.audioController);
      if (typeof settings.audioEnabled === 'boolean') args.push('--audio-enabled', settings.audioEnabled ? 'on' : 'off');
      if (typeof settings.usbEnabled === 'boolean') {
        args.push('--usb', settings.usbEnabled ? 'on' : 'off');
        args.push('--usbohci', settings.usbEnabled ? 'on' : 'off');
        args.push('--usbehci', settings.usbEnabled ? 'on' : 'off');
        args.push('--usbxhci', settings.usbEnabled ? 'on' : 'off');
      }
      if (typeof settings.accelerate3d === 'boolean') args.push('--accelerate3d', settings.accelerate3d ? 'on' : 'off');
      if (typeof settings.efiEnabled === 'boolean') args.push('--firmware', settings.efiEnabled ? 'efi' : 'bios');
      if (typeof settings.nestedVirtualization === 'boolean') args.push('--nested-hw-virt', settings.nestedVirtualization ? 'on' : 'off');

      if (Array.isArray(settings.bootOrder) && settings.bootOrder.length > 0) {
        const [b1 = 'disk', b2 = 'dvd', b3 = 'none', b4 = 'none'] = settings.bootOrder;
        args.push('--boot1', b1, '--boot2', b2, '--boot3', b3, '--boot4', b4);
      }

      if (args.length > 2) {
        await virtualbox._run(args);
      }

      if (settings.clipboardMode) {
        await runSoft('Clipboard apply failed', () => virtualbox._run(['modifyvm', vmName, '--clipboard', settings.clipboardMode]));
        await runSoft('Clipboard preference save failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/ClipboardMode', settings.clipboardMode]));
      }
      if (settings.dragAndDrop) {
        await runSoft('Drag & drop apply failed', () => virtualbox._run(['modifyvm', vmName, '--draganddrop', settings.dragAndDrop]));
        await runSoft('Drag & drop preference save failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/DragAndDropMode', settings.dragAndDrop]));
      }

      if (settings.networkMode) {
        if (settings.networkMode === 'nat' || settings.networkMode === 'bridged') {
          await virtualbox.configureNetwork(vmName, settings.networkMode);
        } else if (settings.networkMode === 'internal') {
          await virtualbox._run(['modifyvm', vmName, '--nic1', 'intnet', '--intnet1', settings.internalNetworkName || 'intnet']);
        } else if (settings.networkMode === 'hostonly') {
          await virtualbox._run(['modifyvm', vmName, '--nic1', 'hostonly']);
        }
      }

      if (Array.isArray(settings.sharedFolders)) {
        const info = await virtualbox.getVMInfo(vmName);
        const existingShares = [];
        for (const [key, val] of Object.entries(info)) {
          if (key.startsWith('SharedFolderNameMachineMapping')) {
            existingShares.push(val);
          }
        }

        for (const shareName of existingShares) {
          try {
            await virtualbox._run(['sharedfolder', 'remove', vmName, '--name', shareName]);
          } catch {}
        }

        for (const share of settings.sharedFolders) {
          if (!share?.name || !share?.hostPath) continue;
          if (!fs.existsSync(share.hostPath)) {
            fs.mkdirSync(share.hostPath, { recursive: true });
          }
          await virtualbox.addSharedFolder(vmName, share.name, share.hostPath, share.autoMount !== false);
        }
      }

      if (typeof settings.fullscreenEnabled === 'boolean') {
        await runSoft('Guest display fullscreen preference apply failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/GuestDisplayFullscreen', settings.fullscreenEnabled ? 'on' : 'off']));
        await runSoft('VirtualBox window fullscreen disable apply failed', () => virtualbox._run(['setextradata', vmName, 'GUI/Fullscreen', 'off']));
      }

      return { success: true, warnings };
    } catch (err) {
      const raw = String(err?.message || 'Unknown error');
      if (/E_ACCESSDENIED|The object is not ready|get_ClipboardFileTransfersEnabled/i.test(raw)) {
        return {
          success: false,
          error: 'VirtualBox denied this setting update right now (session/permission lock). Close any open V Os/VirtualBox windows for this V Os and try again, or run VM Xposed as Administrator.'
        };
      }
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:getDetails', async (event, vmName) => {
    try {
      const info = await virtualbox.getVMInfo(vmName);
      const fullscreenEnabled = await getGuestDisplayFullscreenPreference(vmName);
      const normalizeNetwork = (raw) => {
        const v = String(raw || '').toLowerCase();
        if (v === 'nat' || v.startsWith('nat')) return 'nat';
        if (v === 'bridged' || v.startsWith('bridged')) return 'bridged';
        if (v === 'intnet' || v === 'internal') return 'internal';
        if (v === 'hostonly' || v.startsWith('hostonly')) return 'hostonly';
        return 'nat';
      };

      const normalizeClipboard = (raw) => {
        const v = String(raw || '').toLowerCase();
        return ['disabled', 'hosttoguest', 'guesttohost', 'bidirectional'].includes(v) ? v : 'disabled';
      };

      const normalizeDnD = (raw) => {
        const v = String(raw || '').toLowerCase();
        return ['disabled', 'hosttoguest', 'guesttohost', 'bidirectional'].includes(v) ? v : 'disabled';
      };

      const parseAudioEnabled = () => {
        const explicit = String(info.audioenabled || '').toLowerCase();
        if (explicit) return explicit === 'on';
        const audio = String(info.audio || '').toLowerCase();
        if (!audio) return false;
        return !['off', 'false', 'disabled', 'none'].includes(audio);
      };

      const sharedFolders = [];
      for (const [key, val] of Object.entries(info)) {
        if (key.startsWith('SharedFolderNameMachineMapping')) {
          const idx = key.replace('SharedFolderNameMachineMapping', '');
          sharedFolders.push({
            name: val,
            hostPath: info[`SharedFolderPathMachineMapping${idx}`] || ''
          });
        }
      }

      return {
        success: true,
        vm: {
          name: vmName,
          ram: parseInt(info.memory) || 0,
          cpus: parseInt(info.cpus) || 0,
          vram: parseInt(info.vram) || 0,
          os: info.ostype || 'Unknown',
          network: normalizeNetwork(info.nic1),
          clipboardMode: normalizeClipboard(info.clipboard || info['clipboard-mode']),
          dragAndDrop: normalizeDnD(info.draganddrop || info['drag-and-drop']),
          graphicsController: info.graphicscontroller || 'vmsvga',
          audioEnabled: parseAudioEnabled(),
          audioController: info.audiocontroller || 'hda',
          usbEnabled: (String(info.usb || '').toLowerCase() === 'on') || ['usbohci', 'usbehci', 'usbxhci'].some(k => (info[k] || '').toLowerCase() === 'on'),
          accelerate3d: (info.accelerate3d || '').toLowerCase() === 'on',
          efiEnabled: (info.firmware || '').toLowerCase() === 'efi',
          nestedVirtualization: (info['nested-hw-virt'] || '').toLowerCase() === 'on',
          fullscreenEnabled,
          bootOrder: [info.boot1, info.boot2, info.boot3, info.boot4].filter(Boolean),
          sharedFolders,
          primarySharedFolderPath: sharedFolders[0]?.hostPath || ''
        }
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:rename', async (event, oldName, newName) => {
    try {
      await virtualbox._run(['modifyvm', oldName, '--name', newName]);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:clone', async (event, sourceName, targetName) => {
    try {
      await virtualbox._run([
        'clonevm', sourceName,
        '--name', targetName,
        '--mode', 'all',
        '--register'
      ]);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:snapshots:list', async (event, vmName) => {
    try {
      await virtualbox.init();
      const snapshots = await virtualbox.listSnapshots(vmName);
      return { success: true, snapshots };
    } catch (err) {
      return { success: false, snapshots: [], error: err.message };
    }
  });

  ipcMain.handle('vm:snapshots:create', async (event, vmName, snapshotName) => {
    try {
      await virtualbox.init();
      await virtualbox.createSnapshot(vmName, snapshotName);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:snapshots:restore', async (event, vmName, snapshotRef) => {
    try {
      await virtualbox.init();
      await virtualbox.restoreSnapshot(vmName, snapshotRef);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:snapshots:delete', async (event, vmName, snapshotRef) => {
    try {
      await virtualbox.init();
      await virtualbox.deleteSnapshot(vmName, snapshotRef);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:bootFix', async (event, vmName) => {
    try {
      const result = await bootFixer.prebootValidateAndFix(vmName);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:users:list', async (event, payload) => {
    try {
      return await accountManager.listUsers(payload.vmName, payload.guestUser, payload.guestPass);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:users:create', async (event, payload) => {
    try {
      return await accountManager.createUser(payload.vmName, payload.guestUser, payload.guestPass, payload.username, payload.password);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:users:update', async (event, payload) => {
    try {
      return await accountManager.updateCredentials(
        payload.vmName,
        payload.guestUser,
        payload.guestPass,
        payload.oldUsername,
        payload.newUsername,
        payload.newPassword
      );
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:users:autoLogin', async (event, payload) => {
    try {
      return await accountManager.setAutoLogin(payload.vmName, payload.guestUser, payload.guestPass, payload.username);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:users:delete', async (event, payload) => {
    try {
      return await accountManager.deleteUser(payload.vmName, payload.guestUser, payload.guestPass, payload.username);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:showInExplorer', async (event, vmName) => {
    try {
      const normalizeFsPath = (rawValue) => {
        let value = String(rawValue || '').trim();
        if (!value) return '';
        value = value.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
        if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
          value = value.slice(1, -1).trim();
        }
        return path.normalize(value);
      };

      const payload = (vmName && typeof vmName === 'object') ? vmName : {};
      const targetVmName = String(
        (typeof vmName === 'string' ? vmName : payload.vmName) || ''
      ).trim();
      const requestedVmDir = normalizeFsPath(payload.vmDir || '');
      const info = targetVmName ? await virtualbox.getVMInfo(targetVmName) : null;

      const candidateDirs = [
        requestedVmDir,
        info?.CfgFile ? path.dirname(normalizeFsPath(info.CfgFile)) : '',
        normalizeFsPath(info?.LogFld || ''),
        normalizeFsPath(info?.SnapFld || '')
      ].filter(Boolean);

      const existingDir = candidateDirs.find((candidate) => {
        try {
          if (!candidate) return false;
          if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return true;
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return fs.existsSync(path.dirname(candidate));
          }
          return false;
        } catch {
          return false;
        }
      });

      if (!existingDir) {
        return {
          success: false,
          error: 'V Os folder was not found on disk. It may have been moved, renamed, or deleted.'
        };
      }

      const openResult = await shell.openPath(existingDir);
      if (openResult) {
        return { success: false, error: openResult };
      }

      return { success: true, path: existingDir };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:guest:configure', async (event, vmName, payload = {}) => {
    try {
      let uiPrefs = readUiPrefsFromDisk();
      const {
        guestUser = 'guest',
        guestPass = 'guest',
        sharedFolderPath = '',
        sharedFolderName = 'shared',
        enableSharedFolder = true,
        autoStartVm = false,
        startFullscreen = true,
        accelerate3d = false,
        quickRepair = false,
        clipboardMode = 'bidirectional',
        dragAndDrop = 'bidirectional'
      } = payload;
      const normalizedGuestUser = validateLinuxGuestUsername(guestUser, 'Guest account username');
      const normalizedGuestPass = String(guestPass ?? '');
      if (!normalizedGuestPass) {
        return { success: false, error: 'Guest account password is required.' };
      }

      const vmState = (await virtualbox.getVMState(vmName) || '').toLowerCase();
      const notes = [];

      try {
        await virtualbox._run(['setextradata', vmName, 'VMXposed/ClipboardMode', clipboardMode || 'bidirectional']);
        await virtualbox._run(['setextradata', vmName, 'VMXposed/DragAndDropMode', dragAndDrop || 'bidirectional']);
      } catch (prefErr) {
        notes.push(`Saved integration preference warning: ${prefErr.message}`);
      }

      if (vmState === 'running') {
        try {
          const { width, height } = getPrimaryDisplayResolution();
          const runtimeOptions = {
            clipboardMode: clipboardMode || 'bidirectional',
            dragAndDrop: dragAndDrop || 'bidirectional',
            guestDisplayFullscreen: startFullscreen !== false,
            waitForGuestAdditionsMs: startFullscreen !== false ? 120000 : 0
          };
          if (startFullscreen !== false) {
            runtimeOptions.width = width;
            runtimeOptions.height = height;
            runtimeOptions.bpp = 32;
            runtimeOptions.display = 0;
          }
          const runtime = await virtualbox.applyRuntimeIntegration(vmName, runtimeOptions);
          scheduleDeferredRuntimeIntegration(vmName, {
            ...runtimeOptions,
            waitForGuestAdditionsMs: startFullscreen !== false ? 600000 : 180000
          }, 3000);
          notes.push(runtime.warnings?.length
            ? `Runtime integration applied with warnings: ${runtime.warnings.join(' | ')}`
            : 'Applied runtime clipboard/drag-drop/display integration for running V Os.');
        } catch (runtimeErr) {
          notes.push(`Runtime clipboard/drag-drop apply warning: ${runtimeErr.message}`);
        }
      } else {
        await configureGuestFeatures(vmName, {
          fullscreen: startFullscreen !== false,
          clipboardMode: clipboardMode || 'bidirectional',
          dragAndDrop: dragAndDrop || 'bidirectional',
          accelerate3d: accelerate3d === true
        });
        notes.push('Applied host-side Guest Additions V Os settings (graphics, clipboard, drag-drop).');
      }

      let sharedFolderResult = null;
      if (enableSharedFolder && sharedFolderPath && sharedFolderPath.trim()) {
        uiPrefs = await ensurePathTrustedByPrefs(sharedFolderPath.trim(), uiPrefs);
        if (!isPathTrustedByPrefs(sharedFolderPath.trim(), uiPrefs)) {
          return {
            success: false,
            error: 'Shared folder path is outside Trusted Paths. Update VM Xposed Settings > Security & Privacy first.'
          };
        }
        sharedFolderResult = await setupSharedFolder(vmName, sharedFolderPath.trim(), sharedFolderName || 'shared');
        notes.push('Configured host shared folder mapping.');
      }

      const state = await virtualbox.getVMState(vmName);
      if (state !== 'running' && autoStartVm) {
        await virtualbox.startVM(vmName);
        notes.push('V Os started automatically for in-guest setup.');
        if (quickRepair) {
          return {
            success: true,
            pendingInGuest: true,
            message: 'Host-side integration was applied and V Os was started. Log in to the V Os, then run Fix All again to finish in-guest shared-folder and guest-service setup.',
            notes,
            sharedFolder: sharedFolderResult
          };
        }
      }

      if (state !== 'running' && !autoStartVm) {
        return {
          success: true,
          pendingInGuest: true,
          message: 'Host-side integration was applied. Start the V Os, sign in, then run Guest Setup again to finish in-guest clipboard/drag-drop/display/shared-folder services.',
          notes,
          sharedFolder: sharedFolderResult
        };
      }

      const gaWaitTimeout = quickRepair ? 45000 : 600000;
      const guestWaitTimeout = quickRepair ? 45000 : 240000;

      const gaReady = await virtualbox.waitForGuestAdditions(vmName, gaWaitTimeout);
      if (!gaReady) {
        if (quickRepair) {
          notes.push('Guest Additions not ready yet for in-guest steps.');
          return {
            success: true,
            pendingInGuest: true,
            message: 'Host-side settings were applied, but Guest Additions are not ready yet. Log in to the V Os and run Fix All again. If you still see the "Try Ubuntu / Install Ubuntu" screen, boot from the installed disk first.',
            notes,
            sharedFolder: sharedFolderResult
          };
        }
        return {
          success: false,
          error: 'Guest Additions are not ready yet. Wait for OS login, then try Guest Setup again.'
        };
      }

      const guestReady = await virtualbox.waitForGuestReady(vmName, normalizedGuestUser, normalizedGuestPass, guestWaitTimeout);
      if (!guestReady) {
        if (quickRepair) {
          notes.push('Guest login/session not ready for in-guest commands.');
          return {
            success: true,
            pendingInGuest: true,
            message: 'Host-side settings were applied, but guest login/session is not ready yet. Sign in to the V Os and run Fix All again. If you still see the "Try Ubuntu / Install Ubuntu" screen, boot from the installed disk first.',
            notes,
            sharedFolder: sharedFolderResult
          };
        }
        return {
          success: false,
          error: 'Guest OS is not ready for in-guest commands. Verify credentials and that the V Os has finished booting.'
        };
      }

      const result = await configureGuestInside(vmName, normalizedGuestUser, normalizedGuestPass, null, {
        configureSharedFolder: !!(enableSharedFolder && sharedFolderResult),
        sharedFolderName: sharedFolderName || 'shared'
      });
      const guestChecks = result?.checks || {};

      try {
        const { width, height } = getPrimaryDisplayResolution();
        const runtimeFinalOptions = {
          clipboardMode: clipboardMode || 'bidirectional',
          dragAndDrop: dragAndDrop || 'bidirectional',
          guestDisplayFullscreen: startFullscreen !== false,
          waitForGuestAdditionsMs: startFullscreen !== false ? 90000 : 0
        };
        if (startFullscreen !== false) {
          runtimeFinalOptions.width = width;
          runtimeFinalOptions.height = height;
          runtimeFinalOptions.bpp = 32;
          runtimeFinalOptions.display = 0;
        }
        const runtimeFinal = await virtualbox.applyRuntimeIntegration(vmName, runtimeFinalOptions);
        scheduleDeferredRuntimeIntegration(vmName, {
          ...runtimeFinalOptions,
          waitForGuestAdditionsMs: startFullscreen !== false ? 600000 : 180000
        }, 3000);
        if (runtimeFinal.warnings?.length) {
          notes.push(`Final runtime integration warnings: ${runtimeFinal.warnings.join(' | ')}`);
        }
      } catch (runtimeErr) {
        notes.push(`Final runtime integration warning: ${runtimeErr.message}`);
      }

      if (!result?.guestAdditionsInstalled) {
        return {
          success: false,
          error: result?.error || 'In-guest integration failed.'
        };
      }

      const postInfo = await virtualbox.getVMInfo(vmName);
      const postChecks = {
        guestAdditions: !!postInfo.GuestAdditionsVersion && ((parseInt(postInfo.GuestAdditionsRunLevel || '0', 10) || 0) >= 2),
        graphicsController: ['vmsvga', 'vboxsvga'].includes(String(postInfo.graphicscontroller || '').toLowerCase()),
        vram128: (parseInt(postInfo.vram || '0', 10) || 0) >= 128,
        clipboardBidirectional: String(postInfo.clipboard || postInfo['clipboard-mode'] || '').toLowerCase() === 'bidirectional',
        dragDropBidirectional: String(postInfo.draganddrop || postInfo['drag-and-drop'] || '').toLowerCase() === 'bidirectional',
        sharedMounted: enableSharedFolder ? guestChecks.sharedMounted !== false : true,
        sessionX11: guestChecks.sessionX11 !== false
      };
      const sessionType = String(guestChecks.sessionType || result?.sessionType || '').toLowerCase();
      const waylandActive = sessionType.includes('wayland');

      if (!postChecks.guestAdditions
        || !postChecks.graphicsController
        || !postChecks.clipboardBidirectional
        || !postChecks.dragDropBidirectional
        || !postChecks.sharedMounted
        || !postChecks.sessionX11
        || waylandActive) {
        const extraNotes = [...notes];
        if (waylandActive) {
          extraNotes.push('Wayland session is active in guest. Drag & drop guest→host needs X11. Log out or reboot guest after Guest Setup to switch to Xorg.');
        }
        if (quickRepair) {
          return {
            success: true,
            pendingInGuest: true,
            message: waylandActive
              ? 'Host-side settings are saved, but guest session is on Wayland. Switch the guest session to Xorg, then run Fix All again.'
              : 'Host-side settings are saved, but guest-side verification is not complete yet. Log in fully and run Fix All again.',
            notes: extraNotes,
            checks: postChecks,
            details: result,
            sharedFolder: sharedFolderResult
          };
        }
        return {
          success: false,
          error: waylandActive
            ? 'Guest is currently on Wayland session. Drag & drop guest→host requires X11 (Xorg).'
            : 'Guest integration verification failed. Retry Guest Setup after V Os boot/login.',
          notes: extraNotes,
          checks: postChecks,
          details: result
        };
      }

      return {
        success: true,
        message: 'Guest integration configured successfully.',
        sharedFolder: sharedFolderResult,
        notes,
        checks: postChecks,
        details: result
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Start full setup workflow ──────────────────────────────────
  ipcMain.handle('setup:start', async (event, config) => {
    const sendToRenderer = (channel, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
      }
    };

    const logHandler = (entry) => sendToRenderer('setup:log', entry);

    try {
      logger.on('log', logHandler);

      config = (config && typeof config === 'object') ? config : {};
      let uiPrefs = readUiPrefsFromDisk();

      if (config && typeof config === 'object') {
        const normalized = await normalizeSetupConfig(config, uiPrefs);
        config = normalized.config;
        for (const warning of normalized.warnings) {
          sendToRenderer('setup:progress', {
            phase: 'system_check',
            message: warning,
            percent: 1
          });
        }
        config.username = validateLinuxGuestUsername(config.username || 'guest', 'Setup guest username');
        const setupPassword = String(config.password ?? '');
        config.password = setupPassword || 'guest';
      }

      if (config?.enableSharedFolder && String(config?.sharedFolderPath || '').trim()) {
        uiPrefs = await ensurePathTrustedByPrefs(String(config.sharedFolderPath).trim(), uiPrefs);
        if (!isPathTrustedByPrefs(String(config.sharedFolderPath).trim(), uiPrefs)) {
          throw new Error('Selected shared folder path is outside Trusted Paths. Update VM Xposed Settings > Security & Privacy first.');
        }
      }

      if (!config?.customIsoPath && String(config?.isoSource || 'official') !== 'custom') {
        let resolvedProfile = runtimeOSCatalog?.[config?.osName] || null;

        if (!resolvedProfile || !resolvedProfile.downloadUrl) {
          try {
            const refreshed = await refreshOfficialCatalog(runtimeOSCatalog, logger);
            runtimeOSCatalog = refreshed.catalog;
            await persistRuntimeCatalog('setup:resolve-os-profile');
            resolvedProfile = runtimeOSCatalog?.[config?.osName] || null;
          } catch {}
        }

        if (resolvedProfile) {
          config._resolvedOsProfile = {
            name: config?.osName,
            ...resolvedProfile
          };
        } else {
          const osName = String(config?.osName || '').trim();
          const ubuntuMatch = osName.match(/Ubuntu\s+(\d{2}\.\d{2}(?:\.\d+)?)/i);
          if (ubuntuMatch?.[1]) {
            const version = ubuntuMatch[1];
            const filename = `ubuntu-${version}-desktop-amd64.iso`;
            config._resolvedOsProfile = {
              name: osName,
              category: 'Ubuntu',
              osType: 'Ubuntu_64',
              filename,
              downloadUrl: `https://old-releases.ubuntu.com/releases/${version}/${filename}`,
              sha256Url: `https://old-releases.ubuntu.com/releases/${version}/SHA256SUMS`,
              unattended: true,
              defaultUser: 'user',
              defaultPass: 'password',
              ram: 4096,
              cpus: 2,
              disk: 25600,
              vram: 128,
              graphicsController: 'vmsvga',
              notes: `Ubuntu ${version} fallback profile (old-releases.ubuntu.com)`
            };
          }
        }
      }

      if (!config?.useExistingVm) {
        const requestedVmName = String(config?.vmName || '').trim();
        if (requestedVmName) {
          try {
            await virtualbox.init();
            const alreadyExists = await virtualbox.vmExists(requestedVmName);
            if (alreadyExists) {
              config.useExistingVm = true;
              config.existingVmName = requestedVmName;
              sendToRenderer('setup:progress', {
                phase: 'create_vm',
                message: `V Os "${requestedVmName}" is already installed. Reusing it instead of downloading/installing again.`,
                percent: 100
              });
            }
          } catch (vmDetectErr) {
            logger.warn('App', `Could not pre-check existing V Os conflict: ${vmDetectErr.message}`);
          }
        }
      }

      if (config?.useExistingVm) {
        sendToRenderer('setup:phase', { id: 'system_check', label: 'System Requirements Check', status: 'active' });
        sendToRenderer('setup:progress', { phase: 'system_check', message: 'Checking VirtualBox installation...', percent: 10 });

        const ensured = await orchestrator.ensureVirtualBoxInstalled({
          onProgress: (data) => {
            if (data?.phase) {
              sendToRenderer('setup:progress', {
                phase: data.phase,
                id: data.phase,
                message: data.message,
                percent: data.percent
              });
            }
          }
        });

        if (!ensured?.success && ensured?.installed === false) {
          throw new Error(ensured?.error || 'VirtualBox is required to continue.');
        }

        sendToRenderer('setup:phase', { id: 'system_check', label: 'System Requirements Check', status: 'complete' });

        let vmName = String(config.existingVmName || '').trim();
        let importedFromFolder = false;

        if (!vmName && config.existingVmFolder) {
          sendToRenderer('setup:phase', { id: 'create_vm', label: 'Import Existing V Os', status: 'active' });
          sendToRenderer('setup:progress', { phase: 'create_vm', message: 'Searching selected folder for V Os files...', percent: 20 });

          const resolved = await resolveVmFromFolder(config.existingVmFolder, { registerIfNeeded: true });
          if (!resolved?.success) {
            throw new Error(resolved?.error || 'Could not detect a V Os from selected folder.');
          }

          vmName = resolved.vmName;
          importedFromFolder = !!resolved.imported;
          sendToRenderer('setup:progress', {
            phase: 'create_vm',
            message: importedFromFolder
              ? `Imported V Os "${vmName}" from selected folder.`
              : `Using V Os "${vmName}" from selected folder.`,
            percent: 100
          });
          sendToRenderer('setup:phase', { id: 'create_vm', label: 'Import Existing V Os', status: 'complete' });
        }

        if (!vmName) {
          throw new Error('Select an existing V Os from list or choose a V Os folder first.');
        }

        const exists = await virtualbox.vmExists(vmName);
        if (!exists) {
          throw new Error(`V Os "${vmName}" was not found in VirtualBox.`);
        }

        sendToRenderer('setup:phase', { id: 'guest_config', label: 'Configuring Guest Integration', status: 'active' });
        sendToRenderer('setup:progress', { phase: 'guest_config', message: `Applying integration settings for "${vmName}"...`, percent: 65 });

        const existingVmState = (await virtualbox.getVMState(vmName) || '').toLowerCase();
        await virtualbox._run([
          'setextradata',
          vmName,
          'VMXposed/ClipboardMode',
          config.clipboardMode || 'bidirectional'
        ]);
        await virtualbox._run([
          'setextradata',
          vmName,
          'VMXposed/DragAndDropMode',
          config.dragAndDrop || 'bidirectional'
        ]);
        if (existingVmState === 'running') {
          const { width, height } = getPrimaryDisplayResolution();
          await virtualbox.applyRuntimeIntegration(vmName, {
            clipboardMode: config.clipboardMode || 'bidirectional',
            dragAndDrop: config.dragAndDrop || 'bidirectional',
            width,
            height,
            bpp: 32,
            display: 0,
            guestDisplayFullscreen: config.startFullscreen !== false,
            waitForGuestAdditionsMs: config.startFullscreen !== false ? 120000 : 0
          });
          scheduleDeferredRuntimeIntegration(vmName, {
            clipboardMode: config.clipboardMode || 'bidirectional',
            dragAndDrop: config.dragAndDrop || 'bidirectional',
            width,
            height,
            bpp: 32,
            display: 0,
            guestDisplayFullscreen: config.startFullscreen !== false,
            waitForGuestAdditionsMs: config.startFullscreen !== false ? 600000 : 180000
          }, 3500);
          await virtualbox._run([
            'setextradata',
            vmName,
            'VMXposed/GuestDisplayFullscreen',
            config.startFullscreen !== false ? 'on' : 'off'
          ]);
        } else {
          await configureGuestFeatures(vmName, {
            fullscreen: config.startFullscreen !== false,
            clipboardMode: config.clipboardMode || 'bidirectional',
            dragAndDrop: config.dragAndDrop || 'bidirectional',
            accelerate3d: config.accelerate3d === true
          });

          await virtualbox.configureVM(vmName, {
            clipboardMode: config.clipboardMode || 'bidirectional',
            dragAndDrop: config.dragAndDrop || 'bidirectional'
          });
        }

        let sharedFolder = null;
        if (config.sharedFolderPath && String(config.sharedFolderPath).trim()) {
          sharedFolder = await setupSharedFolder(vmName, String(config.sharedFolderPath).trim());
        }

        sendToRenderer('setup:phase', { id: 'guest_config', label: 'Configuring Guest Integration', status: 'complete' });

        const state = (await virtualbox.getVMState(vmName) || '').toLowerCase();
        const shouldAutoStartVm = config?.autoStartVm === true;
        if (state !== 'running' && shouldAutoStartVm) {
          sendToRenderer('setup:phase', { id: 'wait_boot', label: 'Starting Existing V Os', status: 'active' });
          sendToRenderer('setup:progress', { phase: 'wait_boot', message: `Starting existing V Os "${vmName}"...`, percent: 85 });
          await virtualbox.startVM(vmName);
          sendToRenderer('setup:phase', { id: 'wait_boot', label: 'Starting Existing V Os', status: 'complete' });
        } else if (state !== 'running') {
          sendToRenderer('setup:phase', { id: 'wait_boot', label: 'Starting Existing V Os', status: 'skipped' });
          sendToRenderer('setup:progress', { phase: 'wait_boot', message: `V Os "${vmName}" was not auto-started. Start it manually when ready.`, percent: 100 });
        }

        const result = {
          success: true,
          reusedExisting: true,
          importedFromFolder,
          message: state === 'running' || shouldAutoStartVm
            ? `Existing V Os "${vmName}" is ready.`
            : `Existing V Os "${vmName}" is configured and ready to start manually.`,
          vmName,
          sharedFolder,
          credentials: {
            username: config.username || 'user',
            password: config.password || 'password'
          }
        };

        sendToRenderer('setup:phase', { id: 'complete', label: 'Setup Complete', status: 'complete' });
        sendToRenderer('setup:progress', {
          phase: 'complete',
          message: state === 'running' || shouldAutoStartVm
            ? `Existing V Os "${vmName}" is ready.`
            : `Existing V Os "${vmName}" is configured and ready to start manually.`,
          percent: 100
        });
        sendToRenderer('setup:complete', result);
        return result;
      }

      orchestrator.on('phase', (data) => sendToRenderer('setup:phase', data));
      orchestrator.on('progress', (data) => sendToRenderer('setup:progress', data));
      orchestrator.on('error', (data) => sendToRenderer('setup:error', data));
      orchestrator.on('complete', (data) => sendToRenderer('setup:complete', data));

      const result = await orchestrator.runSetup(config, config._resumeFrom || null);
      orchestrator.removeAllListeners();
      logger.removeListener('log', logHandler);
      return result;
    } catch (err) {
      orchestrator.removeAllListeners();
      logger.removeListener('log', logHandler);
      return { success: false, error: err.message };
    }
  });

  // ─── Cancel setup ───────────────────────────────────────────────
  ipcMain.handle('setup:pause', async () => {
    const paused = orchestrator.pause();
    return { paused };
  });

  ipcMain.handle('setup:cancel', async () => {
    const cancelled = orchestrator.cancel();
    return { cancelled };
  });

  // ─── Get setup phases (for UI display) ──────────────────────────
  ipcMain.handle('setup:getPhases', async () => {
    return orchestrator.getPhases();
  });

  // ─── Check for resumable previous setup ─────────────────────────
  ipcMain.handle('setup:checkResume', async () => {
    try {
      return await orchestrator.checkForResume();
    } catch (err) {
      logger.warn('App', `Resume check failed: ${err.message}`);
      return null;
    }
  });

  // ─── Clear saved state (start fresh) ────────────────────────────
  ipcMain.handle('setup:clearState', async () => {
    await orchestrator.clearSavedState();
    return { cleared: true };
  });
}

// ─── App Lifecycle ─────────────────────────────────────────────────────

// Single instance lock — prevent multiple windows
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.jeet.vmxposed');
    nativeTheme.themeSource = 'dark';
  }

  // Initialize logger
  await logger.init();
  const startupPrefs = readUiPrefsFromDisk();
  applyLoggerPreferences(startupPrefs);
  await pruneLogFilesByRetention(startupPrefs.logRetentionDays);
  applyPreferredVirtualBoxPath(startupPrefs);
  logger.info('App', 'VM Xposed starting...');
  logger.info('App', `Platform: ${process.platform} ${process.arch}`);
  logger.info('App', `Electron: ${process.versions.electron}`);
  logger.info('App', `Node: ${process.versions.node}`);
  logger.info('App', `Administrator: ${isRunningAsAdmin() ? 'YES' : 'NO'}`);

  if (
    process.platform === 'win32' &&
    isRunningAsAdmin() &&
    !adminElevate.isElevatedProcessFlag() &&
    !adminElevate.isStandardProcessFlag() &&
    process.env.VMXPOSED_ALLOW_ADMIN_START !== '1'
  ) {
    logger.info('App', 'Detected inherited admin launch. Relaunching as standard user...');
    const relaunchResult = await adminElevate.relaunchAsStandardUser();
    if (relaunchResult?.success) {
      app.exit(0);
      return;
    }
    logger.warn('App', `Standard-user relaunch failed: ${relaunchResult?.error || 'unknown error'}`);
    logger.warn('App', 'Continuing in current session. Set VMXPOSED_ALLOW_ADMIN_START=1 to keep admin startup.');
  }

  const cacheLoaded = loadRuntimeCatalogFromCache();
  if (!cacheLoaded) {
    logger.info('CatalogUpdater', 'No cached OS catalog found — using bundled defaults.');
  }

  registerIPC();
  createWindow();
  refreshCatalogInBackground('startup').catch((err) => {
    logger.warn('CatalogUpdater', `Startup background refresh failed: ${err.message}`);
  });
  scheduleCatalogRefresh();
});

app.on('before-quit', (event) => {
  if (isExitShutdownInProgress) return;
  isExitShutdownInProgress = true;
  event.preventDefault();

  shutdownRunningVMsOnExit()
    .finally(() => {
      app.exit(0);
    });
});

app.on('window-all-closed', () => {
  logger.info('App', 'Application closing');
  app.quit();
});

app.on('will-quit', () => {
  if (catalogRefreshTimer) {
    clearInterval(catalogRefreshTimer);
    catalogRefreshTimer = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
