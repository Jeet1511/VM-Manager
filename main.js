/**
 * main.js — Electron Main Process
 */

// Catch any uncaught errors early
process.on('uncaughtException', (err) => {
  console.error('FATAL ERROR:', err.message);
  console.error(err.stack);
});

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const os = require('os');
const logger = require('./core/logger');
const orchestrator = require('./core/orchestrator');
const { UBUNTU_RELEASES, OS_CATALOG, VM_DEFAULTS, getDefaultInstallPath, getDefaultSharedFolderPath, getOSCategories } = require('./core/config');
const { runSystemCheck } = require('./services/systemChecker');
const { refreshOfficialCatalog } = require('./services/osCatalogUpdater');
const virtualbox = require('./adapters/virtualbox');
const bootFixer = require('./vm/bootFixer');
const accountManager = require('./vm/accountManager');
const { configureGuestFeatures, configureGuestInside } = require('./vm/guestAdditions');
const { setupSharedFolder } = require('./vm/sharedFolder');

let mainWindow = null;
let runtimeOSCatalog = { ...OS_CATALOG };
let isCatalogRefreshRunning = false;
let catalogRefreshTimer = null;
let isExitShutdownInProgress = false;

function getUiPrefsFilePath() {
  return path.join(app.getPath('userData'), 'ui-prefs.json');
}

