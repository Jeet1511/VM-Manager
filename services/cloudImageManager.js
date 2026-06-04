/**
 * services/cloudImageManager.js — Cloud Image VM Creation
 * 
 * Downloads pre-built Ubuntu cloud images (VMDK format) and creates VMs
 * from them — no ISO installer needed. The OS is already installed.
 * Cloud-init configures user/password/hostname on first boot (~30 seconds).
 * 
 * Supported: Ubuntu 20.04+ (Focal, Jammy, Noble)
 * Fallback: Older Ubuntu and non-Ubuntu OSes use the existing ISO flow.
 */

const path = require('path');
const fs = require('fs');
const logger = require('../core/logger');
const virtualbox = require('../adapters/virtualbox');
const { downloadFile, isDownloadComplete } = require('./downloadManager');
const { createCloudInitIso, attachIsoToVM } = require('../vm/cloudInit');

// ─── Cloud Image URL Mapping ─────────────────────────────────────────
// Ubuntu publishes pre-installed VMDK images at cloud-images.ubuntu.com.
// These are ~550-640 MB (vs ~4.7 GB for desktop ISOs).

const CLOUD_IMAGE_REGISTRY = {
  'noble': {
    codename: 'noble',
    version: '24.04',
    vmdkUrl: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.vmdk',
    sha256Url: 'https://cloud-images.ubuntu.com/noble/current/SHA256SUMS',
    filename: 'noble-server-cloudimg-amd64.vmdk',
    sizeMb: 572,
  },
  'jammy': {
    codename: 'jammy',
    version: '22.04',
    vmdkUrl: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.vmdk',
    sha256Url: 'https://cloud-images.ubuntu.com/jammy/current/SHA256SUMS',
    filename: 'jammy-server-cloudimg-amd64.vmdk',
    sizeMb: 641,
  },
  'focal': {
    codename: 'focal',
    version: '20.04',
    vmdkUrl: 'https://cloud-images.ubuntu.com/focal/current/focal-server-cloudimg-amd64.vmdk',
    sha256Url: 'https://cloud-images.ubuntu.com/focal/current/SHA256SUMS',
    filename: 'focal-server-cloudimg-amd64.vmdk',
    sizeMb: 550,
  }
};

// Map Ubuntu version numbers to codenames
const VERSION_TO_CODENAME = {
  '24.04': 'noble',
  '24.04.1': 'noble',
  '22.04': 'jammy',
  '22.04.4': 'jammy',
  '20.04': 'focal',
  '20.04.6': 'focal',
};

/**
 * Check if a cloud image is available for the given OS catalog entry.
 * @param {object} osEntry - OS catalog entry from config.js
 * @param {string} osName - OS display name (e.g., "Ubuntu 24.04.1 LTS (Noble Numbat)")
 * @returns {object|null} Cloud image info or null
 */
function getCloudImageInfo(osEntry, osName = '') {
  if (!osEntry) return null;

  // Must be Ubuntu
  const category = String(osEntry.category || '').toLowerCase();
  const osType = String(osEntry.osType || '').toLowerCase();
  if (category !== 'ubuntu' && !osType.includes('ubuntu')) return null;

  // Check if the entry already has a cloudImageUrl
  if (osEntry.cloudImageUrl) {
    return {
      url: osEntry.cloudImageUrl,
      sha256Url: osEntry.cloudImageSha256Url || null,
      filename: osEntry.cloudImageFilename || path.basename(osEntry.cloudImageUrl),
      codename: osEntry.cloudImageCodename || null,
    };
  }

  // Extract version from filename, downloadUrl, or osName
  const sources = [
    osEntry.filename || '',
    osEntry.downloadUrl || '',
    osName || ''
  ].join(' ');

  const versionMatch = sources.match(/ubuntu[^0-9]*((\d{2}\.\d{2})(?:\.\d+)?)/i);
  if (!versionMatch) return null;

  const fullVersion = versionMatch[1];
  const majorVersion = versionMatch[2];

  // Look up codename
  const codename = VERSION_TO_CODENAME[fullVersion] || VERSION_TO_CODENAME[majorVersion];
  if (!codename) return null;

  const registry = CLOUD_IMAGE_REGISTRY[codename];
  if (!registry) return null;

  return {
    url: registry.vmdkUrl,
    sha256Url: registry.sha256Url,
    filename: registry.filename,
    codename: registry.codename,
    estimatedSizeMb: registry.sizeMb,
  };
}

