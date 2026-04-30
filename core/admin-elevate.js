/**
 * core/admin-elevate.js
 * 
 * Secure Windows admin elevation using proper APIs.
 * Replaces PowerShell UAC elevation with robust implementation.
 * 
 * Security considerations:
 * - Uses minimal arguments (no device paths passed to elevated process)
 * - Prevents infinite elevation loops with marker file
 * - Validates elevation success before returning
 * - Uses execFile() instead of shell injection vulnerable exec()
 */

const { app } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

// Marker file to detect if we're already elevated
function getElevationMarkerPath() {
  const userId = process.env.USERNAME || process.env.USER || 'user';
  const markerDir = path.join(os.tmpdir(), `vm-xposed-elevation-${userId}`);
  return path.join(markerDir, 'elevation-marker.txt');
}

/**
 * Check if application is running with administrator privileges on Windows
 */
function isRunningAsAdmin() {
  if (process.platform !== 'win32') {
    return true; // Linux/macOS don't need admin elevation for VM management
  }

  try {
    // net session command requires admin privileges
    // If it succeeds, we have admin access
    // MUST use execFileSync (synchronous) — execFile is async and would never throw
    const { execFileSync } = require('child_process');
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if we've already attempted elevation once (prevent infinite loops)
 */
function hasAttemptedElevation() {
  try {
    const marker = getElevationMarkerPath();
    if (!fs.existsSync(marker)) return false;
    const raw = fs.readFileSync(marker, 'utf8').trim();
    const markerTs = Number(raw) || fs.statSync(marker).mtimeMs || 0;
    const markerAgeMs = Date.now() - markerTs;
    if (!Number.isFinite(markerAgeMs) || markerAgeMs > 3 * 60 * 1000) {
      clearElevationAttempted();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function clearElevationAttempted() {
  try {
    const marker = getElevationMarkerPath();
    if (fs.existsSync(marker)) {
      fs.unlinkSync(marker);
    }
  } catch {}
}

/**
 * Mark that we've attempted elevation (prevent loops)
 */
function markElevationAttempted() {
  try {
    const marker = getElevationMarkerPath();
    const dir = path.dirname(marker);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(marker, Date.now().toString(), 'utf8');
    
    // Clean up after 5 minutes
    setTimeout(() => {
      try {
        fs.unlinkSync(marker);
      } catch {}
    }, 300000);
  } catch (err) {
    logger.warn('AdminElevate', `Failed to mark elevation attempt: ${err.message}`);
  }
}

/**
 * Request Windows admin privileges via UAC dialog
 * 
 * This uses ShellExecute (via PowerShell) with proper error handling.
 * More reliable than direct Win32 API calls from Electron.
 * 
 * Returns: { success: boolean, error?: string, restarting?: boolean }
 */
async function requestAdminElevation() {
  if (process.platform !== 'win32') {
    return {
      success: false,
      error: 'Administrator elevation is only available on Windows'
    };
  }

  if (isRunningAsAdmin()) {
    clearElevationAttempted();
    return {
      success: true,
      message: 'Already running with administrator privileges'
    };
  }

  if (hasAttemptedElevation()) {
    return {
      success: false,
      error: 'Admin elevation was already attempted. User may have cancelled UAC prompt.'
    };
  }

  const relaunchContext = _buildRelaunchContext('--elevated-process');
  const exePath = relaunchContext.executablePath;
  if (!exePath || !relaunchContext.canLaunch) {
    return {
      success: false,
      error: `Could not locate application executable: ${exePath}`
    };
  }

  logger.info(
    'AdminElevate',
    `Requesting admin elevation for: ${exePath} (mode=${relaunchContext.launchMode})`
  );
  markElevationAttempted();

  const escapedExePath = _escapePowerShellSingleQuoted(exePath);
  const escapedWorkingDir = _escapePowerShellSingleQuoted(relaunchContext.workingDirectory);
  const psArgList = relaunchContext.relaunchArgs
    .map((arg) => `'${_escapePowerShellSingleQuoted(arg)}'`)
    .join(', ');

  // PowerShell command to restart with admin privileges
  // This is more reliable than raw Win32 APIs from Electron
  const psCommand = `
    try {
      $proc = Start-Process -FilePath '${escapedExePath}' -ArgumentList @(${psArgList}) -WorkingDirectory '${escapedWorkingDir}' -Verb RunAs -PassThru -ErrorAction Stop
      if ($null -eq $proc) {
        exit 1
      }
      # Wait briefly to verify process started
      Start-Sleep -Milliseconds 100
      if ($proc.HasExited) {
        exit 1
      }
      exit 0
    } catch {
      exit 2
    }
  `;

  return new Promise((resolve) => {
    // Use a timeout to prevent hanging
    const timeoutId = setTimeout(() => {
      logger.warn('AdminElevate', 'UAC elevation request timed out');
      resolve({
        success: false,
        error: 'UAC elevation request timed out'
      });
    }, 120000); // 2 minutes timeout

    let lockReleased = false;
    try {
      app.releaseSingleInstanceLock();
      lockReleased = true;
    } catch {}

    try {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          psCommand
        ],
        {
          windowsHide: true,
          timeout: 115000,
          maxBuffer: 1024 * 10,
          env: { ...process.env, LANG: 'en_US.UTF-8' }
        },
        (error, stdout, stderr) => {
          clearTimeout(timeoutId);

          if (error) {
            if (lockReleased) {
              try { app.requestSingleInstanceLock(); } catch {}
            }
            const errorMsg = String(error.message || stderr || '').trim();
            
            // Detect if user cancelled UAC prompt
            if (/1223|canceled|cancelled|operation was canceled/i.test(errorMsg)) {
              logger.info('AdminElevate', 'User cancelled UAC prompt');
              clearElevationAttempted();
              resolve({
                success: false,
                error: 'Administrator privilege elevation was cancelled by user'
              });
              return;
            }

            // Check exit code for other errors
            if (error.code === 1) {
              logger.warn('AdminElevate', 'Failed to start elevated process');
              clearElevationAttempted();
              resolve({
                success: false,
                error: 'Failed to start elevated process (UAC may be disabled)'
              });
              return;
            }

            logger.error('AdminElevate', `Elevation error: ${errorMsg}`);
            clearElevationAttempted();
            resolve({
              success: false,
              error: `Administrator elevation failed: ${errorMsg}`
            });
            return;
          }

          // Success: elevated process started
          logger.info('AdminElevate', 'Admin elevation successful, restarting application...');
          clearElevationAttempted();

          // Give the elevated process time to start and acquire locks
          setTimeout(() => {
            try {
              app.exit(0);
            } catch {}
          }, 500);

          resolve({
            success: true,
            restarting: true,
            message: 'Application restarting with administrator privileges'
          });
        }
      );
    } catch (err) {
      clearTimeout(timeoutId);
      if (lockReleased) {
        try { app.requestSingleInstanceLock(); } catch {}
      }
      logger.error('AdminElevate', `Failed to execute elevation command: ${err.message}`);
      resolve({
        success: false,
        error: `Could not execute elevation command: ${err.message}`
      });
    }
  });
}

/**
 * Handle the --elevated-process flag so app knows it's already elevated
 */
function isElevatedProcessFlag() {
  return process.argv.includes('--elevated-process');
}

function isStandardProcessFlag() {
  return process.argv.includes('--standard-process');
}

function _escapePowerShellSingleQuoted(value = '') {
  return String(value).replace(/'/g, "''");
}

function _sanitizeRelaunchArgs(args = []) {
  return (Array.isArray(args) ? args : [])
    .map((arg) => String(arg || '').trim())
    .filter(Boolean)
    .filter((arg) => arg !== '--elevated-process' && arg !== '--standard-process');
}

function _canLaunchFilePath(filePath = '') {
  const value = String(filePath || '').trim();
  if (!value) return false;
  if (!path.isAbsolute(value)) return true; // resolve from PATH, e.g. cmd.exe
  return fs.existsSync(value);
}

function _buildRelaunchContext(markerArg = '') {
  const packagedExecutable = app.getPath('exe');
  const executablePath = packagedExecutable || process.execPath;
  const devLike = process.defaultApp === true || !app.isPackaged;
  const appPath = app.getAppPath();
  const appEntryPath = path.resolve(String(appPath || process.cwd()));
  const executableDir = path.dirname(String(executablePath || process.cwd()));

  let targetFilePath = executablePath;
  let relaunchArgs = _sanitizeRelaunchArgs(process.argv.slice(1));
  let launchMode = 'packaged';
  if (devLike) {
    // Development relaunch should still target Electron runtime, but with explicit app entry.
    // This avoids opening a transient elevated cmd.exe window.
    const trailingArgs = relaunchArgs.slice(1);
    relaunchArgs = [appEntryPath, ...trailingArgs];
    launchMode = 'dev-electron';
  }

  if (markerArg) {
    relaunchArgs.push(markerArg);
  }

  // In packaged mode, always use the install directory (never app.asar).
  const workingDirectory = (() => {
    if (!devLike) {
      try {
        if (fs.existsSync(executableDir) && fs.statSync(executableDir).isDirectory()) {
          return executableDir;
        }
      } catch {}
      return process.cwd();
    }

    try {
      if (fs.existsSync(appEntryPath) && fs.statSync(appEntryPath).isDirectory()) {
        return appEntryPath;
      }
    } catch {}
    try {
      if (fs.existsSync(executableDir) && fs.statSync(executableDir).isDirectory()) {
        return executableDir;
      }
    } catch {}
    return process.cwd();
  })();

  return {
    executablePath: targetFilePath,
    canLaunch: _canLaunchFilePath(targetFilePath),
    relaunchArgs,
    workingDirectory,
    devLike,
    launchMode
  };
}

async function relaunchAsStandardUser() {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Standard-user relaunch is only available on Windows.' };
  }

  const relaunchContext = _buildRelaunchContext('--standard-process');
  const exePath = relaunchContext.executablePath;
  if (!exePath || !relaunchContext.canLaunch) {
    return { success: false, error: `Executable not found: ${exePath}` };
  }

  const escapedExe = _escapePowerShellSingleQuoted(exePath);
  const escapedWorkingDir = _escapePowerShellSingleQuoted(relaunchContext.workingDirectory);
  const argLine = relaunchContext.relaunchArgs
    .map((arg) => `"${String(arg).replace(/"/g, '\\"')}"`)
    .join(' ');
  const escapedArgLine = _escapePowerShellSingleQuoted(argLine);
  const psCommand = [
    '$shell = New-Object -ComObject Shell.Application',
    `$shell.ShellExecute('${escapedExe}', '${escapedArgLine}', '${escapedWorkingDir}', 'open', 1)`,
    'exit 0'
  ].join('; ');

  return new Promise((resolve) => {
    let lockReleased = false;
    try {
      app.releaseSingleInstanceLock();
      lockReleased = true;
    } catch {}

    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', psCommand],
      { windowsHide: true, timeout: 20000 },
      (error) => {
        if (error) {
          if (lockReleased) {
            try { app.requestSingleInstanceLock(); } catch {}
          }
          resolve({
            success: false,
            error: `Failed to relaunch as standard user: ${String(error.message || '').trim()}`
          });
          return;
        }
        resolve({ success: true });
      }
    );
  });
}

/**
 * Exports
 */
module.exports = {
  isRunningAsAdmin,
  hasAttemptedElevation,
  clearElevationAttempted,
  requestAdminElevation,
  isElevatedProcessFlag,
  isStandardProcessFlag,
  relaunchAsStandardUser,
  getElevationMarkerPath
};
