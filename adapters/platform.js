/**
 * adapters/platform.js — Platform Abstraction Layer
 * 
 * Design Decision: Encapsulates ALL platform-specific logic in one place.
 * No other module should check process.platform directly.
 * All paths are resolved from environment variables or system queries — never hardcoded.
 */

const os = require('os');
const path = require('path');
const { execFile, exec } = require('child_process');
const fs = require('fs');
const logger = require('../core/logger');

class PlatformAdapter {
  constructor() {
    this.platform = process.platform;  // 'win32' | 'linux' | 'darwin'
    this.arch = process.arch;          // 'x64' | 'arm64' | etc.
  }

  /**
   * Returns 'windows' | 'linux' | 'macos'
   */
  getOS() {
    switch (this.platform) {
      case 'win32': return 'windows';
      case 'linux': return 'linux';
      case 'darwin': return 'macos';
      default: return 'unknown';
    }
  }

  /**
   * Get system information for display in the UI.
   */
  getSystemInfo() {
    return {
      os: this.getOS(),
      osVersion: os.release(),
      arch: this.arch,
      hostname: os.hostname(),
      totalRAM: Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10,  // GB
      freeRAM: Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10,    // GB
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || 'Unknown'
    };
  }

  /**
   * Find the VBoxManage binary path.
   * Searches standard installation locations and PATH.
   */
  async findVBoxManage() {
    logger.info('Platform', 'Searching for VBoxManage...');

    if (this.platform === 'win32') {
      // Standard Windows installation paths
      const candidates = [
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Oracle', 'VirtualBox', 'VBoxManage.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Oracle', 'VirtualBox', 'VBoxManage.exe'),
        // Also check PATH via where command
      ];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          logger.success('Platform', `Found VBoxManage: ${candidate}`);
          return candidate;
        }
      }

      // Fallback: search PATH
      try {
        const result = await this._execPromise('where VBoxManage.exe');
        const vboxPath = result.stdout.trim().split('\n')[0].trim();
        if (vboxPath) {
          logger.success('Platform', `Found VBoxManage in PATH: ${vboxPath}`);
          return vboxPath;
        }
      } catch {
        // Not in PATH
      }
    } else {
      // Linux/macOS
      const candidates = [
        '/usr/bin/VBoxManage',
        '/usr/local/bin/VBoxManage',
        '/opt/VirtualBox/VBoxManage'
      ];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          logger.success('Platform', `Found VBoxManage: ${candidate}`);
          return candidate;
        }
      }

      // Fallback: search PATH
      try {
        const result = await this._execPromise('which VBoxManage');
        const vboxPath = result.stdout.trim();
        if (vboxPath) {
          logger.success('Platform', `Found VBoxManage in PATH: ${vboxPath}`);
          return vboxPath;
        }
      } catch {
        // Not in PATH
      }
    }

    logger.warn('Platform', 'VBoxManage not found — VirtualBox may not be installed');
    return null;
  }

  /**
   * Check if CPU virtualization (VT-x / AMD-V) is enabled.
   * This is critical — VirtualBox won't work without it.
   */
  async checkVirtualizationEnabled() {
    logger.info('Platform', 'Checking CPU virtualization support...');

    try {
      if (this.platform === 'win32') {
        // Use systeminfo command on Windows
        const result = await this._execPromise('systeminfo');
        const output = result.stdout;

        // Look for Hyper-V requirements section
        if (output.includes('Virtualization Enabled In Firmware: Yes') ||
            output.includes('VM Monitor Mode Extensions: Yes')) {
          logger.success('Platform', 'CPU virtualization is ENABLED');
          return { enabled: true, technology: 'VT-x/AMD-V' };
        }

        // Check if Hyper-V is taking over (common issue)
        if (output.includes('A hypervisor has been detected')) {
          logger.warn('Platform', 'A hypervisor is already active (possibly Hyper-V)');
          return {
            enabled: true,
            technology: 'Hypervisor detected',
            warning: 'Hyper-V may conflict with VirtualBox. Consider disabling Hyper-V for best performance.'
          };
        }

        logger.error('Platform', 'CPU virtualization appears DISABLED');
        return {
          enabled: false,
          error: 'CPU virtualization is not enabled. Please enable VT-x/AMD-V in your BIOS settings.'
        };
      } else {
        // Linux: check /proc/cpuinfo
        const result = await this._execPromise('grep -c -E "(vmx|svm)" /proc/cpuinfo');
        const count = parseInt(result.stdout.trim(), 10);

        if (count > 0) {
          logger.success('Platform', 'CPU virtualization is ENABLED');
          return { enabled: true, technology: count > 0 ? 'VT-x/AMD-V' : 'Unknown' };
        }

        logger.error('Platform', 'CPU virtualization appears DISABLED');
        return {
          enabled: false,
          error: 'CPU virtualization is not enabled. Please enable VT-x/AMD-V in your BIOS settings.'
        };
      }
    } catch (err) {
      logger.warn('Platform', `Could not detect virtualization status: ${err.message}`);
      return {
        enabled: null,
        warning: 'Could not detect virtualization status. VirtualBox will report if there is an issue.'
      };
    }
  }

  /**
   * Get available disk space on a given path (in GB).
   */
  async getDiskSpace(targetPath) {
    try {
      if (this.platform === 'win32') {
        // Use WMIC to get free space on the drive
        const drive = path.parse(targetPath).root.replace('\\', '');
        const result = await this._execPromise(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /format:value`);
        const match = result.stdout.match(/FreeSpace=(\d+)/);
        if (match) {
          return Math.round(parseInt(match[1], 10) / (1024 * 1024 * 1024) * 10) / 10;
        }
      } else {
        const result = await this._execPromise(`df -BG "${targetPath}" | tail -1 | awk '{print $4}'`);
        return parseInt(result.stdout.replace('G', ''), 10);
      }
    } catch (err) {
      logger.warn('Platform', `Could not determine disk space: ${err.message}`);
    }
    return null;
  }

  /**
   * Get the command to launch the VirtualBox installer.
   * Windows: Run .exe with --silent flag
   * Linux: dpkg -i or apt install
   */
  getInstallerCommand(installerPath) {
    if (this.platform === 'win32') {
      return {
        cmd: installerPath,
        args: ['--silent', '--msiparams', 'VBOX_START=0'],
        elevated: true
      };
    } else {
      return {
        cmd: 'sudo',
        args: ['dpkg', '-i', installerPath],
        elevated: false
      };
    }
  }

  /**
   * Helper: Execute a command and return stdout/stderr as a promise.
   */
  _execPromise(command, options = {}) {
    return new Promise((resolve, reject) => {
      exec(command, { timeout: 60000, ...options }, (error, stdout, stderr) => {
        if (error) {
          reject({ error, stdout, stderr });
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }
}

// Singleton
const platform = new PlatformAdapter();
module.exports = platform;