/**
 * Check if a cloud image is available for an OS.
 * @param {object} osEntry - OS catalog entry
 * @param {string} osName - OS display name
 * @returns {boolean}
 */
function isCloudImageAvailable(osEntry, osName = '') {
  return getCloudImageInfo(osEntry, osName) !== null;
}

/**
 * Download a cloud image VMDK file.
 * @param {object} cloudInfo - Result from getCloudImageInfo()
 * @param {string} destDir - Directory to store downloaded VMDK
 * @param {object} options - { signal, onProgress }
 * @returns {Promise<string>} Path to downloaded VMDK
 */
async function downloadCloudImage(cloudInfo, destDir, options = {}) {
  const { signal, onProgress } = options;

  if (!cloudInfo?.url) {
    throw new Error('No cloud image URL provided.');
  }

  const expectedPath = path.join(destDir, cloudInfo.filename);

  // Check if already downloaded
  if (isDownloadComplete(expectedPath)) {
    logger.info('CloudImage', `Cloud image already downloaded: ${cloudInfo.filename}`);
    if (onProgress) onProgress({ percent: 100, message: 'Cloud image already downloaded.' });
    return expectedPath;
  }

  logger.info('CloudImage', `Downloading cloud image: ${cloudInfo.url}`);
  if (onProgress) onProgress({ percent: 0, message: `Downloading ${cloudInfo.filename}...` });

  const filePath = await downloadFile(cloudInfo.url, destDir, cloudInfo.filename, {
    signal,
    onProgress: (p) => {
      if (onProgress) {
        onProgress({
          percent: p.percent || 0,
          message: `Downloading cloud image... ${p.percent || 0}% (${p.speedFormatted || ''})`,
          downloadProgress: p,
        });
      }
    }
  });

  logger.success('CloudImage', `Cloud image downloaded: ${filePath}`);
  return filePath;
}

/**
 * Clone a cloud image VMDK into a VDI in the VM directory and resize it.
 * 
 * Uses VBoxManage clonemedium to make a copy (so the original VMDK is reusable)
 * and modifymedium to resize to the user's configured disk size.
 * 
 * @param {string} vmdkPath - Path to downloaded cloud image VMDK
 * @param {string} vmDir - Directory where VM files are stored
 * @param {string} vmName - VM name (for filename generation)
 * @param {number} diskSizeMb - Target disk size in MB
 * @param {function} onProgress - Progress callback
 * @returns {Promise<string>} Path to cloned and resized VDI
 */
