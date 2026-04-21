/**
 * vm/vmManager.js — High-Level VM Lifecycle Manager
 * 
 * Design Decision: This module coordinates all the pieces needed to
 * create a complete, ready-to-use VM. It's the bridge between the
 * orchestrator (workflow) and the low-level VBoxManage adapter.
 * 
 * Maps user-friendly options to VBoxManage parameters.
 * Validates everything before executing to catch issues early.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const logger = require('../core/logger');
const virtualbox = require('../adapters/virtualbox');
const { configureGuestFeatures } = require('./guestAdditions');
const { setupSharedFolder } = require('./sharedFolder');

/**
 * Create and fully configure a VM from user settings.
 * This is the main entry point called by the orchestrator.
 * 
 * @param {object} config - User configuration from the wizard
 * @param {string} config.name - VM name
 * @param {string} config.installPath - Where to store VM files
 * @param {number} config.ram - RAM in MB
 * @param {number} config.cpus - Number of CPU cores
 * @param {number} config.disk - Disk size in MB
 * @param {string} config.isoPath - Path to Ubuntu ISO
 * @param {string} config.osType - VirtualBox OS type
 * @param {string} config.network - 'nat' or 'bridged'
 * @param {string} [config.sharedFolderPath] - Host path for shared folder
 * @param {string} [config.username] - Default user for Ubuntu
 * @param {string} [config.password] - Default password for Ubuntu
 * @param {function} [onProgress] - Progress callback for UI updates
 * @returns {Promise<object>} VM creation result
 */
