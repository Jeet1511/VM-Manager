const { execSync } = require('child_process');
const logger = require('../core/logger');
const virtualbox = require('../adapters/virtualbox');

function _asBool(value) {
  if (typeof value === 'boolean') return value;
  return String(value || '').toLowerCase() === 'on';
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
    message: vmState === 'running' ? 'VM is already running' : `VM state: ${vmState}`
  });

  const hasStorageController = Object.keys(info).some((k) => k.startsWith('storagecontrollername'));
  diagnostics.push({
    key: 'storageController',
    status: hasStorageController ? 'ok' : 'fail',
    message: hasStorageController ? 'Storage controller detected' : 'No storage controller configured'
  });

  const hasDiskAttachment = Object.values(info).some((v) =>
    typeof v === 'string' && /\.vdi|\.vmdk|\.vhd|\.qcow2/i.test(v)
  );
  diagnostics.push({
    key: 'diskAttachment',
    status: hasDiskAttachment ? 'ok' : 'warn',
    message: hasDiskAttachment ? 'Disk attachment detected' : 'No disk attachment found in machine config'
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
    try {
      const svcResult = execSync('sc.exe query vboxsup', { encoding: 'utf8', timeout: 5000 });
      diagnostics.push({
        key: 'vboxsup',
        status: svcResult.includes('RUNNING') ? 'ok' : 'fail',
        message: svcResult.includes('RUNNING') ? 'VBoxSup driver is running' : 'VBoxSup driver is not running'
      });
    } catch (err) {
      diagnostics.push({
        key: 'vboxsup',
        status: 'warn',
        message: `Could not verify VBoxSup driver: ${err.message}`
      });
    }
  }

  return { vmName, diagnostics, info };
}

async function prebootValidateAndFix(vmName) {
  logger.info('BootFixer', `Running pre-boot validation for "${vmName}"`);
  const { diagnostics, info } = await diagnoseBootIssues(vmName);
  const fixesApplied = [];

  if (process.platform === 'win32') {
    const vboxSupDiag = diagnostics.find((d) => d.key === 'vboxsup' && d.status === 'fail');
    if (vboxSupDiag) {
      try {
        execSync('sc.exe start vboxsup', { timeout: 10000 });
        fixesApplied.push('Started VBoxSup driver');
      } catch (err) {
        logger.warn('BootFixer', `Could not auto-start VBoxSup: ${err.message}`);
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

  const accel3d = _asBool(info.accelerate3d);
  if (!accel3d && (info.graphicscontroller || '').toLowerCase() === 'vmsvga') {
    await virtualbox._run(['modifyvm', vmName, '--accelerate3d', 'on']);
    fixesApplied.push('Enabled 3D acceleration for VMSVGA');
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