async function prepareCloudDisk(vmdkPath, vmDir, vmName, diskSizeMb, onProgress = null) {
  const sanitizedName = String(vmName || 'vm-disk')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 96)
    .trim() || 'vm-disk';

  const vdiPath = path.join(vmDir, `${sanitizedName}.vdi`);

  // Ensure VM directory exists
  await fs.promises.mkdir(vmDir, { recursive: true });

  // Remove any stale VDI with same name
  try {
    if (fs.existsSync(vdiPath)) {
      await virtualbox._run(['closemedium', 'disk', vdiPath, '--delete']).catch(() => {});
      await fs.promises.unlink(vdiPath).catch(() => {});
    }
  } catch (err) {
    logger.warn('CloudImage', `Could not clean stale disk: ${err.message}`);
  }

  // Step 1: Clone VMDK → VDI
  logger.info('CloudImage', `Cloning cloud image to VDI: ${vdiPath}`);
  if (onProgress) onProgress({ message: 'Cloning cloud image to virtual disk...', percent: 30 });

  await virtualbox._run([
    'clonemedium', 'disk',
    vmdkPath,
    vdiPath,
    '--format', 'VDI'
  ]);

  logger.success('CloudImage', `Clone complete: ${vdiPath}`);

  // Step 2: Resize VDI to user-specified size
  if (diskSizeMb && diskSizeMb > 0) {
    logger.info('CloudImage', `Resizing VDI to ${diskSizeMb} MB...`);
    if (onProgress) onProgress({ message: `Resizing disk to ${Math.floor(diskSizeMb / 1024)} GB...`, percent: 50 });

    await virtualbox._run([
      'modifymedium', 'disk',
      vdiPath,
      '--resize', String(diskSizeMb)
    ]);

    logger.success('CloudImage', `Disk resized to ${diskSizeMb} MB`);
  }

  if (onProgress) onProgress({ message: 'Virtual disk prepared.', percent: 60 });

  return vdiPath;
}

/**
 * Create a complete VM from a cloud image.
 * This is the main entry point — replaces the ISO-based creation for supported OSes.
 * 
 * Flow:
 * 1. Clone VMDK → VDI and resize
 * 2. Create VM shell
 * 3. Configure hardware (RAM, CPU, network, etc.)
 * 4. Attach cloned VDI as boot disk
 * 5. Generate cloud-init seed ISO (user, password, hostname)
 * 6. Attach seed ISO as secondary DVD
 * 7. Start VM → cloud-init runs on first boot (~30 seconds) → OS ready
 * 
 * @param {object} config - Same config shape as vmManager.createAndConfigureVM
 * @param {string} config.cloudImagePath - Path to downloaded VMDK
 * @param {function} onProgress - Progress callback
 * @returns {Promise<object>} VM creation result
 */
