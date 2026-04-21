/**
 * adapters/virtualbox.js — VirtualBox VBoxManage Wrapper
 * 
 * Design Decision: All VirtualBox operations go through VBoxManage CLI.
 * Uses execFile (not exec) for security — prevents shell injection.
 * Every command is logged so the user sees exactly what's happening.
 * 
 * This is the ONLY module that talks to VirtualBox.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../core/logger');
const platform = require('./platform');

class VirtualBoxAdapter {
  constructor() {
    this.vboxManagePath = null;
    this.preferredManagePath = '';
  }

  setPreferredManagePath(managePath = '') {
    const raw = String(managePath || '').trim();
    this.preferredManagePath = raw.replace(/^"(.*)"$/, '$1').trim();
  }

  _resolvePreferredManagePath(rawPath = '') {
    const candidate = String(rawPath || '').trim();
    if (!candidate) return null;

    const normalized = candidate.replace(/^"(.*)"$/, '$1').trim();
    if (!normalized) return null;

    const toFile = (target) => {
      try {
        if (!fs.existsSync(target)) return null;
        const stat = fs.statSync(target);
        return stat.isFile() ? target : null;
      } catch {
        return null;
      }
    };

    const directFile = toFile(normalized);
    if (directFile) return directFile;

    const lower = normalized.toLowerCase();
    if (lower.endsWith('virtualbox.exe')) {
      const sibling = path.join(path.dirname(normalized), 'VBoxManage.exe');
      const siblingFile = toFile(sibling);
      if (siblingFile) return siblingFile;
    }

    try {
      if (fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()) {
        const exeName = process.platform === 'win32' ? 'VBoxManage.exe' : 'VBoxManage';
        const managed = path.join(normalized, exeName);
        const managedFile = toFile(managed);
        if (managedFile) return managedFile;
      }
    } catch {}

    return null;
  }

  /**
   * Initialize the adapter — find VBoxManage binary.
   * Must be called before any other method.
   */
  async init(managePathOverride) {
    if (managePathOverride !== undefined) {
      this.setPreferredManagePath(managePathOverride);
    }

    const preferredPath = this._resolvePreferredManagePath(this.preferredManagePath);
    if (this.preferredManagePath && !preferredPath) {
      logger.warn('VirtualBox', `Configured VirtualBox Path is invalid: ${this.preferredManagePath}`);
    }

    this.vboxManagePath = preferredPath || await platform.findVBoxManage();
    if (this.vboxManagePath) {
      // Try to get version — if it fails, VirtualBox.xml may be corrupted
      let version = await this.getVersion();

      if (!version) {
        // Attempt auto-repair of corrupted VirtualBox.xml
        logger.warn('VirtualBox', 'VBoxManage found but not responding — checking for corrupted config...');
        const repaired = await this._repairVBoxConfig();
        if (repaired) {
          version = await this.getVersion();
        }
      }

      if (version) {
        logger.success('VirtualBox', `VirtualBox ${version} found at: ${this.vboxManagePath}`);
      } else {
        logger.error('VirtualBox', 'VBoxManage found but not working. VirtualBox may need reinstallation.');
      }
    }
    return !!this.vboxManagePath;
  }

  /**
   * Auto-repair corrupted VirtualBox.xml config file.
   * Fixes the common "UUID has zero format" bug caused by bad MachineEntry references.
   * @returns {boolean} True if repair was attempted
   */
  async _repairVBoxConfig() {
    try {
      const os = require('os');
      const configPath = path.join(os.homedir(), '.VirtualBox', 'VirtualBox.xml');

      if (!fs.existsSync(configPath)) return false;

      const content = fs.readFileSync(configPath, 'utf8');

      // Check for zero-UUID MachineEntry (common corruption)
      if (content.includes('00000000-0000-0000-0000-000000000000')) {
        logger.warn('VirtualBox', 'Found corrupted MachineEntry with zero UUID — auto-repairing...');

        // Backup first
        const backupPath = configPath + '.backup-' + Date.now();
        fs.copyFileSync(configPath, backupPath);
        logger.info('VirtualBox', `Backup created: ${backupPath}`);

        // Remove the corrupted line
        const fixed = content
          .split('\n')
          .filter(line => !line.includes('00000000-0000-0000-0000-000000000000'))
          .join('\n');

        fs.writeFileSync(configPath, fixed, 'utf8');
        logger.success('VirtualBox', 'VirtualBox.xml repaired — removed corrupted MachineEntry');
        return true;
      }

      return false;
    } catch (err) {
      logger.error('VirtualBox', `Auto-repair failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Check if VirtualBox is installed and accessible.
   */
  isInstalled() {
    return !!this.vboxManagePath;
  }

  /**
   * Get VirtualBox version string.
   */
  async getVersion() {
    try {
      const result = await this._run(['--version']);
      return result.trim();
    } catch {
      return null;
    }
  }

  /**
   * List all available OS types that VirtualBox supports.
   * Used to populate the OS type dropdown if needed.
   */
  async listOSTypes() {
    const result = await this._run(['list', 'ostypes']);
    const types = [];
    const entries = result.split('\n\n');
    
    for (const entry of entries) {
      const idMatch = entry.match(/ID:\s*(.+)/);
      const descMatch = entry.match(/Description:\s*(.+)/);
      if (idMatch && descMatch) {
        types.push({
          id: idMatch[1].trim(),
          description: descMatch[1].trim()
        });
      }
    }
    return types;
  }

  /**
   * Create a new virtual machine and register it.
   * 
   * @param {string} name - VM name
   * @param {string} osType - VirtualBox OS type (e.g., 'Ubuntu_64')
   * @param {string} basePath - Directory where VM files will be stored
   */
  async createVM(name, osType, basePath) {
    logger.info('VirtualBox', `Creating VM: "${name}" (type: ${osType})`);
    logger.info('VirtualBox', `VM files location: ${basePath}`);

    await this._run([
      'createvm',
      '--name', name,
      '--ostype', osType,
      '--basefolder', basePath,
      '--register'
    ]);

    logger.success('VirtualBox', `VM "${name}" created and registered`);
  }

  /**
   * Configure VM hardware settings.
   * 
   * @param {string} name - VM name
   * @param {object} options - Configuration options
   */
  async configureVM(name, options = {}) {
    const args = ['modifyvm', name];

    // Build arguments from options
    const optionMap = {
      ram: '--memory',
      cpus: '--cpus',
      vram: '--vram',
      graphicsController: '--graphicscontroller',
      accelerate3d: '--accelerate3d',
      audioController: '--audiocontroller',
      clipboardMode: '--clipboard',
      dragAndDrop: '--draganddrop',
      ioapic: '--ioapic',
      acpi: '--acpi',
      pae: '--pae',
      nestedPaging: '--nested-paging',
      largepages: '--largepages',
      rtcUseUtc: '--rtc-use-utc',
      usbOhci: '--usbohci',
      usbEhci: '--usbehci',
    };

    for (const [key, flag] of Object.entries(optionMap)) {
      if (options[key] !== undefined) {
        args.push(flag, String(options[key]));
      }
    }

    // Boot order
    if (options.bootOrder) {
      options.bootOrder.forEach((device, i) => {
        args.push(`--boot${i + 1}`, device);
      });
    }

    logger.info('VirtualBox', `Configuring VM "${name}": RAM=${options.ram}MB, CPUs=${options.cpus}, VRAM=${options.vram}MB`);
    await this._run(args);
    logger.success('VirtualBox', `VM "${name}" configured successfully`);
  }

  /**
   * Create a virtual hard disk (VDI format).
   * 
   * @param {string} filePath - Where to create the .vdi file
   * @param {number} sizeMB - Disk size in megabytes
   */
  async createDisk(filePath, sizeMB) {
    logger.info('VirtualBox', `Creating virtual disk: ${filePath} (${sizeMB} MB)`);

    await this._run([
      'createmedium', 'disk',
      '--filename', filePath,
      '--size', String(sizeMB),
      '--format', 'VDI',
      '--variant', 'Standard'
    ]);

    logger.success('VirtualBox', `Virtual disk created: ${(sizeMB / 1024).toFixed(1)} GB`);
  }

  /**
   * Add a storage controller to the VM.
   * 
   * @param {string} vmName - VM name
   * @param {string} controllerName - Controller name (e.g., 'SATA Controller')
   * @param {string} type - Controller type: 'sata', 'ide', 'scsi'
   */
  async addStorageController(vmName, controllerName, type) {
    logger.info('VirtualBox', `Adding ${type.toUpperCase()} controller: "${controllerName}"`);

    const controllerMap = {
      sata: 'IntelAHCI',
      ide: 'PIIX4',
      scsi: 'LSILogic'
    };

    await this._run([
      'storagectl', vmName,
      '--name', controllerName,
      '--add', type,
      '--controller', controllerMap[type] || type
    ]);
  }

  /**
   * Attach a medium (disk, DVD, etc.) to a storage controller.
   * 
   * @param {string} vmName - VM name
   * @param {string} controllerName - Controller name
   * @param {number} port - Port number
   * @param {number} device - Device number
   * @param {string} type - Medium type: 'hdd', 'dvddrive'
   * @param {string} medium - Path to medium or 'emptydrive'
   */
  async attachStorage(vmName, controllerName, port, device, type, medium) {
    logger.info('VirtualBox', `Attaching ${type} to "${controllerName}" port ${port}: ${medium}`);

    await this._run([
      'storageattach', vmName,
      '--storagectl', controllerName,
      '--port', String(port),
      '--device', String(device),
      '--type', type,
      '--medium', medium
    ]);
  }

  /**
   * Configure network adapter.
   * 
   * @param {string} vmName - VM name
   * @param {string} mode - 'nat' or 'bridged'
   * @param {number} [adapterNum=1] - Adapter number (1-based)
   */
  async configureNetwork(vmName, mode, adapterNum = 1) {
    logger.info('VirtualBox', `Configuring network adapter ${adapterNum}: ${mode.toUpperCase()}`);

    const args = ['modifyvm', vmName];

    if (mode === 'nat') {
      args.push(`--nic${adapterNum}`, 'nat');
    } else if (mode === 'bridged') {
      args.push(`--nic${adapterNum}`, 'bridged');
      // Auto-detect bridge adapter
      const bridgeAdapter = await this._detectBridgeAdapter();
      if (bridgeAdapter) {
        args.push(`--bridgeadapter${adapterNum}`, bridgeAdapter);
      }
    }

    await this._run(args);
    logger.success('VirtualBox', `Network configured: ${mode.toUpperCase()}`);
  }

  /**
   * Run VBoxManage unattended install — the primary automation method.
   * This configures the VM for fully automated OS installation.
   * 
   * @param {string} vmName - VM name
   * @param {object} options - Installation options
   */
  async unattendedInstall(vmName, options) {
    logger.info('VirtualBox', `Setting up unattended installation for "${vmName}"`);

    const args = [
      'unattended', 'install', vmName,
      '--iso', options.isoPath,
      '--user', options.username || 'user',
      '--password', options.password || 'password',
      '--full-user-name', options.fullName || 'User',
      '--locale', options.locale || 'en_US',
      '--country', options.country || 'US',
      '--hostname', options.hostname || vmName.replace(/\s+/g, '-').toLowerCase(),
    ];

    if (options.installAdditions !== false) {
      args.push('--install-additions');
    }

    if (options.postInstallCommand) {
      args.push('--post-install-command', options.postInstallCommand);
    }

    await this._run(args);
    logger.success('VirtualBox', 'Unattended install configuration applied');
  }

  /**
   * Start the VM in GUI mode.
   * 
   * @param {string} vmName - VM name
   * @param {string} [type='gui'] - Start mode: 'gui', 'headless', 'separate'
   */
  async startVM(vmName, type = 'gui') {
    logger.info('VirtualBox', `Starting VM "${vmName}" in ${type} mode...`);

    // startvm launches a GUI process — use spawn detached so we don't wait for
    // the VirtualBox window to close. The _run method would timeout or fail.
    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const args = ['startvm', vmName, '--type', type];
      const cmdStr = `VBoxManage ${args.join(' ')}`;
      logger.debug('VirtualBox', `Executing (detached): ${cmdStr}`);

      const child = spawn(this.vboxManagePath, args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      // Wait for the startvm command to complete (it returns quickly after launching the VM)
      const timeout = setTimeout(() => {
        // If startvm hasn't returned after 30s, assume it's fine — VM window opened
        child.unref();
        logger.success('VirtualBox', `VM "${vmName}" started (window opened)`);
        resolve(stdout);
      }, 30000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          logger.success('VirtualBox', `VM "${vmName}" started`);
          resolve(stdout);
        } else {
          // Check if stderr has real errors vs just progress output
          const stderrClean = stderr.trim();
          if (stderrClean && stderrClean.includes('error:')) {
            logger.error('VirtualBox', `startvm failed: ${stderrClean}`);
            reject(new Error(`Failed to start VM: ${stderrClean}`));
          } else {
            // Non-zero exit but no real error — might just be progress output
            logger.warn('VirtualBox', `startvm exited with code ${code}, but no critical error detected`);
            logger.success('VirtualBox', `VM "${vmName}" started`);
            resolve(stdout);
          }
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        logger.error('VirtualBox', `Failed to spawn startvm: ${err.message}`);
        reject(new Error(`Failed to start VM: ${err.message}`));
      });
    });
  }

  /**
   * Get VM information (state, settings, etc.)
   */
  async getVMInfo(vmName) {
    const result = await this._run(['showvminfo', vmName, '--machinereadable']);
    const info = {};

    for (const line of result.split('\n')) {
      const clean = line.replace(/\r$/, '').trim();
      if (!clean || !clean.includes('=')) continue;
      const eqIdx = clean.indexOf('=');
      const key = clean.substring(0, eqIdx);
      let val = clean.substring(eqIdx + 1);
      // Strip surrounding quotes
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1);
      }
      info[key] = val;
    }

    return info;
  }

  /**
   * Get the current state of a VM (running, poweroff, etc.)
   */
  async getVMState(vmName) {
    try {
      const info = await this.getVMInfo(vmName);
      return info.VMState || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Add a shared folder to the VM with auto-mount.
   * 
   * @param {string} vmName - VM name
   * @param {string} shareName - Share name visible inside guest
   * @param {string} hostPath - Absolute path on host
   * @param {boolean} [autoMount=true] - Auto-mount on guest boot
   */
  async addSharedFolder(vmName, shareName, hostPath, autoMount = true) {
    logger.info('VirtualBox', `Adding shared folder: "${shareName}" → ${hostPath}`);

    const args = [
      'sharedfolder', 'add', vmName,
      '--name', shareName,
      '--hostpath', hostPath,
    ];

    if (autoMount) {
      args.push('--automount');
    }

    await this._run(args);
    logger.success('VirtualBox', `Shared folder "${shareName}" added with auto-mount`);
  }

  /**
   * Check if a VM with the given name already exists.
   */
  async vmExists(vmName) {
    try {
      const result = await this._run(['list', 'vms']);
      return result.includes(`"${vmName}"`);
    } catch {
      return false;
    }
  }

  /**
   * Delete a VM and all its files (disk, config, snapshots).
   */
  async deleteVM(vmName) {
    logger.info('VirtualBox', `Deleting VM "${vmName}" and all associated files...`);

    // Power off first if running
    try {
      const state = await this.getVMState(vmName);
      if (state === 'running' || state === 'paused') {
        await this._run(['controlvm', vmName, 'poweroff']);
        await new Promise(r => setTimeout(r, 2000)); // Wait for shutdown
      }
    } catch (err) {
      logger.debug('VirtualBox', `Poweroff attempt: ${err.message}`);
    }

    await this._run(['unregistervm', vmName, '--delete']);
    logger.success('VirtualBox', `VM "${vmName}" deleted`);
  }

  /**
   * List snapshots for a VM.
   */
  async listSnapshots(vmName) {
    try {
      const output = await this._run(['snapshot', vmName, 'list', '--machinereadable']);
      const snapshotsByIndex = new Map();

      const ensureIndex = (index) => {
        if (!snapshotsByIndex.has(index)) {
          snapshotsByIndex.set(index, {
            id: '',
            name: '',
            description: '',
            timestamp: '',
            isCurrent: false
          });
        }
        return snapshotsByIndex.get(index);
      };

      for (const rawLine of String(output || '').split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        const kvMatch = line.match(/^([^=]+)=(.*)$/);
        if (!kvMatch) continue;
        const key = kvMatch[1].trim();
        const rawValue = kvMatch[2].trim();
        const value = rawValue.replace(/^"(.*)"$/, '$1');

        let match = key.match(/^SnapshotNameMachineMapping(\d+)$/);
        if (match) {
          ensureIndex(match[1]).name = value;
          continue;
        }

        match = key.match(/^SnapshotUUIDMachineMapping(\d+)$/);
        if (match) {
          ensureIndex(match[1]).id = value;
          continue;
        }

        match = key.match(/^SnapshotDescriptionMachineMapping(\d+)$/);
        if (match) {
          ensureIndex(match[1]).description = value;
          continue;
        }

        match = key.match(/^SnapshotTimeStampMachineMapping(\d+)$/);
        if (match) {
          ensureIndex(match[1]).timestamp = value;
        }
      }

      const currentSnapshot = String(output || '').match(/SnapshotName="([^"]+)"/);
      const currentName = currentSnapshot ? currentSnapshot[1] : '';

      const snapshots = Array.from(snapshotsByIndex.values())
        .filter((snapshot) => snapshot.name || snapshot.id)
        .map((snapshot) => ({
          ...snapshot,
          isCurrent: !!currentName && snapshot.name === currentName
        }));

      return snapshots;
    } catch (err) {
      const message = String(err?.message || '');
      if (/does not have any snapshots/i.test(message)) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Create snapshot for a VM.
   */
  async createSnapshot(vmName, snapshotName) {
    const state = String(await this.getVMState(vmName)).toLowerCase();
    const args = ['snapshot', vmName, 'take', snapshotName];
    if (state === 'running' || state === 'paused') {
      args.push('--live');
    }
    await this._run(args);
  }

  /**
   * Restore VM snapshot.
   */
  async restoreSnapshot(vmName, snapshotRef) {
    const state = String(await this.getVMState(vmName)).toLowerCase();
    if (state === 'running' || state === 'paused') {
      try {
        await this._run(['controlvm', vmName, 'poweroff']);
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    await this._run(['snapshot', vmName, 'restore', snapshotRef]);
  }

  /**
   * Delete VM snapshot.
   */
  async deleteSnapshot(vmName, snapshotRef) {
    await this._run(['snapshot', vmName, 'delete', snapshotRef]);
  }

  /**
   * Execute a command INSIDE the running guest VM via Guest Additions.
   * This is how we configure Ubuntu without the user touching the terminal.
   * 
   * Requires Guest Additions to be running inside the guest.
   * 
   * @param {string} vmName - VM name
   * @param {string} username - Guest OS username
   * @param {string} password - Guest OS password
   * @param {string} command - Command to execute (e.g., '/bin/bash')
   * @param {string[]} [args] - Command arguments
   * @param {object} [options] - Additional options
   * @returns {Promise<string>} Command stdout
   */
  async guestRun(vmName, username, password, command, args = [], options = {}) {
    const runArgs = [
      'guestcontrol', vmName, 'run',
      '--exe', command,
      '--username', username,
      '--password', password,
      '--wait-stdout',
      '--wait-stderr',
    ];

    // Add arguments for the guest command
    if (args.length > 0) {
      runArgs.push('--');
      runArgs.push(...args);
    }

    logger.info('VirtualBox', `Guest exec: ${command} ${args.join(' ')}`);

    try {
      const result = await this._run(runArgs, { timeout: options.timeout || 120000 });
      logger.debug('VirtualBox', `Guest output: ${result.trim().substring(0, 200)}`);
      return result;
    } catch (err) {
      // Some commands return non-zero but still succeed (e.g., grep no match)
      if (options.ignoreErrors) {
        logger.debug('VirtualBox', `Guest command failed (ignored): ${err.message}`);
        return '';
      }
      throw err;
    }
  }

  /**
   * Execute a shell script inside the guest VM.
   * Wraps the command in /bin/bash -c for convenience.
   * 
   * @param {string} vmName - VM name
   * @param {string} username - Guest OS username
   * @param {string} password - Guest OS password
   * @param {string} script - Shell script content
   * @param {object} [options] - Additional options
   */
  async guestShell(vmName, username, password, script, options = {}) {
    return this.guestRun(vmName, username, password, '/bin/bash', ['-c', script], options);
  }

  /**
   * Copy a file from the host into the guest VM.
   * 
   * @param {string} vmName - VM name
   * @param {string} username - Guest OS username
   * @param {string} password - Guest OS password
   * @param {string} hostPath - Source file on host
   * @param {string} guestPath - Destination inside guest
   */
  async guestCopyTo(vmName, username, password, hostPath, guestPath) {
    logger.info('VirtualBox', `Copying to guest: ${hostPath} → ${guestPath}`);

    await this._run([
      'guestcontrol', vmName, 'copyto',
      '--username', username,
      '--password', password,
      '--target-directory', guestPath,
      hostPath
    ]);
  }

  /**
   * Wait for Guest Additions to be running inside the guest VM.
   * Polls every few seconds until GA is detected or timeout.
   * 
   * @param {string} vmName - VM name
   * @param {number} [timeoutMs=600000] - Max wait time (default: 10 minutes)
   * @param {function} [onProgress] - Progress callback
   * @returns {Promise<boolean>} True if GA detected
   */
  async waitForGuestAdditions(vmName, timeoutMs = 600000, onProgress = null) {
    logger.info('VirtualBox', `Waiting for Guest Additions in "${vmName}"...`);
    const startTime = Date.now();
    const pollInterval = 10000; // Check every 10 seconds
    let attempt = 0;

    while (Date.now() - startTime < timeoutMs) {
      attempt++;
      try {
        const info = await this.getVMInfo(vmName);
        const gaVersion = info.GuestAdditionsVersion;
        const gaRunLevel = info.GuestAdditionsRunLevel;

        if (onProgress) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          onProgress({
            message: `Waiting for Guest Additions... (${elapsed}s elapsed, attempt ${attempt})`,
            gaVersion,
            gaRunLevel
          });
        }

        // GA run level 2+ means services are running
        if (gaVersion && parseInt(gaRunLevel) >= 2) {
          logger.success('VirtualBox', `Guest Additions ${gaVersion} detected (run level: ${gaRunLevel})`);
          return true;
        }

        // Check if VM is still running
        const state = info.VMState;
        if (state !== 'running') {
          logger.warn('VirtualBox', `VM state is "${state}" — waiting for it to boot...`);
        }
      } catch (err) {
        logger.debug('VirtualBox', `GA check attempt ${attempt}: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    logger.warn('VirtualBox', `Guest Additions not detected after ${timeoutMs / 1000}s`);
    return false;
  }

  /**
   * Wait for the guest OS to be fully booted and responsive.
   * Uses guestcontrol to test if we can run a simple command.
   * 
   * @param {string} vmName - VM name
   * @param {string} username - Guest OS username
   * @param {string} password - Guest OS password
   * @param {number} [timeoutMs=600000] - Max wait time
   * @param {function} [onProgress] - Progress callback
   * @returns {Promise<boolean>} True if guest is responsive
   */
  async waitForGuestReady(vmName, username, password, timeoutMs = 600000, onProgress = null) {
    logger.info('VirtualBox', `Waiting for guest OS to be ready in "${vmName}"...`);
    const startTime = Date.now();
    const pollInterval = 15000; // Check every 15 seconds
    let attempt = 0;

    while (Date.now() - startTime < timeoutMs) {
      attempt++;
      try {
        if (onProgress) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          onProgress({
            message: `Waiting for Ubuntu to be ready... (${elapsed}s elapsed)`,
            attempt
          });
        }

        // Try to run a simple command inside the guest
        const result = await this.guestRun(
          vmName, username, password,
          '/bin/echo', ['ready'],
          { timeout: 10000, ignoreErrors: true }
        );

        if (result.includes('ready')) {
          logger.success('VirtualBox', `Guest OS is ready (took ${Math.round((Date.now() - startTime) / 1000)}s)`);
          return true;
        }
      } catch (err) {
        logger.debug('VirtualBox', `Guest ready check attempt ${attempt}: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    logger.warn('VirtualBox', `Guest OS not responsive after ${timeoutMs / 1000}s`);
    return false;
  }

  /**
   * Configure host-side display integration preferences for a VM.
   * Improves fullscreen behavior and dynamic resize readiness.
   */
  async configureDisplayIntegration(vmName, options = {}) {
    const {
      fullscreen = true,
      accelerate3d = false,
      graphicsController = '',
      vram = 128
    } = options;
    logger.info('VirtualBox', `Configuring display integration for "${vmName}"...`);

    const args = [
      'modifyvm', vmName,
      ...(graphicsController ? ['--graphicscontroller', String(graphicsController).toLowerCase()] : []),
      '--vram', String(Number.isFinite(Number(vram)) ? Math.max(16, Number(vram)) : 128),
      '--monitorcount', '1',
      '--accelerate3d', accelerate3d ? 'on' : 'off'
    ];

    await this._run(args);

    const vmExtra = [
      ['GUI/Fullscreen', 'off'],
      ['GUI/AutoresizeGuest', 'on'],
      ['GUI/ScaleFactor', '1.0'],
      ['GUI/Seamless', 'off'],
      ['VMXposed/GuestDisplayFullscreen', fullscreen ? 'on' : 'off']
    ];

    for (const [key, value] of vmExtra) {
      try {
        await this._run(['setextradata', vmName, key, value]);
      } catch (err) {
        logger.debug('VirtualBox', `setextradata ${key} warning: ${err.message}`);
      }
    }

    try {
      await this._run(['setextradata', 'global', 'GUI/MaxGuestResolution', 'any']);
    } catch (err) {
      logger.debug('VirtualBox', `global GUI/MaxGuestResolution warning: ${err.message}`);
    }

    logger.success('VirtualBox', 'Display integration preferences configured');
  }

  /**
   * Apply runtime integration controls to a running VM.
   */
  async applyRuntimeIntegration(vmName, options = {}) {
    const {
      clipboardMode = 'bidirectional',
      dragAndDrop = 'bidirectional',
      width = 0,
      height = 0,
      bpp = 32,
      display = 0,
      guestDisplayFullscreen = true,
      waitForGuestAdditionsMs = 0
    } = options;

    logger.info('VirtualBox', `Applying runtime integration to "${vmName}"...`);

    const warnings = [];
    let guestAdditionsReady = false;

    try {
      const info = await this.getVMInfo(vmName);
      guestAdditionsReady = !!info.GuestAdditionsVersion && parseInt(info.GuestAdditionsRunLevel || '0', 10) >= 2;
    } catch (err) {
      warnings.push(`guest additions readiness check: ${err.message}`);
    }

    if (!guestAdditionsReady && Number(waitForGuestAdditionsMs) > 0) {
      try {
        guestAdditionsReady = await this.waitForGuestAdditions(vmName, Number(waitForGuestAdditionsMs));
      } catch (err) {
        warnings.push(`guest additions wait failed: ${err.message}`);
      }
    }

    const safeRun = async (args, warningLabel) => {
      try {
        await this._run(args);
      } catch (err) {
        warnings.push(`${warningLabel}: ${err.message}`);
      }
    };

    if (guestAdditionsReady) {
      await safeRun(['controlvm', vmName, 'clipboard', clipboardMode], 'clipboard runtime apply');
      await safeRun(['controlvm', vmName, 'draganddrop', dragAndDrop], 'drag-and-drop runtime apply');
    } else {
      warnings.push('clipboard/drag-drop deferred until Guest Additions is fully ready (existing mode preserved)');
    }
    if (guestDisplayFullscreen && Number(width) > 0 && Number(height) > 0) {
      if (guestAdditionsReady) {
        const safeWidth = Math.min(Math.max(640, Math.floor(Number(width))), 7680);
        const safeHeight = Math.min(Math.max(480, Math.floor(Number(height))), 4320);
        await safeRun(
          ['controlvm', vmName, 'setvideomodehint', String(safeWidth), String(safeHeight), String(bpp), String(display)],
          'video mode hint apply'
        );
        await new Promise((resolve) => setTimeout(resolve, 900));
        await safeRun(
          ['controlvm', vmName, 'setvideomodehint', String(safeWidth), String(safeHeight), String(bpp), String(display)],
          'video mode hint re-apply'
        );
      } else {
        warnings.push('video mode hint skipped until Guest Additions are running');
      }
    }

    if (warnings.length > 0) {
      logger.warn('VirtualBox', `Runtime integration warnings: ${warnings.join(' | ')}`);
    } else {
      logger.success('VirtualBox', 'Runtime integration applied');
    }

    return {
      success: warnings.length === 0,
      warnings
    };
  }

  /**
   * Detect the best bridge adapter for bridged networking.
   */
  async _detectBridgeAdapter() {
    try {
      const result = await this._run(['list', 'bridgedifs']);
      const nameMatch = result.match(/Name:\s*(.+)/);
      return nameMatch ? nameMatch[1].trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Execute a VBoxManage command.
   * Uses execFile for security — no shell injection possible.
   * All commands are logged for transparency.
   */
  _run(args, options = {}) {
    return new Promise((resolve, reject) => {
      if (!this.vboxManagePath) {
        return reject(new Error('VBoxManage not found. Please install VirtualBox first.'));
      }

      const cmdStr = `VBoxManage ${args.join(' ')}`;
      logger.debug('VirtualBox', `Executing: ${cmdStr}`);

      execFile(this.vboxManagePath, args, {
        timeout: options.timeout || 120000,  // 2 minute timeout
        maxBuffer: 10 * 1024 * 1024  // 10 MB buffer for large output
      }, (error, stdout, stderr) => {
        if (error) {
          const errMsg = stderr?.trim() || error.message;
          logger.error('VirtualBox', `Command failed: ${cmdStr}`);
          logger.error('VirtualBox', `Error: ${errMsg}`);
          reject(new Error(`VBoxManage error: ${errMsg}`));
        } else {
          if (stderr?.trim()) {
            logger.debug('VirtualBox', `stderr: ${stderr.trim()}`);
          }
          resolve(stdout);
        }
      });
    });
  }
}

// Singleton
const virtualbox = new VirtualBoxAdapter();
module.exports = virtualbox;
