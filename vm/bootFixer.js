const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../core/logger');
const { getAppDataPath } = require('../core/config');
const virtualbox = require('../adapters/virtualbox');

function _detectVBoxDriverState() {
  const candidates = ['vboxsup', 'vboxdrv'];
  const stopped = [];
  const unknownErrors = [];

  for (const serviceName of candidates) {
    try {
      const output = String(execSync(`sc.exe query ${serviceName}`, { encoding: 'utf8', timeout: 5000 }) || '');
      if (/RUNNING/i.test(output)) {
        return { state: 'running', serviceName };
      }
      if (/STOPPED/i.test(output)) {
        stopped.push(serviceName);
      }
    } catch (err) {
      const details = [
        String(err?.stdout || ''),
        String(err?.stderr || ''),
        String(err?.message || '')
      ].join('\n');
      if (/1060|does not exist/i.test(details)) continue;
      unknownErrors.push(`${serviceName}: ${details || err.message}`);
    }
  }

  if (stopped.length > 0) return { state: 'stopped', serviceName: stopped[0] };
  if (unknownErrors.length > 0) return { state: 'unknown', serviceName: '', details: unknownErrors[0] };
  return { state: 'not-installed', serviceName: '' };
}

function _asBool(value) {
  if (typeof value === 'boolean') return value;
  return String(value || '').toLowerCase() === 'on';
}

function _normalizeMediaPath(value) {
  return String(value || '').replace(/^"+|"+$/g, '').trim();
}

function _resolveMediaPath(mediaPath, vmBaseDir) {
  const normalized = _normalizeMediaPath(mediaPath);
  if (!normalized) return '';
  if (path.isAbsolute(normalized)) return normalized;
  return vmBaseDir ? path.join(vmBaseDir, normalized) : normalized;
}