async function createVMFromCloudImage(config, onProgress = null) {
  const {
    name,
    installPath,
    ram,
    cpus,
    disk,
    cloudImagePath,
    osType = 'Ubuntu_64',
    network = 'nat',
    sharedFolderPath,
    username = 'guest',
    password = 'guest',
    graphicsController = 'vmsvga',
    vram = 128,
    audioController = 'hda',
    startFullscreen = true,
    accelerate3d = false,
    clipboardMode = 'bidirectional',
    dragAndDrop = 'bidirectional',
    autoStartVm = false,
    displayWidth = 0,
    displayHeight = 0,
  } = config;

  const normalizedInstallPath = path.resolve(String(installPath || '').trim());
  const normalizedUsername = String(username || '').trim() || 'guest';
  const normalizedPassword = String(password ?? 'guest');
  const os = require('os');
  const { configureGuestFeatures } = require('../vm/guestAdditions');
  const { setupSharedFolder } = require('../vm/sharedFolder');

  const _emit = (phase, message, percent) => {
    logger.info('CloudImage', `[${percent}%] ${message}`);
    if (onProgress) onProgress({ phase, message, percent });
  };

  logger.info('CloudImage', '═══ Starting Cloud Image VM Creation ═══');
  logger.info('CloudImage', `V Os Name: ${name}`);
  logger.info('CloudImage', `Cloud Image: ${cloudImagePath}`);
  logger.info('CloudImage', `Resources: ${ram}MB RAM, ${cpus} CPUs, ${disk}MB Disk`);

  // ─── Validation ────────────────────────────────────────────────────
  _emit('validate', 'Validating configuration...', 0);

  if (!name || !name.trim()) throw new Error('V Os name is required.');
  if (!cloudImagePath || !fs.existsSync(cloudImagePath)) {
    throw new Error(`Cloud image not found: ${cloudImagePath}`);
  }
  if (await virtualbox.vmExists(name)) {
    throw new Error(`A V Os named "${name}" already exists. Choose a different name.`);
  }

  // Resource clamping
  const hostTotalRamMb = Math.max(1024, Math.floor(os.totalmem() / (1024 * 1024)));
  const hostCpuCores = Math.max(1, os.cpus()?.length || 1);
  const effectiveRam = Math.max(1024, Math.min(ram, Math.floor(hostTotalRamMb * 0.5)));
  const effectiveCpus = Math.max(1, Math.min(cpus, hostCpuCores - 1));

  await fs.promises.mkdir(normalizedInstallPath, { recursive: true });

  // ─── Step 1: Create VM shell ───────────────────────────────────────
  _emit('create', 'Creating virtual OS...', 10);
  await virtualbox.createVM(name, osType, normalizedInstallPath);

  // ─── Step 2: Configure hardware ────────────────────────────────────
  _emit('configure', 'Configuring hardware...', 15);
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
    bootOrder: ['disk', 'dvd', 'none', 'none']  // Disk first — no installer needed
  });

  // ─── Step 3: Clone cloud image → VDI ──────────────────────────────
  _emit('disk', 'Preparing cloud image disk...', 25);

  // Resolve VM directory (VBox may create a subfolder)
  let vmDir;
  try {
    const info = await virtualbox.getVMInfo(name);
    const cfgFile = String(info?.CfgFile || '')
      .replace(/\\\\/g, '\\')
      .replace(/^"(.*)"$/, '$1')
      .trim();
    vmDir = cfgFile ? path.dirname(cfgFile) : path.join(normalizedInstallPath, name);
  } catch {
    vmDir = path.join(normalizedInstallPath, name);
  }
  await fs.promises.mkdir(vmDir, { recursive: true });

  const diskPath = await prepareCloudDisk(cloudImagePath, vmDir, name, disk, (p) => {
    _emit('disk', p.message, p.percent);
  });

  // ─── Step 4: Attach disk ───────────────────────────────────────────
  _emit('storage', 'Setting up storage controllers...', 65);

  await virtualbox.addStorageController(name, 'SATA Controller', 'sata');
  await virtualbox.attachStorage(name, 'SATA Controller', 0, 0, 'hdd', diskPath);

  // IDE controller for cloud-init seed ISO
  await virtualbox.addStorageController(name, 'IDE Controller', 'ide');

  // ─── Step 5: Configure network ─────────────────────────────────────
  _emit('network', `Configuring network (${network})...`, 70);
  await virtualbox.configureNetwork(name, network);

  // ─── Step 6: Guest features ────────────────────────────────────────
  _emit('guest', 'Setting up Guest Additions features...', 73);
  await configureGuestFeatures(name, {
    fullscreen: startFullscreen !== false,
    accelerate3d: accelerate3d === true,
    graphicsController,
    vram,
    clipboardMode,
    dragAndDrop,
    width: displayWidth,
    height: displayHeight
  });

  // Persist integration preferences
  try {
    await virtualbox._run(['setextradata', name, 'VMXposed/ClipboardMode', clipboardMode || 'bidirectional']);
    await virtualbox._run(['setextradata', name, 'VMXposed/DragAndDropMode', dragAndDrop || 'bidirectional']);
    await virtualbox._run(['setextradata', name, 'VMXposed/GuestDisplayFullscreen', (startFullscreen !== false) ? 'on' : 'off']);
  } catch (err) {
    logger.warn('CloudImage', `Could not persist integration preferences: ${err.message}`);
  }

  // ─── Step 7: Shared folder ─────────────────────────────────────────
  let sharedFolderResult = null;
  if (sharedFolderPath) {
    _emit('shared', 'Configuring shared folder...', 76);
    sharedFolderResult = await setupSharedFolder(name, sharedFolderPath);
  }

  // ─── Step 8: Cloud-init seed ISO ───────────────────────────────────
  _emit('cloudinit', 'Generating cloud-init configuration...', 80);

  const seedIsoPath = await createCloudInitIso(vmDir, {
    hostname: name.replace(/\s+/g, '-').toLowerCase(),
    username: normalizedUsername,
    password: normalizedPassword,
    fullName: normalizedUsername,
    locale: 'en_US.UTF-8',
    timezone: 'UTC',
    keyboardLayout: 'us',
    installGuestAdditions: true,
    enableSharedFolder: !!sharedFolderPath,
    disableScreenLock: true,
    enableAutoLogin: true,
    disableWayland: true
  });

  await attachIsoToVM(name, seedIsoPath, virtualbox);
  logger.success('CloudImage', 'Cloud-init seed ISO attached');

  // Mark VM state
  try {
    await virtualbox._run(['setextradata', name, 'VMXposed/InstallMethod', 'cloud-image']);
    await virtualbox._run(['setextradata', name, 'VMXposed/UnattendedApplied', 'on']);
    await virtualbox._run(['setextradata', name, 'VMXposed/InstalledDiskReady', 'on']);
    await virtualbox._run(['setextradata', name, 'VMXposed/InstallPhase', 'first-boot']);
    await virtualbox._run(['setextradata', name, 'VMXposed/ManualInstallRequired', 'off']);
    await virtualbox._run(['setextradata', name, 'VMXposed/GuestInstallMarker', 'off']);
  } catch (err) {
    logger.warn('CloudImage', `Could not persist install state: ${err.message}`);
  }

  // ─── Step 9: Start VM ──────────────────────────────────────────────
  if (autoStartVm) {
    _emit('start', 'Starting virtual OS (cloud-init first boot)...', 90);
    await virtualbox.startVM(name);

    // Wait for VM to reach running state
    const started = Date.now();
    const timeout = 45000;
    let running = false;
    while (Date.now() - started < timeout) {
      const state = (await virtualbox.getVMState(name) || '').toLowerCase();
      if (state === 'running') { running = true; break; }
      await new Promise(r => setTimeout(r, 3000));
    }

    if (!running) {
      throw new Error('V Os failed to start.');
    }

    // Apply runtime integration
    try {
      await virtualbox.applyRuntimeIntegration(name, {
        clipboardMode: clipboardMode || 'bidirectional',
        dragAndDrop: dragAndDrop || 'bidirectional',
        width: displayWidth,
        height: displayHeight,
        bpp: 32,
        display: 0,
        guestDisplayFullscreen: startFullscreen !== false,
        waitForGuestAdditionsMs: startFullscreen !== false ? 120000 : 0
      });
    } catch (err) {
      logger.warn('CloudImage', `Runtime integration warning: ${err.message}`);
    }
  } else {
    _emit('start', 'Auto-start disabled. V Os prepared and left powered off.', 90);
  }

  // ─── Complete ──────────────────────────────────────────────────────
  _emit('complete', autoStartVm
    ? 'V Os is booting! Cloud-init is configuring the OS (~30 seconds).'
    : 'V Os prepared. Start it when ready — first boot takes ~30 seconds.',
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
    unattendedApplied: true,
    autoStarted: autoStartVm,
    status: autoStartVm ? 'running' : 'poweroff',
    installMethod: 'cloud-image'
  };

  logger.success('CloudImage', '═══ Cloud Image VM Creation Complete ═══');
  logger.info('CloudImage', `Login: ${normalizedUsername} / ${normalizedPassword}`);
  logger.info('CloudImage', 'Cloud-init will configure the OS on first boot (~30 seconds).');

  return result;
}

module.exports = {
  CLOUD_IMAGE_REGISTRY,
  VERSION_TO_CODENAME,
  getCloudImageInfo,
  isCloudImageAvailable,
  downloadCloudImage,
  prepareCloudDisk,
  createVMFromCloudImage,
};