async function createAndConfigureVM(config, onProgress = null) {
  const {
    name,
    installPath,
    ram,
    cpus,
    disk,
    isoPath,
    osType = 'Ubuntu_64',
    network = 'nat',
    sharedFolderPath,
    username = 'guest',
    password = 'guest',
    unattended = true,
    graphicsController = 'vmsvga',
    vram = 128,
    audioController = 'hda',
    startFullscreen = true,
    accelerate3d = false,
    clipboardMode = 'bidirectional',
    dragAndDrop = 'bidirectional',
    autoStartVm = false
  } = config;

  // ─── Pre-flight validation ────────────────────────────────────────
  logger.info('VMManager', '═══ Starting V Os Creation ═══');
  logger.info('VMManager', `V Os Name: ${name}`);
  logger.info('VMManager', `Install Path: ${installPath}`);
  logger.info('VMManager', `Requested resources: ${ram}MB RAM, ${cpus} CPUs, ${disk}MB Disk`);

  _emitProgress(onProgress, 'validate', 'Validating configuration...', 0);

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('V Os name is required.');
  }
  if (!installPath || typeof installPath !== 'string') {
    throw new Error('Install path is required.');
  }
  if (!Number.isFinite(ram) || ram < 1024) {
    throw new Error(`Invalid RAM value: ${ram}. Minimum is 1024 MB.`);
  }
  if (!Number.isFinite(cpus) || cpus < 1) {
    throw new Error(`Invalid CPU core count: ${cpus}. Minimum is 1.`);
  }
  if (!Number.isFinite(disk) || disk < 10240) {
    throw new Error(`Invalid disk size: ${disk}. Minimum is 10240 MB.`);
  }

  const hostTotalRamMb = Math.max(1024, Math.floor(os.totalmem() / (1024 * 1024)));
  const hostCpuCores = Math.max(1, os.cpus()?.length || 1);
  const safeMaxRamMb = Math.max(1024, Math.floor(hostTotalRamMb * 0.5));
  const safeMaxCpus = Math.max(1, hostCpuCores - 1);
  const effectiveRam = Math.max(1024, Math.min(ram, safeMaxRamMb));
  const effectiveCpus = Math.max(1, Math.min(cpus, safeMaxCpus));

  if (effectiveRam !== ram || effectiveCpus !== cpus) {
    logger.warn(
      'VMManager',
      `Adjusted resources for host responsiveness: RAM ${ram}→${effectiveRam} MB, CPU ${cpus}→${effectiveCpus} core(s)`
    );
    _emitProgress(
      onProgress,
      'validate',
      `Adjusted resources for smoother host performance (RAM ${effectiveRam} MB, CPU ${effectiveCpus}).`,
      5
    );
  }

  // Check if VM already exists — auto-cleanup from failed previous runs
  if (await virtualbox.vmExists(name)) {
    logger.warn('VMManager', `V Os "${name}" already exists — removing old/partial V Os...`);
    _emitProgress(onProgress, 'validate', 'Cleaning up previous partial V Os...', 2);
    try {
      await virtualbox.deleteVM(name);
      logger.success('VMManager', `Old V Os "${name}" removed — starting fresh`);
    } catch (err) {
      logger.error('VMManager', `Could not remove old V Os: ${err.message}`);
      throw new Error(`A V Os named "${name}" exists and could not be removed. Please delete it manually from VirtualBox Manager.`);
    }
  }

  // Ensure ISO file exists
  if (!fs.existsSync(isoPath)) {
    throw new Error(`ISO file not found: ${isoPath}`);
  }

  // Ensure install directory exists
  await fs.promises.mkdir(installPath, { recursive: true });

  // ─── Step 1: Create VM ────────────────────────────────────────────
  _emitProgress(onProgress, 'create', 'Creating virtual OS...', 10);
  await virtualbox.createVM(name, osType, installPath);

  // ─── Step 2: Configure Hardware ───────────────────────────────────
  _emitProgress(onProgress, 'configure', 'Configuring hardware...', 20);
  await virtualbox.configureVM(name, {
    ram: effectiveRam,
    cpus: effectiveCpus,
    vram,
    graphicsController,
    audioController,
    accelerate3d: accelerate3d ? 'on' : 'off',
    ioapic: 'on',
    acpi: 'on',
    pae: 'on',
    nestedPaging: 'on',
    rtcUseUtc: 'on',
    usbOhci: 'on',
    bootOrder: ['dvd', 'disk', 'none', 'none']
  });

  // ─── Step 3: Create Virtual Disk ──────────────────────────────────
  _emitProgress(onProgress, 'disk', 'Creating virtual hard disk...', 30);
  const diskPath = path.join(installPath, name, `${name}.vdi`);
  await virtualbox.createDisk(diskPath, disk);

  // ─── Step 4: Setup Storage Controllers ────────────────────────────
  _emitProgress(onProgress, 'storage', 'Setting up storage controllers...', 40);

  // SATA controller for hard disk
  await virtualbox.addStorageController(name, 'SATA Controller', 'sata');
  await virtualbox.attachStorage(name, 'SATA Controller', 0, 0, 'hdd', diskPath);

  // IDE controller for DVD/ISO
  await virtualbox.addStorageController(name, 'IDE Controller', 'ide');
  await virtualbox.attachStorage(name, 'IDE Controller', 0, 0, 'dvddrive', isoPath);

  // ─── Step 5: Configure Network ────────────────────────────────────
  _emitProgress(onProgress, 'network', `Configuring network (${network})...`, 50);
  await virtualbox.configureNetwork(name, network);

  // ─── Step 6: Configure Guest Features ─────────────────────────────
  _emitProgress(onProgress, 'guest', 'Setting up Guest Additions features...', 60);
  await configureGuestFeatures(name, {
    fullscreen: startFullscreen !== false,
    accelerate3d: accelerate3d === true,
    graphicsController,
    vram,
    clipboardMode,
    dragAndDrop
  });

  // ─── Step 7: Shared Folder ────────────────────────────────────────
  let sharedFolderResult = null;
  if (sharedFolderPath) {
    _emitProgress(onProgress, 'shared', 'Configuring shared folder...', 70);
    sharedFolderResult = await setupSharedFolder(name, sharedFolderPath);
  }

  // ─── Step 8: Unattended Install ───────────────────────────────────
  if (unattended) {
    _emitProgress(onProgress, 'unattended', 'Setting up unattended OS installation...', 80);
    await virtualbox.unattendedInstall(name, {
      isoPath,
      username,
      password,
      fullName: username,
      hostname: name.replace(/\s+/g, '-').toLowerCase() + '.local',
      installAdditions: true,
      postInstallCommand: [
        'apt-get install -y virtualbox-guest-utils virtualbox-guest-x11 2>/dev/null',
        `usermod -aG vboxsf ${username} 2>/dev/null`,
        `usermod -aG video ${username} 2>/dev/null`,
        `mkdir -p /home/${username}/.config/autostart`,
        `echo -e "[Desktop Entry]\\nType=Application\\nName=VBoxClient\\nExec=/usr/bin/VBoxClient-all\\nX-GNOME-Autostart-enabled=true\\nNoDisplay=true" > /home/${username}/.config/autostart/vboxclient.desktop`,
        'grep -q vboxsf /etc/fstab || echo "shared /media/sf_shared vboxsf rw,_netdev,umask=0007 0 0" >> /etc/fstab',
        'mkdir -p /media/sf_shared',
        `su - ${username} -c "gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null" 2>/dev/null`,
      ].join(' ; ')
    });
  } else {
    _emitProgress(onProgress, 'unattended', 'Skipping unattended install (manual OS install required)', 80);
  }

  // ─── Step 9: Start VM ────────────────────────────────────────────
  if (autoStartVm) {
    _emitProgress(onProgress, 'start', 'Starting virtual OS...', 90);
    await virtualbox.startVM(name);

    const running = await _waitForVMState(name, 'running', 45000, 3000);
    if (!running) {
      throw new Error('V Os start command completed but V Os did not reach running state. Check VirtualBox logs for details.');
    }

    try {
      await virtualbox.applyRuntimeIntegration(name, {
        clipboardMode: clipboardMode || 'bidirectional',
        dragAndDrop: dragAndDrop || 'bidirectional',
        guestDisplayFullscreen: startFullscreen !== false,
        waitForGuestAdditionsMs: startFullscreen !== false ? 120000 : 0
      });
    } catch (err) {
      logger.warn('VMManager', `Runtime display integration warning: ${err.message}`);
    }
  } else {
    _emitProgress(onProgress, 'start', 'Auto-start disabled. V Os was prepared and left powered off.', 90);
  }

  // ─── Complete ────────────────────────────────────────────────────
  _emitProgress(
    onProgress,
    'complete',
    autoStartVm ? 'V Os is up and running!' : 'V Os is prepared. Start it manually when ready.',
    100
  );

  const result = {
    vmName: name,
    installPath,
    diskPath,
    resources: { ram: effectiveRam, cpus: effectiveCpus, disk },
    network,
    sharedFolder: sharedFolderResult,
    credentials: { username, password },
    status: autoStartVm ? 'running' : 'poweroff'
  };

  logger.success('VMManager', '═══ V Os Creation Complete ═══');
  if (autoStartVm) {
    logger.info('VMManager', `V Os "${name}" is now installing Ubuntu automatically.`);
  } else {
    logger.info('VMManager', `V Os "${name}" was prepared and left powered off (auto-start disabled).`);
  }
  logger.info('VMManager', `Login credentials: ${username} / ${password}`);
  if (sharedFolderResult) {
    logger.info('VMManager', `Shared folder: ${sharedFolderResult.guestMountPoint}`);
  }

  return result;
}

async function _waitForVMState(vmName, desiredState, timeoutMs, intervalMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = (await virtualbox.getVMState(vmName) || '').toLowerCase();
    if (state === desiredState.toLowerCase()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Emit a progress event to the UI.
 */
function _emitProgress(callback, phase, message, percent) {
  logger.info('VMManager', `[${percent}%] ${message}`);
  if (callback) {
    callback({ phase, message, percent });
  }
}

module.exports = { createAndConfigureVM };