function _readSetupState() {
  try {
    const statePath = path.join(getAppDataPath(), 'setup-state.json');
    if (!fs.existsSync(statePath)) return null;
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function _getPendingInstallState(vmName) {
  const state = _readSetupState();
  if (!state?.config || !state?.phases) return null;
  if (String(state.config.vmName || '').trim() !== String(vmName || '').trim()) return null;

  const installStarted = String(state.phases.install_os || '').toLowerCase() === 'complete';
  const setupFinished = String(state.phases.complete || '').toLowerCase() === 'complete';
  const waitBootDone = String(state.phases.wait_boot || '').toLowerCase() === 'complete';

  if (!installStarted || setupFinished || waitBootDone) return null;
  return {
    isoPath: String(state.artifacts?.isoPath || '').trim()
  };
}

async function diagnoseBootIssues(vmName) {
  const diagnostics = [];
  const info = await virtualbox.getVMInfo(vmName);

  const firmware = (info.firmware || '').toLowerCase();
  const osType = (info.ostype || '').toLowerCase();
  const vmState = info.VMState || 'unknown';

  diagnostics.push({
    key: 'state',
    status: vmState === 'running' ? 'warn' : 'ok',
    message: vmState === 'running' ? 'V Os is already running' : `V Os state: ${vmState}`
  });

  const hasStorageController = Object.keys(info).some((k) => k.startsWith('storagecontrollername'));
  diagnostics.push({
    key: 'storageController',
    status: hasStorageController ? 'ok' : 'fail',
    message: hasStorageController ? 'Storage controller detected' : 'No storage controller configured'
  });

  const mediaValues = Object.values(info)
    .filter((v) => typeof v === 'string')
    .map((v) => _normalizeMediaPath(v));

  const cfgFile = _normalizeMediaPath(info.CfgFile || '');
  const vmBaseDir = cfgFile ? path.dirname(cfgFile) : '';

  const diskPaths = mediaValues.filter((v) => /\.(vdi|vmdk|vhd|qcow2)$/i.test(v));
  const isoPaths = mediaValues.filter((v) => /\.(iso|viso)$/i.test(v));
  const existingDiskPaths = diskPaths.filter((diskPath) => {
    try { return fs.existsSync(_resolveMediaPath(diskPath, vmBaseDir)); } catch { return false; }
  });
  const existingIsoPaths = isoPaths.filter((isoPath) => {
    try { return fs.existsSync(_resolveMediaPath(isoPath, vmBaseDir)); } catch { return false; }
  });
  const hasDiskAttachment = diskPaths.length > 0;

  diagnostics.push({
    key: 'diskAttachment',
    status: hasDiskAttachment ? 'ok' : 'warn',
    message: hasDiskAttachment ? 'Disk attachment detected' : 'No disk attachment found in V Os config'
  });

  diagnostics.push({
    key: 'diskPathHealth',
    status: !hasDiskAttachment ? 'warn' : (existingDiskPaths.length > 0 ? 'ok' : 'fail'),
    message: !hasDiskAttachment
      ? 'Disk path health skipped (no disk attachment)'
      : (existingDiskPaths.length > 0 ? 'Attached disk file exists on host' : 'Attached disk path is missing on host')
  });

  diagnostics.push({
    key: 'isoAttachment',
    status: isoPaths.length > 0 ? (existingIsoPaths.length > 0 ? 'ok' : 'warn') : 'warn',
    message: isoPaths.length > 0
      ? (existingIsoPaths.length > 0 ? 'ISO attachment exists' : 'ISO is attached but file is missing on host')
      : 'No ISO attachment found'
  });

  const windows11 = osType.includes('windows11');
  if (windows11) {
    diagnostics.push({
      key: 'efiMode',
      status: firmware === 'efi' ? 'ok' : 'warn',
      message: firmware === 'efi' ? 'EFI enabled for Windows 11' : 'Windows 11 usually requires EFI firmware'
    });
  }

  diagnostics.push({
    key: 'bootOrder',
    status: info.boot1 ? 'ok' : 'warn',
    message: info.boot1 ? `Boot order starts with ${info.boot1}` : 'Boot order not explicitly configured'
  });

  if (process.platform === 'win32') {
    const driver = _detectVBoxDriverState();
    diagnostics.push({
      key: 'vboxsup',
      status: driver.state === 'running' ? 'ok' : 'warn',
      serviceName: driver.serviceName || '',
      message:
        driver.state === 'running'
          ? `${String(driver.serviceName || 'vboxsup').toUpperCase()} driver is running`
          : driver.state === 'stopped'
            ? `${String(driver.serviceName || 'vboxsup').toUpperCase()} driver is installed and stopped (normal when no VM is active)`
            : driver.state === 'not-installed'
              ? 'VirtualBox kernel driver service is not installed. Reinstall VirtualBox as administrator.'
              : `Could not verify VirtualBox driver service: ${driver.details || 'unknown error'}`
    });
  }

  return {
    vmName,
    diagnostics,
    info,
    diskPaths,
    existingDiskPaths,
    isoPaths,
    existingIsoPaths
  };
}

async function prebootValidateAndFix(vmName) {
  logger.info('BootFixer', `Running pre-boot validation for "${vmName}"`);
  const { diagnostics, info, existingDiskPaths, existingIsoPaths } = await diagnoseBootIssues(vmName);
  const fixesApplied = [];
  const pendingInstallState = _getPendingInstallState(vmName);

  if (process.platform === 'win32') {
    const vboxSupDiag = diagnostics.find((d) => d.key === 'vboxsup');
    const canAttemptStart = vboxSupDiag
      && vboxSupDiag.status !== 'ok'
      && !/not installed/i.test(String(vboxSupDiag.message || ''));
    if (canAttemptStart) {
      const serviceName = String(vboxSupDiag.serviceName || 'vboxsup');
      try {
        execSync(`sc.exe start ${serviceName}`, { timeout: 10000 });
        fixesApplied.push(`Started ${serviceName.toUpperCase()} driver`);
      } catch (err) {
        logger.warn('BootFixer', `Could not auto-start ${serviceName.toUpperCase()}: ${err.message}`);
      }
    }
  }

  const hasStorageController = diagnostics.find((d) => d.key === 'storageController')?.status === 'ok';
  if (!hasStorageController) {
    await virtualbox.addStorageController(vmName, 'SATA Controller', 'sata');
    fixesApplied.push('Added missing SATA Controller');
  }

  const windows11NeedsEfi = (info.ostype || '').toLowerCase().includes('windows11') && (info.firmware || '').toLowerCase() !== 'efi';
  if (windows11NeedsEfi) {
    await virtualbox._run(['modifyvm', vmName, '--firmware', 'efi']);
    fixesApplied.push('Enabled EFI firmware for Windows 11 compatibility');
  }

  const boot1 = (info.boot1 || '').toLowerCase();
  if (!boot1 || boot1 === 'none') {
    await virtualbox._run([
      'modifyvm', vmName,
      '--boot1', 'disk',
      '--boot2', 'dvd',
      '--boot3', 'none',
      '--boot4', 'none'
    ]);
    fixesApplied.push('Repaired boot order (disk -> dvd)');
  }

  const hasBootableDisk = existingDiskPaths.length > 0;
  let hasBootableIso = existingIsoPaths.length > 0;

  if (pendingInstallState) {
    const osType = String(info.ostype || '').toLowerCase();
    const graphicsController = String(info.graphicscontroller || '').toLowerCase();
    if ((osType.includes('ubuntu') || osType.includes('debian') || osType.includes('linux'))
      && graphicsController === 'vmsvga') {
      await virtualbox._run([
        'modifyvm', vmName,
        '--graphicscontroller', 'vboxsvga',
        '--vram', '128',
        '--accelerate3d', 'off'
      ]);
      fixesApplied.push('Switched display controller to VBoxSVGA safe mode for interrupted Linux install recovery');
    }

    if (!hasBootableIso && pendingInstallState.isoPath && fs.existsSync(pendingInstallState.isoPath)) {
      const controllerNames = Object.keys(info)
        .filter((key) => /^storagecontrollername\d+$/i.test(key))
        .map((key) => String(info[key] || '').trim())
        .filter(Boolean);

      let targetController = controllerNames.find((name) => /ide/i.test(name)) || controllerNames[0] || 'IDE Controller';
      try {
        if (!controllerNames.includes(targetController) && /ide/i.test(targetController)) {
          await virtualbox.addStorageController(vmName, targetController, 'ide');
        }
        await virtualbox.attachStorage(vmName, targetController, 0, 0, 'dvddrive', pendingInstallState.isoPath);
        hasBootableIso = true;
        fixesApplied.push('Re-attached installer ISO to resume interrupted unattended installation');
      } catch (attachErr) {
        logger.warn('BootFixer', `Could not re-attach installer ISO: ${attachErr.message}`);
      }
    }

    await virtualbox._run([
      'modifyvm', vmName,
      '--boot1', 'dvd',
      '--boot2', 'disk',
      '--boot3', 'none',
      '--boot4', 'none'
    ]);
    fixesApplied.push('Detected interrupted setup and switched boot priority to DVD first for recovery');
  }

  if (!hasBootableDisk && !hasBootableIso) {
    throw new Error(
      'No bootable media found. Attached disk/ISO file is missing or inaccessible. ' +
      'Re-attach a valid disk/ISO in V Os Settings > Storage before starting.'
    );
  }

  if (boot1 === 'dvd' && !hasBootableIso && hasBootableDisk) {
    await virtualbox._run([
      'modifyvm', vmName,
      '--boot1', 'disk',
      '--boot2', 'dvd',
      '--boot3', 'none',
      '--boot4', 'none'
    ]);
    fixesApplied.push('Prioritized disk boot because no valid ISO media was attached');
  }

  const accel3d = _asBool(info.accelerate3d);
  if (accel3d && (info.graphicscontroller || '').toLowerCase() === 'vmsvga') {
    await virtualbox._run(['modifyvm', vmName, '--accelerate3d', 'off']);
    fixesApplied.push('Disabled 3D acceleration for VMSVGA stability');
  }

  return {
    success: true,
    vmName,
    diagnostics,
    fixesApplied,
    fixed: fixesApplied.length > 0
  };
}

module.exports = {
  diagnoseBootIssues,
  prebootValidateAndFix
};
