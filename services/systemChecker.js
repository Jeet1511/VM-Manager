/**
 * services/systemChecker.js — System Requirements Validator
 * 
 * Design Decision: Runs all checks and returns a structured report.
 * The UI shows every check result to the user — full transparency.
 * Doesn't just pass/fail — explains WHY and WHAT TO DO if something fails.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const platform = require('../adapters/platform');
const virtualbox = require('../adapters/virtualbox');
const logger = require('../core/logger');
const { SYSTEM_REQUIREMENTS } = require('../core/config');

function resolvePreferredVBoxManagePath(rawPath = '') {
  const candidate = String(rawPath || '').trim().replace(/^"(.*)"$/, '$1').trim();
  if (!candidate) return '';

  const asFile = (() => {
    try {
      if (!fs.existsSync(candidate)) return '';
      return fs.statSync(candidate).isFile() ? candidate : '';
    } catch {
      return '';
    }
  })();
  if (asFile) return asFile;

  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      const exeName = process.platform === 'win32' ? 'VBoxManage.exe' : 'VBoxManage';
      const sibling = path.join(candidate, exeName);
      if (fs.existsSync(sibling) && fs.statSync(sibling).isFile()) return sibling;
    }
  } catch {}

  if (process.platform === 'win32' && candidate.toLowerCase().endsWith('virtualbox.exe')) {
    try {
      const sibling = path.join(path.dirname(candidate), 'VBoxManage.exe');
      if (fs.existsSync(sibling) && fs.statSync(sibling).isFile()) return sibling;
    } catch {}
  }

  return '';
}

function probeVirtualBoxRuntime(vboxPath = '') {
  const executable = String(vboxPath || '').trim();
  if (!executable) {
    return { ok: false, code: 'missing-vboxmanage', message: 'VirtualBox runtime probe skipped: VBoxManage path missing.' };
  }

  const probes = [
    ['list', 'hostinfo'],
    ['list', 'systemproperties']
  ];

  let lastDetails = '';
  for (const args of probes) {
    try {
      execFileSync(executable, args, {
        timeout: 10000,
        windowsHide: true,
        stdio: 'pipe'
      });

      // VBoxManage CLI commands succeed without the kernel driver.
      // On Windows, also verify the kernel driver is actually loadable.
      if (process.platform === 'win32') {
        const driverState = detectVBoxDriverServiceState();
        if (driverState.state === 'stopped') {
          // Try to start it to verify it can load
          const startResult = tryStartVBoxDriverService(driverState.serviceName || 'vboxsup');
          if (startResult.success) {
            // Re-verify it's running
            const recheck = detectVBoxDriverServiceState();
            if (recheck.state !== 'running') {
              return {
                ok: false,
                code: 'driver-runtime',
                message: 'VirtualBox kernel driver was started but did not reach running state. Reboot or reinstall VirtualBox.'
              };
            }
          } else {
            // Check if it's a permissions issue
            const errorMsg = String(startResult.message || '').toLowerCase();
            if (/access is denied|error 5/i.test(errorMsg)) {
              return {
                ok: false,
                code: 'driver-runtime',
                message: 'VirtualBox kernel driver is stopped and needs administrator privileges to start. Use admin mode or reboot.'
              };
            }
            return {
              ok: false,
              code: 'driver-runtime',
              message: `VirtualBox kernel driver could not be started: ${startResult.message}. Reboot or reinstall VirtualBox.`
            };
          }
        } else if (driverState.state === 'not-installed') {
          return {
            ok: false,
            code: 'driver-runtime',
            message: 'VirtualBox kernel driver service is not installed. Reinstall VirtualBox as administrator.'
          };
        }
      }

      return { ok: true, code: 'ok', message: 'VirtualBox runtime is responsive.' };
    } catch (err) {
      const details = [
        String(err?.stdout || ''),
        String(err?.stderr || ''),
        String(err?.message || '')
      ].join('\n').trim();
      if (details) {
        lastDetails = details;
      }
      if (/vboxdrvstub|supr3hardenedwinrespawn|verr_open_failed|status_object_name_not_found/i.test(details)) {
        return {
          ok: false,
          code: 'driver-runtime',
          message: 'VirtualBox kernel driver is not available (VBoxDrv/VBoxSup). Reboot the host, then repair/reinstall VirtualBox as administrator.'
        };
      }
    }
  }

  return {
    ok: false,
    code: 'runtime-probe-warning',
    message: lastDetails ? `VirtualBox runtime probe warning: ${lastDetails}` : 'VirtualBox runtime probe warning.'
  };
}

function detectVBoxDriverServiceState() {
  if (process.platform !== 'win32') {
    return { state: 'unsupported', serviceName: '' };
  }

  const candidates = ['vboxsup', 'vboxdrv'];
  const stopped = [];
  for (const serviceName of candidates) {
    try {
      const output = String(execSync(`sc.exe query ${serviceName}`, { encoding: 'utf8', timeout: 5000 }) || '');
      if (/RUNNING/i.test(output)) return { state: 'running', serviceName };
      if (/STOPPED/i.test(output)) stopped.push(serviceName);
    } catch (err) {
      const details = [
        String(err?.stdout || ''),
        String(err?.stderr || ''),
        String(err?.message || '')
      ].join('\n');
      if (/1060|does not exist/i.test(details)) continue;
      return { state: 'unknown', serviceName: '', details };
    }
  }

  if (stopped.length > 0) return { state: 'stopped', serviceName: stopped[0] };
  return { state: 'not-installed', serviceName: '' };
}

function tryStartVBoxDriverService(preferred = '') {
  if (process.platform !== 'win32') return { success: false, message: 'Unsupported platform' };
  const candidates = Array.from(new Set(
    [String(preferred || '').trim().toLowerCase(), 'vboxsup', 'vboxdrv'].filter(Boolean)
  ));
  for (const serviceName of candidates) {
    try {
      execSync(`sc.exe start ${serviceName}`, { timeout: 10000, stdio: 'pipe' });
      return { success: true, serviceName, message: `${serviceName.toUpperCase()} driver start requested.` };
    } catch (err) {
      const details = [
        String(err?.stdout || ''),
        String(err?.stderr || ''),
        String(err?.message || '')
      ].join('\n');
      if (/1056|already running|service has already been started/i.test(details)) {
        return { success: true, serviceName, message: `${serviceName.toUpperCase()} is already running.` };
      }
      if (/1060|does not exist|access is denied|5/i.test(details)) {
        continue;
      }
    }
  }
  return { success: false, message: 'Could not start VirtualBox kernel driver service.' };
}

/**
 * Run all system checks and return a detailed report.
 * Each check has: name, status (pass/warn/fail), message, and value.
 * 
 * @param {string} [targetPath] - Installation path to check disk space for
 * @returns {Promise<object>} Structured system report
 */
