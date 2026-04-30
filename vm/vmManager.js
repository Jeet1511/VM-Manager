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
const LINUX_USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const MIN_SUPPORTED_ISO_BYTES = 80 * 1024 * 1024;

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
  const normalizedInstallPath = path.resolve(String(installPath || '').trim());
  const normalizedIsoPath = path.resolve(String(isoPath || '').trim());
  const normalizedUsername = String(username || '').trim();
  const normalizedPassword = String(password ?? '');

  // ─── Pre-flight validation ────────────────────────────────────────
  logger.info('VMManager', '═══ Starting V Os Creation ═══');
  logger.info('VMManager', `V Os Name: ${name}`);
  logger.info('VMManager', `Install Path: ${normalizedInstallPath}`);
  logger.info('VMManager', `Requested resources: ${ram}MB RAM, ${cpus} CPUs, ${disk}MB Disk`);

  _emitProgress(onProgress, 'validate', 'Validating configuration...', 0);

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('V Os name is required.');
  }
  if (!normalizedUsername) {
    throw new Error('Guest username is required.');
  }
  if (!LINUX_USERNAME_PATTERN.test(normalizedUsername)) {
    throw new Error('Guest username must start with a letter/underscore and contain only letters, numbers, underscores, or hyphens.');
  }
  if (!normalizedPassword) {
    throw new Error('Guest password is required.');
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

  // Check if VM already exists — never delete user data implicitly.
  if (await virtualbox.vmExists(name)) {
    logger.warn('VMManager', `V Os "${name}" already exists — refusing to overwrite existing machine`);
    throw new Error(`A V Os named "${name}" already exists. Choose a different V Os name, or enable "Use an already downloaded V Os" in Review & Create.`);
  }

  // Ensure ISO file exists
  if (!fs.existsSync(normalizedIsoPath)) {
    throw new Error(`ISO file not found: ${normalizedIsoPath}`);
  }
  if (path.extname(normalizedIsoPath).toLowerCase() !== '.iso') {
    throw new Error(`Unsupported OS image file: ${normalizedIsoPath}. Please select a valid .iso file.`);
  }
  const isoStats = await fs.promises.stat(normalizedIsoPath);
  if (!isoStats.isFile()) {
    throw new Error(`ISO path is not a file: ${normalizedIsoPath}`);
  }
  if (isoStats.size < MIN_SUPPORTED_ISO_BYTES) {
    throw new Error('Selected ISO file appears incomplete or unsupported (file size is too small).');
  }
  await fs.promises.access(normalizedIsoPath, fs.constants.R_OK);

  // Ensure install directory exists
  await fs.promises.mkdir(normalizedInstallPath, { recursive: true });
  await _assertDirectoryWritable(normalizedInstallPath, 'V Os install folder');

  // ─── Step 1: Create VM ────────────────────────────────────────────
  _emitProgress(onProgress, 'create', 'Creating virtual OS...', 10);
  await virtualbox.createVM(name, osType, normalizedInstallPath);

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
  const vmDir = await _resolveVmDirectory(name, normalizedInstallPath);
  const diskFileStem = _sanitizeDiskFileStem(name);
  const diskPath = await _createDiskWithRecovery(path.join(vmDir, `${diskFileStem}.vdi`), disk);

  // ─── Step 4: Setup Storage Controllers ────────────────────────────
  _emitProgress(onProgress, 'storage', 'Setting up storage controllers...', 40);

  // SATA controller for hard disk
  await virtualbox.addStorageController(name, 'SATA Controller', 'sata');
  try {
    await virtualbox.attachStorage(name, 'SATA Controller', 0, 0, 'hdd', diskPath);
  } catch (err) {
    throw new Error(`Virtual disk attach failed for "${diskPath}". ${err.message}`);
  }

  // IDE controller for DVD/ISO
  await virtualbox.addStorageController(name, 'IDE Controller', 'ide');
  try {
    await virtualbox.attachStorage(name, 'IDE Controller', 0, 0, 'dvddrive', normalizedIsoPath);
  } catch (err) {
    throw new Error(`ISO attach failed for "${normalizedIsoPath}". ${err.message}`);
  }

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
      isoPath: normalizedIsoPath,
      username: normalizedUsername,
      password: normalizedPassword,
      fullName: normalizedUsername,
      hostname: name.replace(/\s+/g, '-').toLowerCase() + '.local',
      installAdditions: true,
      postInstallCommand: [
        'apt-get install -y virtualbox-guest-utils virtualbox-guest-x11 2>/dev/null',
        `usermod -aG vboxsf ${normalizedUsername} 2>/dev/null`,
        `usermod -aG video ${normalizedUsername} 2>/dev/null`,
        `mkdir -p /home/${normalizedUsername}/.config/autostart`,
        `echo -e "[Desktop Entry]\\nType=Application\\nName=VBoxClient\\nExec=/usr/bin/VBoxClient-all\\nX-GNOME-Autostart-enabled=true\\nNoDisplay=true" > /home/${normalizedUsername}/.config/autostart/vboxclient.desktop`,
        'grep -q vboxsf /etc/fstab || echo "shared /media/sf_shared vboxsf rw,_netdev,umask=0007 0 0" >> /etc/fstab',
        'mkdir -p /media/sf_shared',
        `su - ${normalizedUsername} -c "gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null" 2>/dev/null`,
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
    installPath: normalizedInstallPath,
    diskPath,
    resources: { ram: effectiveRam, cpus: effectiveCpus, disk },
    network,
    sharedFolder: sharedFolderResult,
    credentials: { username: normalizedUsername, password: normalizedPassword },
    status: autoStartVm ? 'running' : 'poweroff'
  };

  logger.success('VMManager', '═══ V Os Creation Complete ═══');
  if (autoStartVm) {
    logger.info('VMManager', `V Os "${name}" is now installing Ubuntu automatically.`);
  } else {
    logger.info('VMManager', `V Os "${name}" was prepared and left powered off (auto-start disabled).`);
  }
  logger.info('VMManager', `Login credentials: ${normalizedUsername} / ${normalizedPassword}`);
  if (sharedFolderResult) {
    logger.info('VMManager', `Shared folder: ${sharedFolderResult.guestMountPoint}`);
  }

  return result;
}

