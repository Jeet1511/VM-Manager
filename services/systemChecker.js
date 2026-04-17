/**
 * services/systemChecker.js — System Requirements Validator
 * 
 * Design Decision: Runs all checks and returns a structured report.
 * The UI shows every check result to the user — full transparency.
 * Doesn't just pass/fail — explains WHY and WHAT TO DO if something fails.
 */

const os = require('os');
const platform = require('../adapters/platform');
const logger = require('../core/logger');
const { SYSTEM_REQUIREMENTS } = require('../core/config');

/**
 * Run all system checks and return a detailed report.
 * Each check has: name, status (pass/warn/fail), message, and value.
 * 
 * @param {string} [targetPath] - Installation path to check disk space for
 * @returns {Promise<object>} Structured system report
 */
async function runSystemCheck(targetPath = null) {
  logger.info('SystemCheck', '═══ Starting System Requirements Check ═══');

  const checks = [];
  let overallPass = true;

  // ─── Check 1: Operating System ────────────────────────────────────
  const sysInfo = platform.getSystemInfo();
  const osCheck = {
    name: 'Operating System',
    value: `${sysInfo.os} (${sysInfo.osVersion}) — ${sysInfo.arch}`,
    status: 'pass',
    message: `Detected ${sysInfo.os} ${sysInfo.arch}`
  };

  if (sysInfo.os === 'unknown') {
    osCheck.status = 'fail';
    osCheck.message = 'Unsupported operating system. This app requires Windows or Linux.';
    overallPass = false;
  } else if (sysInfo.arch !== 'x64' && SYSTEM_REQUIREMENTS.requires64Bit) {
    osCheck.status = 'fail';
    osCheck.message = '64-bit operating system required. Your system is 32-bit.';
    overallPass = false;
  }

  checks.push(osCheck);
  logger.info('SystemCheck', `OS: ${osCheck.value} — ${osCheck.status.toUpperCase()}`);

  // ─── Check 2: CPU ─────────────────────────────────────────────────
  const cpuCheck = {
    name: 'CPU Cores',
    value: `${sysInfo.cpuCount} cores (${sysInfo.cpuModel})`,
    status: sysInfo.cpuCount >= SYSTEM_REQUIREMENTS.minCPUs ? 'pass' : 'warn',
    message: sysInfo.cpuCount >= SYSTEM_REQUIREMENTS.minCPUs
      ? `${sysInfo.cpuCount} cores available (minimum: ${SYSTEM_REQUIREMENTS.minCPUs})`
      : `Only ${sysInfo.cpuCount} core(s) detected. Minimum ${SYSTEM_REQUIREMENTS.minCPUs} recommended for smooth VM operation.`
  };

  checks.push(cpuCheck);
  logger.info('SystemCheck', `CPU: ${cpuCheck.value} — ${cpuCheck.status.toUpperCase()}`);

  // ─── Check 3: RAM ─────────────────────────────────────────────────
  const ramCheck = {
    name: 'System RAM',
    value: `${sysInfo.totalRAM} GB total, ${sysInfo.freeRAM} GB free`,
    status: 'pass',
    message: ''
  };

  if (sysInfo.totalRAM < SYSTEM_REQUIREMENTS.minRAM) {
    ramCheck.status = 'fail';
    ramCheck.message = `Insufficient RAM. You have ${sysInfo.totalRAM} GB but ${SYSTEM_REQUIREMENTS.minRAM} GB minimum is required.`;
    overallPass = false;
  } else if (sysInfo.freeRAM < 2) {
    ramCheck.status = 'warn';
    ramCheck.message = `Low free RAM (${sysInfo.freeRAM} GB). Close some applications before starting VM setup.`;
  } else {
    ramCheck.message = `${sysInfo.totalRAM} GB total RAM — sufficient for VM operation.`;
  }

  checks.push(ramCheck);
  logger.info('SystemCheck', `RAM: ${ramCheck.value} — ${ramCheck.status.toUpperCase()}`);

  // ─── Check 4: Virtualization ──────────────────────────────────────
  const virtResult = await platform.checkVirtualizationEnabled();
  const virtCheck = {
    name: 'CPU Virtualization (VT-x / AMD-V)',
    value: virtResult.technology || 'Unknown',
    status: 'pass',
    message: ''
  };

  if (virtResult.enabled === false) {
    virtCheck.status = 'fail';
    virtCheck.message = virtResult.error || 'Virtualization is disabled. Enable VT-x/AMD-V in BIOS.';
    overallPass = false;
  } else if (virtResult.enabled === null) {
    virtCheck.status = 'warn';
    virtCheck.message = virtResult.warning || 'Could not detect virtualization status.';
  } else if (virtResult.warning) {
    virtCheck.status = 'warn';
    virtCheck.message = virtResult.warning;
  } else {
    virtCheck.message = 'CPU virtualization is enabled and ready.';
  }

  checks.push(virtCheck);
  logger.info('SystemCheck', `Virtualization: ${virtCheck.value} — ${virtCheck.status.toUpperCase()}`);

  // ─── Check 5: Disk Space ──────────────────────────────────────────
  if (targetPath) {
    const freeGB = await platform.getDiskSpace(targetPath);
    const diskCheck = {
      name: 'Disk Space',
      value: freeGB !== null ? `${freeGB} GB free` : 'Unknown',
      status: 'pass',
      message: ''
    };

    if (freeGB !== null) {
      if (freeGB < SYSTEM_REQUIREMENTS.minDisk) {
        diskCheck.status = 'fail';
        diskCheck.message = `Insufficient disk space. ${freeGB} GB free, but ${SYSTEM_REQUIREMENTS.minDisk} GB required.`;
        overallPass = false;
      } else {
        diskCheck.message = `${freeGB} GB free — sufficient for VM installation.`;
      }
    } else {
      diskCheck.status = 'warn';
      diskCheck.message = 'Could not determine free disk space. Ensure at least 30 GB is available.';
    }

    checks.push(diskCheck);
    logger.info('SystemCheck', `Disk: ${diskCheck.value} — ${diskCheck.status.toUpperCase()}`);
  }

  // ─── Check 6: VirtualBox Installation ─────────────────────────────
  const vboxPath = await platform.findVBoxManage();
  const vboxCheck = {
    name: 'VirtualBox',
    value: vboxPath ? 'Installed' : 'Not installed',
    status: vboxPath ? 'pass' : 'info',
    message: vboxPath
      ? `VirtualBox found at: ${vboxPath}`
      : 'VirtualBox is not installed. It will be downloaded and installed automatically.',
    vboxPath
  };

  checks.push(vboxCheck);
  logger.info('SystemCheck', `VirtualBox: ${vboxCheck.value} — ${vboxCheck.status.toUpperCase()}`);

  // ─── Summary ──────────────────────────────────────────────────────
  const report = {
    checks,
    overallPass,
    systemInfo: sysInfo,
    vboxInstalled: !!vboxPath,
    vboxPath,
    timestamp: new Date().toISOString()
  };

  if (overallPass) {
    logger.success('SystemCheck', '═══ System check PASSED — Ready to proceed ═══');
  } else {
    logger.error('SystemCheck', '═══ System check FAILED — See details above ═══');
  }

  return report;
}

module.exports = { runSystemCheck };