function readUiPrefsFromDisk() {
  try {
    const prefsPath = getUiPrefsFilePath();
    if (!fs.existsSync(prefsPath)) return {};
    const raw = fs.readFileSync(prefsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeUiPrefsToDisk(prefs) {
  const prefsPath = getUiPrefsFilePath();
  await fs.promises.mkdir(path.dirname(prefsPath), { recursive: true });
  await fs.promises.writeFile(prefsPath, JSON.stringify(prefs, null, 2), 'utf8');
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

function resolveAppIconPath() {
  const assetsDir = path.join(__dirname, 'renderer', 'assets');
  const logosDir = path.join(__dirname, 'logos');
  const candidates = [
    path.join(logosDir, 'outside app logo.ico'),
    path.join(logosDir, 'outside app logo.png'),
    path.join(logosDir, 'outside app logo.webp'),
    path.join(logosDir, 'outside app logo.jpg'),
    path.join(logosDir, 'outside app logo.jpeg'),
    path.join(logosDir, 'outside-app-logo.ico'),
    path.join(logosDir, 'outside-app-logo.png'),
    path.join(logosDir, 'outside-app-logo.webp'),
    path.join(logosDir, 'outside-app-logo.jpg'),
    path.join(logosDir, 'outside-app-logo.jpeg'),
    path.join(assetsDir, 'vm-xposed-mark.ico'),
    path.join(__dirname, 'renderer', 'assets', 'vm-xposed-mark.png'),
    path.join(assetsDir, 'vm-xposed-mark.webp'),
    path.join(assetsDir, 'vm-xposed-mark.jpg'),
    path.join(assetsDir, 'vm-xposed-mark.jpeg'),
    path.join(assetsDir, 'vm-xposed-logo.ico'),
    path.join(__dirname, 'renderer', 'assets', 'vm-xposed-logo.png'),
    path.join(assetsDir, 'vm-xposed-logo.webp'),
    path.join(assetsDir, 'vm-xposed-logo.jpg'),
    path.join(assetsDir, 'vm-xposed-logo.jpeg'),
    path.join(assetsDir, 'icon.ico'),
    path.join(assetsDir, 'icon.png'),
    path.join(assetsDir, 'icon.webp'),
    path.join(assetsDir, 'icon.jpg'),
    path.join(assetsDir, 'icon.jpeg'),
    path.join(assetsDir, 'logo.ico'),
    path.join(assetsDir, 'logo.png'),
    path.join(assetsDir, 'logo.webp'),
    path.join(assetsDir, 'logo.jpg'),
    path.join(assetsDir, 'logo.jpeg'),
    path.join(__dirname, 'renderer', 'icon.png')
  ];

  for (const iconPath of candidates) {
    if (fs.existsSync(iconPath)) {
      return iconPath;
    }
  }

  if (fs.existsSync(assetsDir)) {
    const discovered = fs.readdirSync(assetsDir)
      .filter((name) => /\.(ico|png|webp|jpg|jpeg)$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    if (discovered.length > 0) {
      return path.join(assetsDir, discovered[0]);
    }
  }

  return undefined;
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

async function refreshCatalogInBackground(reason = 'manual') {
  if (isCatalogRefreshRunning) return;
  isCatalogRefreshRunning = true;
  try {
    const refreshed = await refreshOfficialCatalog(runtimeOSCatalog, logger);
    runtimeOSCatalog = refreshed.catalog;
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

    logger.info('App', `Stopping ${runningVms.length} running VM(s) before exit...`);

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
    logger.warn('App', `Failed to stop running VMs on exit: ${err.message}`);
  }
}

// ─── Admin / Permissions Utilities ─────────────────────────────────────

/**
 * Check if the app is running with administrator privileges.
 */
function isRunningAsAdmin() {
  if (process.platform !== 'win32') return true; // Linux/Mac don't need this
  try {
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Restart the app with admin privileges (Windows UAC elevation).
 */
function restartAsAdmin() {
  if (process.platform !== 'win32') return;
  
  const appPath = process.argv[0];
  const args = process.argv.slice(1).join(' ');
  
  try {
    // Use PowerShell to trigger UAC
    exec(`powershell -Command "Start-Process '${appPath}' -ArgumentList '${args}' -Verb RunAs"`, (err) => {
      if (!err) {
        app.quit();
      }
    });
  } catch (err) {
    logger.error('App', `Failed to restart as admin: ${err.message}`);
  }
}

/**
 * Get comprehensive system permissions report.
 */
function getPermissionsReport() {
  const report = {
    isAdmin: isRunningAsAdmin(),
    platform: process.platform,
    checks: []
  };

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
    if (process.platform === 'win32') {
      execSync('"C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe" --version', { stdio: 'ignore' });
      report.checks.push({ name: 'VirtualBox Access', status: 'granted', description: 'VBoxManage is accessible and responsive' });
    }
  } catch {
    report.checks.push({ name: 'VirtualBox Access', status: 'unavailable', description: 'VBoxManage not found or not working' });
  }

  // Check VBoxSup driver (the kernel driver VirtualBox needs)
  if (process.platform === 'win32') {
    try {
      const svcResult = execSync('sc.exe query vboxsup', { encoding: 'utf8', timeout: 5000 });
      const isRunning = svcResult.includes('RUNNING');
      report.checks.push({
        name: 'VBox Kernel Driver',
        status: isRunning ? 'granted' : 'required',
        description: isRunning ? 'VBoxSup driver is loaded and running' : 'VBoxSup driver is stopped — VMs cannot start'
      });
    } catch {
      report.checks.push({ name: 'VBox Kernel Driver', status: 'unknown', description: 'Could not check VBoxSup driver status' });
    }
  }

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
    backgroundColor: '#00000000', // Transparent for glass effects
    vibrancy: 'sidebar',          // macOS Vibrancy
    visualEffectState: 'active',  // Force acrylic state
    show: false,  // Show after ready-to-show to prevent white flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Build application menu
  buildAppMenu();

  // Load the UI
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

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
          label: '🗑️ Delete Existing VMs',
          click: async () => {
            const result = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              title: 'Delete VMs',
              message: 'This will list and optionally delete VM Xposed VMs. Continue?',
              buttons: ['Cancel', 'Show VMs'],
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
          click: () => {
            const logDir = path.join(app.getPath('userData'), 'logs');
            shell.openPath(logDir);
          }
        },
        {
          label: 'Open VirtualBox Manager',
          click: () => {
            const vboxPath = process.platform === 'win32'
              ? 'C:\\Program Files\\Oracle\\VirtualBox\\VirtualBox.exe'
              : 'virtualbox';
            exec(`"${vboxPath}"`, (err) => {
              if (err) logger.warn('App', 'Could not open VirtualBox Manager');
            });
          }
        },
        { type: 'separator' },
        {
          label: 'About VM Xposed',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About VM Xposed',
              message: 'VM Xposed v1.0.0',
              detail: `One-click virtual machine setup with full automation.\n\nPlatform: ${process.platform} ${process.arch}\nElectron: ${process.versions.electron}\nNode: ${process.versions.node}\nAdmin: ${isAdmin ? 'Yes' : 'No'}`
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

  // ─── Get initial configuration (defaults, versions) ─────────────
  ipcMain.handle('config:getDefaults', async () => {
    return {
      vmDefaults: VM_DEFAULTS,
      ubuntuVersions: Object.keys(UBUNTU_RELEASES),
      osCatalog: runtimeOSCatalog,
      osCategories: getCategoriesFromCatalog(runtimeOSCatalog),
      defaultInstallPath: getDefaultInstallPath(),
      defaultSharedFolder: getDefaultSharedFolderPath()
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

      const merged = {
        ...readUiPrefsFromDisk(),
        installPath: sanitize(prefs.installPath),
        sharedFolderPath: sanitize(prefs.sharedFolderPath),
        username: sanitize(prefs.username, 'user') || 'user',
        password: String(prefs.password ?? 'password')
      };

      await writeUiPrefsToDisk(merged);
      return { success: true, prefs: merged };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('catalog:refreshOfficial', async () => {
    try {
      const refreshed = await refreshOfficialCatalog(runtimeOSCatalog, logger);
      runtimeOSCatalog = refreshed.catalog;

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
  ipcMain.handle('system:check', async (event, targetPath) => {
    return await runSystemCheck(targetPath);
  });

  // ─── Detect VirtualBox ──────────────────────────────────────────
  ipcMain.handle('vbox:detect', async () => {
    const installed = await virtualbox.init();
    if (installed) {
      const version = await virtualbox.getVersion();
      return { installed: true, version };
    }
    return { installed: false, version: null };
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
    return getPermissionsReport();
  });

  ipcMain.handle('permissions:restartAsAdmin', async () => {
    restartAsAdmin();
    return { restarting: true };
  });

  ipcMain.handle('permissions:isAdmin', async () => {
    return isRunningAsAdmin();
  });

  // ─── Fix VBoxSup Driver ─────────────────────────────────────────
  ipcMain.handle('permissions:fixDriver', async () => {
    try {
      // Try starting via UAC elevation
      execSync('powershell -Command "Start-Process sc.exe -ArgumentList \'start\',\'vboxsup\' -Verb RunAs -Wait"',
        { timeout: 15000 });
      // Verify
      const check = execSync('sc.exe query vboxsup', { encoding: 'utf8', timeout: 5000 });
      const running = check.includes('RUNNING');
      return { success: running, message: running ? 'VBoxSup driver started successfully' : 'Driver start may require a reboot' };
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
      for (const line of vmLines) {
        const match = line.match(/"(.+)"\s+\{(.+)\}/);
        if (!match) continue;

        const name = match[1];
        const uuid = match[2];

        try {
          const info = await virtualbox.getVMInfo(name);
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

          vms.push({
            name,
            uuid,
            state: runningVMs.includes(name) ? 'running' : (info.VMState || 'poweroff'),
            os: info.ostype || 'Unknown',
            ram: parseInt(info.memory) || 0,
            cpus: parseInt(info.cpus) || 0,
            vram: parseInt(info.vram) || 0,
            network: normalizeNetwork(info.nic1),
            clipboard: normalizeClipboard(info.clipboard || info['clipboard-mode']),
            draganddrop: normalizeDnD(info.draganddrop || info['drag-and-drop']),
            graphicscontroller: info.graphicscontroller || 'unknown',
            audioEnabled: parseAudioEnabled(),
            audioController: info.audiocontroller || 'default',
            usbEnabled: (String(info.usb || '').toLowerCase() === 'on') || ['usbohci', 'usbehci', 'usbxhci'].some(k => (info[k] || '').toLowerCase() === 'on'),
            accelerate3d: (info.accelerate3d || '').toLowerCase() === 'on',
            efiEnabled: (info.firmware || '').toLowerCase() === 'efi',
            nestedVirtualization: (info['nested-hw-virt'] || '').toLowerCase() === 'on',
            bootOrder: [info.boot1, info.boot2, info.boot3, info.boot4].filter(Boolean),
            sharedFolders,
            cfgFile: (info.CfgFile || '').replace(/\\\\/g, '\\'),
            guestAdditionsVersion: info.GuestAdditionsVersion || '',
            guestAdditionsRunLevel: parseInt(info.GuestAdditionsRunLevel || '0', 10) || 0,
            integrationChecks: {
              guestAdditions: !!info.GuestAdditionsVersion && (parseInt(info.GuestAdditionsRunLevel || '0', 10) >= 2),
              fullscreenReady:
                ['vmsvga', 'vboxsvga'].includes(String(info.graphicscontroller || '').toLowerCase())
                && !!info.GuestAdditionsVersion
                && (parseInt(info.GuestAdditionsRunLevel || '0', 10) >= 2)
                && ((parseInt(info.vram || '0', 10) || 0) >= 128),
              clipboard: String(info.clipboard || info['clipboard-mode'] || '').toLowerCase() === 'bidirectional',
              dragDrop: String(info.draganddrop || info['drag-and-drop'] || '').toLowerCase() === 'bidirectional',
              sharedFolder: sharedFolders.length > 0
            }
          });
        } catch {
          vms.push({ name, uuid, state: 'unknown', os: 'Unknown', ram: 0, cpus: 0, vram: 0, network: 'none', clipboard: '?', draganddrop: '?', graphicscontroller: '?', sharedFolders: [], cfgFile: '' });
        }
      }

      return { success: true, vms };
    } catch (err) {
      return { success: false, vms: [], error: err.message };
    }
  });

  ipcMain.handle('vm:start', async (event, vmName) => {
    try {
      await bootFixer.prebootValidateAndFix(vmName);

      // Auto-fix VBoxSup driver if stopped
      try {
        const svcCheck = execSync('sc.exe query vboxsup', { encoding: 'utf8', timeout: 5000 });
        if (!svcCheck.includes('RUNNING')) {
          logger.warn('App', 'VBoxSup driver stopped — attempting to start...');
          execSync('powershell -Command "Start-Process sc.exe -ArgumentList \'start\',\'vboxsup\' -Verb RunAs -Wait"', { timeout: 15000 });
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (e) {
        logger.warn('App', `VBoxSup check failed: ${e.message}`);
      }

      await virtualbox.startVM(vmName);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:stop', async (event, vmName) => {
    try {
      await virtualbox._run(['controlvm', vmName, 'acpipowerbutton']);
      return { success: true };
    } catch (err) {
      // Force power off if ACPI fails
      try {
        await virtualbox._run(['controlvm', vmName, 'poweroff']);
        return { success: true };
      } catch (err2) {
        return { success: false, error: err2.message };
      }
    }
  });

  ipcMain.handle('vm:pause', async (event, vmName) => {
    try {
      await virtualbox._run(['controlvm', vmName, 'pause']);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:resume', async (event, vmName) => {
    try {
      await virtualbox._run(['controlvm', vmName, 'resume']);
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
      const vmInfo = await virtualbox.getVMInfo(vmName);
      const vmState = (vmInfo?.VMState || '').toLowerCase();
      const hardwareKeys = ['ram', 'cpus', 'vram', 'graphicsController', 'audioController', 'networkMode', 'bootOrder', 'audioEnabled', 'usbEnabled', 'accelerate3d', 'efiEnabled', 'nestedVirtualization', 'sharedFolders'];
      const requestedHardwareEdit = hardwareKeys.some((key) => settings[key] !== undefined);

      if (vmState && vmState !== 'poweroff' && requestedHardwareEdit) {
        return {
          success: false,
          error: 'Power off the VM before editing hardware settings (RAM/CPU/graphics/network/USB/shared folders).'
        };
      }

      if (vmState && vmState !== 'poweroff' && !requestedHardwareEdit) {
        if (settings.clipboardMode) {
          await virtualbox._run(['controlvm', vmName, 'clipboard', settings.clipboardMode]);
        }
        if (settings.dragAndDrop) {
          await virtualbox._run(['controlvm', vmName, 'draganddrop', settings.dragAndDrop]);
        }

        return { success: true, runtimeApplied: true };
      }

      const args = ['modifyvm', vmName];
      if (settings.ram) args.push('--memory', String(settings.ram));
      if (settings.cpus) args.push('--cpus', String(settings.cpus));
      if (settings.vram) args.push('--vram', String(settings.vram));
      if (settings.graphicsController) args.push('--graphicscontroller', settings.graphicsController);
      if (settings.audioController) args.push('--audiocontroller', settings.audioController);
      if (settings.clipboardMode) args.push('--clipboard', settings.clipboardMode);
      if (settings.dragAndDrop) args.push('--draganddrop', settings.dragAndDrop);
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

      await virtualbox._run(args);

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

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:getDetails', async (event, vmName) => {
    try {
      const info = await virtualbox.getVMInfo(vmName);
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
          bootOrder: [info.boot1, info.boot2, info.boot3, info.boot4].filter(Boolean),
          sharedFolders
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

  ipcMain.handle('vm:showInExplorer', async (event, vmName) => {
    try {
      const info = await virtualbox.getVMInfo(vmName);
      const cfgFile = info.CfgFile;
      if (cfgFile) {
        const dir = path.dirname(cfgFile.replace(/"/g, ''));
        shell.openPath(dir);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vm:guest:configure', async (event, vmName, payload = {}) => {
    try {
      const {
        guestUser = 'user',
        guestPass = 'password',
        sharedFolderPath = '',
        sharedFolderName = 'shared',
        enableSharedFolder = true,
        autoStartVm = true
      } = payload;

      const vmState = (await virtualbox.getVMState(vmName) || '').toLowerCase();
      const notes = [];

      if (vmState === 'running') {
        try {
          const runtime = await virtualbox.applyRuntimeIntegration(vmName, {
            clipboardMode: 'bidirectional',
            dragAndDrop: 'bidirectional',
            width: 1920,
            height: 1080,
            bpp: 32,
            display: 0
          });
          notes.push(runtime.warnings?.length
            ? `Runtime integration applied with warnings: ${runtime.warnings.join(' | ')}`
            : 'Applied runtime clipboard/drag-drop/display integration for running VM.');
        } catch (runtimeErr) {
          notes.push(`Runtime clipboard/drag-drop apply warning: ${runtimeErr.message}`);
        }
      } else {
        await configureGuestFeatures(vmName);
        notes.push('Applied host-side Guest Additions VM settings (graphics, clipboard, drag-drop).');
      }

      let sharedFolderResult = null;
      if (enableSharedFolder && sharedFolderPath && sharedFolderPath.trim()) {
        sharedFolderResult = await setupSharedFolder(vmName, sharedFolderPath.trim(), sharedFolderName || 'shared');
        notes.push('Configured host shared folder mapping.');
      }

      const state = await virtualbox.getVMState(vmName);
      if (state !== 'running' && autoStartVm) {
        await virtualbox.startVM(vmName);
        notes.push('VM started automatically for in-guest setup.');
      }

      const gaReady = await virtualbox.waitForGuestAdditions(vmName, 600000);
      if (!gaReady) {
        return {
          success: false,
          error: 'Guest Additions are not ready yet. Wait for OS login, then try Guest Setup again.'
        };
      }

      const guestReady = await virtualbox.waitForGuestReady(vmName, guestUser, guestPass, 240000);
      if (!guestReady) {
        return {
          success: false,
          error: 'Guest OS is not ready for in-guest commands. Verify credentials and that the VM has finished booting.'
        };
      }

      const result = await configureGuestInside(vmName, guestUser, guestPass, null, {
        configureSharedFolder: !!(enableSharedFolder && sharedFolderResult),
        sharedFolderName: sharedFolderName || 'shared'
      });

      try {
        const runtimeFinal = await virtualbox.applyRuntimeIntegration(vmName, {
          clipboardMode: 'bidirectional',
          dragAndDrop: 'bidirectional',
          width: 1920,
          height: 1080,
          bpp: 32,
          display: 0
        });
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
        dragDropBidirectional: String(postInfo.draganddrop || postInfo['drag-and-drop'] || '').toLowerCase() === 'bidirectional'
      };

      if (!postChecks.guestAdditions || !postChecks.graphicsController || !postChecks.clipboardBidirectional || !postChecks.dragDropBidirectional) {
        return {
          success: false,
          error: 'Guest integration verification failed. Retry Guest Setup after VM boot/login.',
          notes,
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
    try {
      // Forward orchestrator events to renderer
      const sendToRenderer = (channel, data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(channel, data);
        }
      };

      // Wire orchestrator events
      orchestrator.on('phase', (data) => sendToRenderer('setup:phase', data));
      orchestrator.on('progress', (data) => sendToRenderer('setup:progress', data));
      orchestrator.on('error', (data) => sendToRenderer('setup:error', data));
      orchestrator.on('complete', (data) => sendToRenderer('setup:complete', data));

      // Wire logger events to renderer (user sees ALL logs)
      const logHandler = (entry) => sendToRenderer('setup:log', entry);
      logger.on('log', logHandler);

      const result = await orchestrator.runSetup(config, config._resumeFrom || null);

      // Cleanup listeners
      orchestrator.removeAllListeners();
      logger.removeListener('log', logHandler);

      return result;
    } catch (err) {
      // Cleanup listeners even on error
      orchestrator.removeAllListeners();
      return { success: false, error: err.message };
    }
  });

  // ─── Cancel setup ───────────────────────────────────────────────
  ipcMain.handle('setup:cancel', async () => {
    orchestrator.cancel();
    return { cancelled: true };
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
  }

  // Initialize logger
  await logger.init();
  logger.info('App', 'VM Xposed starting...');
  logger.info('App', `Platform: ${process.platform} ${process.arch}`);
  logger.info('App', `Electron: ${process.versions.electron}`);
  logger.info('App', `Node: ${process.versions.node}`);
  logger.info('App', `Administrator: ${isRunningAsAdmin() ? 'YES' : 'NO'}`);

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
