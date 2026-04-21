/**
 * preload.js — Secure IPC Bridge
 * 
 * Design Decision: Uses contextBridge to expose a safe, typed API.
 * The renderer can ONLY call these methods — no direct Node.js access.
 * 
 * Two patterns:
 * 1. invoke() — Request → Response (for commands)
 * 2. on()     — Event streaming (for progress updates)
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vmInstaller', {

  // ─── Configuration ─────────────────────────────────────────────
  getDefaults: () => ipcRenderer.invoke('config:getDefaults'),
  getUiPrefs: () => ipcRenderer.invoke('config:getUiPrefs'),
  saveUiPrefs: (prefs) => ipcRenderer.invoke('config:saveUiPrefs', prefs),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadAndInstallUpdate: (payload) => ipcRenderer.invoke('update:downloadAndInstall', payload),
  getPatchNoteText: (payload) => ipcRenderer.invoke('update:getPatchNote', payload),
  refreshOfficialCatalog: () => ipcRenderer.invoke('catalog:refreshOfficial'),

  // ─── System Check ──────────────────────────────────────────────
  checkSystem: (targetPath) => ipcRenderer.invoke('system:check', targetPath),
  fullSystemScan: () => ipcRenderer.invoke('system:fullScan'),
  getRealtimeMetrics: () => ipcRenderer.invoke('system:getRealtimeMetrics'),

  // ─── VirtualBox Detection ──────────────────────────────────────
  detectVBox: () => ipcRenderer.invoke('vbox:detect'),
  ensureVBoxInstalled: (options) => ipcRenderer.invoke('vbox:ensureInstalled', options),
  pauseVBoxDownload: () => ipcRenderer.invoke('vbox:pauseDownload'),
  cancelVBoxDownload: () => ipcRenderer.invoke('vbox:cancelDownload'),

  // ─── File/Folder Dialogs ───────────────────────────────────────
  selectFolder: (title, defaultPath) => ipcRenderer.invoke('dialog:selectFolder', title, defaultPath),
  selectFile: (title, filters) => ipcRenderer.invoke('dialog:selectFile', title, filters),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ─── Setup Workflow ────────────────────────────────────────────
  startSetup: (config) => ipcRenderer.invoke('setup:start', config),
  pauseSetup: () => ipcRenderer.invoke('setup:pause'),
  cancelSetup: () => ipcRenderer.invoke('setup:cancel'),
  getPhases: () => ipcRenderer.invoke('setup:getPhases'),

  // ─── Resume / Recovery ─────────────────────────────────────────
  checkForResume: () => ipcRenderer.invoke('setup:checkResume'),
  clearSavedState: () => ipcRenderer.invoke('setup:clearState'),

  // ─── Permissions & Admin ───────────────────────────────────────
  checkPermissions: () => ipcRenderer.invoke('permissions:check'),
  isAdmin: () => ipcRenderer.invoke('permissions:isAdmin'),
  restartAsAdmin: () => ipcRenderer.invoke('permissions:restartAsAdmin'),
  fixDriver: () => ipcRenderer.invoke('permissions:fixDriver'),

  // ─── VM Management ─────────────────────────────────────────────
  listVMs: () => ipcRenderer.invoke('vm:list'),
  startVM: (name) => ipcRenderer.invoke('vm:start', name),
  stopVM: (name) => ipcRenderer.invoke('vm:stop', name),
  pauseVM: (name) => ipcRenderer.invoke('vm:pause', name),
  resumeVM: (name) => ipcRenderer.invoke('vm:resume', name),
  deleteVM: (name) => ipcRenderer.invoke('vm:delete', name),
  editVM: (name, settings) => ipcRenderer.invoke('vm:edit', name, settings),
  getVMDetails: (name) => ipcRenderer.invoke('vm:getDetails', name),
  renameVM: (oldName, newName) => ipcRenderer.invoke('vm:rename', oldName, newName),
  cloneVM: (sourceName, targetName) => ipcRenderer.invoke('vm:clone', sourceName, targetName),
  bootFixVM: (name) => ipcRenderer.invoke('vm:bootFix', name),
  listVMUsers: (payload) => ipcRenderer.invoke('vm:users:list', payload),
  createVMUser: (payload) => ipcRenderer.invoke('vm:users:create', payload),
  updateVMUser: (payload) => ipcRenderer.invoke('vm:users:update', payload),
  setVMAutoLogin: (payload) => ipcRenderer.invoke('vm:users:autoLogin', payload),
  deleteVMUser: (payload) => ipcRenderer.invoke('vm:users:delete', payload),
  configureGuestIntegration: (vmName, payload) => ipcRenderer.invoke('vm:guest:configure', vmName, payload),
  showVMInExplorer: (name) => ipcRenderer.invoke('vm:showInExplorer', name),
  resolveVMFromFolder: (folderPath, options) => ipcRenderer.invoke('vm:resolveFromFolder', folderPath, options),
  scanDownloadedVMs: (rootPath) => ipcRenderer.invoke('vm:scanDownloaded', rootPath),
  getVMStorageUsage: () => ipcRenderer.invoke('vm:storageUsage'),
  listSnapshots: (vmName) => ipcRenderer.invoke('vm:snapshots:list', vmName),
  createSnapshot: (vmName, snapshotName) => ipcRenderer.invoke('vm:snapshots:create', vmName, snapshotName),
  restoreSnapshot: (vmName, snapshotRef) => ipcRenderer.invoke('vm:snapshots:restore', vmName, snapshotRef),
  deleteSnapshot: (vmName, snapshotRef) => ipcRenderer.invoke('vm:snapshots:delete', vmName, snapshotRef),

  // ─── Event Listeners (progress streaming from main → renderer) ─
  onPhase: (callback) => {
    ipcRenderer.on('setup:phase', (event, data) => callback(data));
  },
  onProgress: (callback) => {
    ipcRenderer.on('setup:progress', (event, data) => callback(data));
  },
  onLog: (callback) => {
    ipcRenderer.on('setup:log', (event, data) => callback(data));
  },
  onError: (callback) => {
    ipcRenderer.on('setup:error', (event, data) => callback(data));
  },
  onComplete: (callback) => {
    ipcRenderer.on('setup:complete', (event, data) => callback(data));
  },
  onVBoxEnsureProgress: (callback) => {
    ipcRenderer.on('vbox:ensureProgress', (event, data) => callback(data));
  },
  onPermissionsReport: (callback) => {
    ipcRenderer.on('permissions:showReport', (event) => callback());
  },
  onStateCleared: (callback) => {
    ipcRenderer.on('setup:stateCleared', (event) => callback());
  },

  // ─── Cleanup Listeners ────────────────────────────────────────
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('setup:phase');
    ipcRenderer.removeAllListeners('setup:progress');
    ipcRenderer.removeAllListeners('setup:log');
    ipcRenderer.removeAllListeners('setup:error');
    ipcRenderer.removeAllListeners('setup:complete');
    ipcRenderer.removeAllListeners('vbox:ensureProgress');
    ipcRenderer.removeAllListeners('permissions:showReport');
    ipcRenderer.removeAllListeners('setup:stateCleared');
  }
});