async function runSystemCheck(targetPath = null, options = {}) {
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
  const preferredVBoxPath = resolvePreferredVBoxManagePath(
    options?.preferredVBoxPath
    || virtualbox?.vboxManagePath
    || virtualbox?.preferredManagePath
    || ''
  );
  const vboxPath = preferredVBoxPath || await platform.findVBoxManage();
  let runtimeProbe = vboxPath ? probeVirtualBoxRuntime(vboxPath) : { ok: true, code: 'ok', message: '' };

  if (vboxPath && !runtimeProbe.ok && runtimeProbe.code === 'driver-runtime' && process.platform === 'win32') {
    const serviceState = detectVBoxDriverServiceState();
    if (serviceState.state === 'stopped' || serviceState.state === 'running') {
      const startResult = tryStartVBoxDriverService(serviceState.serviceName || 'vboxsup');
      if (startResult.success) {
        runtimeProbe = probeVirtualBoxRuntime(vboxPath);
      }
    }
  }

  const runtimeStatus = !vboxPath
    ? 'info'
    : runtimeProbe.ok
      ? 'pass'
      : (runtimeProbe.code === 'driver-runtime' ? 'fail' : 'warn');

  const vboxCheck = {
    name: 'VirtualBox',
    value: vboxPath ? 'Installed' : 'Not installed',
    status: runtimeStatus,
    message: vboxPath
      ? (runtimeProbe.ok ? `VirtualBox found at: ${vboxPath}` : runtimeProbe.message)
      : 'VirtualBox is not installed. It will be downloaded and installed automatically.',
    vboxPath
  };

  if (vboxPath && vboxCheck.status === 'fail') {
    overallPass = false;
  }

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