async function _resolveVmDirectory(vmName, fallbackInstallPath) {
  try {
    const info = await virtualbox.getVMInfo(vmName);
    const cfgFile = String(info?.CfgFile || '')
      .replace(/\\\\/g, '\\')
      .replace(/^"(.*)"$/, '$1')
      .trim();
    if (cfgFile) {
      const vmDir = path.dirname(cfgFile);
      await fs.promises.mkdir(vmDir, { recursive: true });
      return vmDir;
    }
  } catch (err) {
    logger.warn('VMManager', `Could not resolve VM directory from VBox metadata: ${err.message}`);
  }

  const fallback = path.join(fallbackInstallPath, vmName);
  await fs.promises.mkdir(fallback, { recursive: true });
  return fallback;
}

function _sanitizeDiskFileStem(vmName) {
  const base = String(vmName || 'vm-disk')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const trimmed = base.slice(0, 96).trim();
  return trimmed || 'vm-disk';
}

function _isConstructMediaError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('constructmedia')
    || msg.includes('code e_fail')
    || msg.includes('0x80004005')
    || msg.includes('vboxmanagemisc.cpp')
  );
}

async function _cleanupStaleMedium(targetPath) {
  const normalized = path.resolve(String(targetPath || '').trim());
  if (!normalized) return;
  try {
    if (fs.existsSync(normalized)) {
      await fs.promises.unlink(normalized);
    }
  } catch (err) {
    logger.warn('VMManager', `Could not remove stale disk file "${normalized}": ${err.message}`);
  }

  try {
    await virtualbox._run(['closemedium', 'disk', normalized, '--delete']);
  } catch (err) {
    logger.info('VMManager', `No stale VirtualBox medium registration to remove for "${normalized}": ${err.message}`);
  }
}

async function _createDiskWithRecovery(initialDiskPath, sizeMb) {
  const primary = path.resolve(String(initialDiskPath || '').trim());
  const parsed = path.parse(primary);
  const fallback = path.join(parsed.dir, `${parsed.name}-${Date.now()}.vdi`);
  const attempts = [primary, fallback];
  let lastErr = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const candidate = attempts[index];
    try {
      await fs.promises.mkdir(path.dirname(candidate), { recursive: true });
      await _cleanupStaleMedium(candidate);
      await virtualbox.createDisk(candidate, sizeMb);
      if (index > 0) {
        logger.warn('VMManager', `Primary disk path failed; using fallback disk path: ${candidate}`);
      }
      return candidate;
    } catch (err) {
      lastErr = err;
      const retryAllowed = index < (attempts.length - 1) && _isConstructMediaError(err);
      if (!retryAllowed) {
        break;
      }
      logger.warn('VMManager', `Disk creation failed at ${candidate}. Retrying with alternate medium path... ${err.message}`);
    }
  }

  throw new Error(`Virtual disk creation failed. ${lastErr?.message || 'Unknown error'}`);
}

async function _assertDirectoryWritable(directoryPath, label) {
  const target = path.resolve(String(directoryPath || '').trim());
  if (!target) {
    throw new Error(`${label} is not set.`);
  }
  const probeFile = path.join(target, `.vmxposed-write-test-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.promises.writeFile(probeFile, 'ok', 'utf8');
  } catch (err) {
    throw new Error(`${label} is not writable: ${target}. ${err.message}`);
  } finally {
    try {
      if (fs.existsSync(probeFile)) {
        await fs.promises.unlink(probeFile);
      }
    } catch {}
  }
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
