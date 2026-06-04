/**
 * vm/deferredGuestSetup.js — Post-Install Guest Configuration (File-Based)
 * 
 * This module applies all user settings AFTER the OS is installed, using
 * VBoxManage guestcontrol shell commands. No keyboard/mouse automation.
 * 
 * It runs automatically on vm:start when GuestConfigPending=on.
 * 
 * Strategy:
 *   1. Wait for Guest Additions to become responsive (polls via guestcontrol)
 *   2. Delegate to configureGuestInside() for the heavy lifting (GA packages,
 *      VBoxClient services, shared folders, display, etc.)
 *   3. Apply auto-login config (detects gdm3/gdm/lightdm)
 *   4. Mark VM as fully configured
 * 
 * All settings are written via config files inside the guest OS.
 * No timing-dependent virtual keyboard/mouse interaction.
 */

const logger = require('../core/logger');
const virtualbox = require('../adapters/virtualbox');
const { configureGuestInside } = require('./guestAdditions');

const POLL_INTERVAL_MS = 15000;  // Check every 15s
const MAX_WAIT_GA_MS = 600000;   // Wait up to 10 min for Guest Additions
const CMD_TIMEOUT_MS = 120000;   // Timeout per shell command

/**
 * Build a sudo command prefix that pipes the password via stdin.
 */
function sudoCmd(password) {
  const escaped = String(password ?? '').replace(/'/g, `'"'"'`);
  return `printf '%s\\n' '${escaped}' | sudo -S --`;
}

/**
 * Wait for Guest Additions to become responsive inside the VM.
 * Polls every POLL_INTERVAL_MS until guestcontrol works or timeout.
 * Returns true if GA are responsive, false if timed out.
 */
async function waitForGuestAdditionsReady(vmName, username, password) {
  const startTime = Date.now();
  logger.info('DeferredSetup', `Waiting for Guest Additions in "${vmName}" (up to ${MAX_WAIT_GA_MS / 60000} min)...`);

  while (Date.now() - startTime < MAX_WAIT_GA_MS) {
    try {
      // Try a simple command — if guestcontrol works, GA are ready
      const out = await virtualbox.guestShell(vmName, username, password, 'echo vmxposed-ready', {
        timeout: 20000,
        ignoreErrors: false
      });
      if (String(out || '').includes('vmxposed-ready')) {
        logger.success('DeferredSetup', 'Guest Additions are responsive.');
        return true;
      }
    } catch {
      // GA not ready yet — wait and retry
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  logger.warn('DeferredSetup', 'Timed out waiting for Guest Additions.');
  return false;
}

/**
 * Configure auto-login for the guest OS.
 * Detects which display manager is installed (gdm3, gdm, or lightdm)
 * and writes the correct config file. All file-based, no keyboard needed.
 */
async function configureAutoLogin(vmName, username, password) {
  const sudo = sudoCmd(password);
  logger.info('DeferredSetup', 'Configuring auto-login...');

  try {
    const script = `${sudo} bash -c '` +
      // GDM3 (Ubuntu 18.04+)
      `if [ -d /etc/gdm3 ]; then ` +
      `  mkdir -p /etc/gdm3; ` +
      `  printf "[daemon]\\nAutomaticLoginEnable=true\\nAutomaticLogin=${username}\\n" > /etc/gdm3/custom.conf; ` +
      `  echo "auto-login: gdm3"; ` +
      // GDM (older Ubuntu)
      `elif [ -d /etc/gdm ]; then ` +
      `  mkdir -p /etc/gdm; ` +
      `  printf "[daemon]\\nAutomaticLoginEnable=true\\nAutomaticLogin=${username}\\n" > /etc/gdm/custom.conf; ` +
      `  echo "auto-login: gdm"; ` +
      `fi; ` +
      // LightDM (Lubuntu, Xubuntu, etc.)
      `if dpkg -l lightdm 2>/dev/null | grep -q "^ii"; then ` +
      `  mkdir -p /etc/lightdm/lightdm.conf.d; ` +
      `  printf "[Seat:*]\\nautologin-user=${username}\\n" > /etc/lightdm/lightdm.conf.d/50-vmxposed-autologin.conf; ` +
      `  echo "auto-login: lightdm"; ` +
      `fi'`;

    const output = await virtualbox.guestShell(vmName, username, password, script, {
      timeout: CMD_TIMEOUT_MS,
      ignoreErrors: false
    });
    logger.success('DeferredSetup', `Auto-login configured: ${String(output || '').trim()}`);
    return true;
  } catch (err) {
    logger.warn('DeferredSetup', `Auto-login config warning: ${err.message}`);
    return false;
  }
}

/**
 * Disable Wayland — VBox clipboard/drag-drop work better on Xorg.
 * Writes to gdm3 config file if present.
 */
async function disableWayland(vmName, username, password) {
  const sudo = sudoCmd(password);
  try {
    await virtualbox.guestShell(vmName, username, password,
      `${sudo} bash -c '` +
      `if [ -f /etc/gdm3/custom.conf ]; then ` +
      `  sed -i "s/^#\\?WaylandEnable=.*/WaylandEnable=false/" /etc/gdm3/custom.conf 2>/dev/null; ` +
      `  grep -q "^WaylandEnable=false" /etc/gdm3/custom.conf || ` +
      `    printf "\\n[daemon]\\nWaylandEnable=false\\n" >> /etc/gdm3/custom.conf; ` +
      `fi; echo wayland-done'`,
      { timeout: 30000, ignoreErrors: false }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the full deferred guest setup pipeline:
 * 1. Wait for Guest Additions to be responsive
 * 2. Run configureGuestInside() (GA packages, VBoxClient, shared folders, display)
 * 3. Apply auto-login for the correct display manager
 * 4. Disable Wayland for better VBox compatibility
 * 5. Mark setup as complete
 * 
 * This is designed to be called from the vm:start handler.
 * It runs asynchronously and does not block the UI.
 * 
 * @param {string} vmName - VM name
 * @param {object} [options] - Options
 * @returns {Promise<object>} Result
 */
async function runDeferredSetup(vmName, options = {}) {
  const {
    onProgress = null,
    configureSharedFolder = false,
    sharedFolderName = 'shared'
  } = options;

  // Read stored credentials from VM extradata
  let username = 'guest';
  let password = 'guest';
  try {
    const usernameOut = await virtualbox._run(['getextradata', vmName, 'VMXposed/GuestUsername']);
    const usernameMatch = String(usernameOut || '').match(/Value:\s*(.+)/i);
    if (usernameMatch && usernameMatch[1] && usernameMatch[1].trim() !== 'No value set!') {
      username = usernameMatch[1].trim();
    }
  } catch {}
  try {
    const passwordOut = await virtualbox._run(['getextradata', vmName, 'VMXposed/GuestPassword']);
    const passwordMatch = String(passwordOut || '').match(/Value:\s*(.+)/i);
    if (passwordMatch && passwordMatch[1] && passwordMatch[1].trim() !== 'No value set!') {
      password = passwordMatch[1].trim();
    }
  } catch {}

  // Check if shared folder is configured on this VM
  let hasSharedFolder = configureSharedFolder;
  if (!hasSharedFolder) {
    try {
      const info = await virtualbox.getVMInfo(vmName, { quiet: true });
      const infoStr = JSON.stringify(info || {});
      hasSharedFolder = infoStr.includes('SharedFolderName');
    } catch {}
  }

  logger.info('DeferredSetup', `═══ Starting Deferred Guest Setup for "${vmName}" ═══`);
  logger.info('DeferredSetup', `Username: ${username}, SharedFolder: ${hasSharedFolder}`);

  // Step 1: Wait for GA to be responsive
  const gaReady = await waitForGuestAdditionsReady(vmName, username, password);
  if (!gaReady) {
    logger.warn('DeferredSetup', 'Guest Additions not responsive — will retry on next start.');
    return { success: false, error: 'Guest Additions not responsive', willRetry: true };
  }

  // Step 2: Run the full in-guest configuration (GA packages, VBoxClient, shared folders, etc.)
  // This is the same thorough setup that runs during the orchestrator's guest_config phase
  let guestResult = null;
  try {
    guestResult = await configureGuestInside(
      vmName,
      username,
      password,
      onProgress,
      {
        configureSharedFolder: hasSharedFolder,
        sharedFolderName
      }
    );
    logger.success('DeferredSetup', 'configureGuestInside completed successfully.');
  } catch (guestErr) {
    logger.warn('DeferredSetup', `configureGuestInside failed: ${guestErr.message}`);
    // Continue with auto-login setup even if some guest steps failed
    guestResult = { guestAdditionsInstalled: false };
  }

  // Step 3: Configure auto-login (detects gdm3/gdm/lightdm)
  await configureAutoLogin(vmName, username, password);

  // Step 4: Disable Wayland
  await disableWayland(vmName, username, password);

  // Step 5: Mark as complete
  const success = !!(guestResult && guestResult.guestAdditionsInstalled);
  if (success) {
    try {
      await virtualbox._run(['setextradata', vmName, 'VMXposed/GuestConfigPending', 'off']);
      await virtualbox._run(['setextradata', vmName, 'VMXposed/InstallPhase', 'ready']);
      await virtualbox._run(['setextradata', vmName, 'VMXposed/InstalledDiskReady', 'on']);
      logger.success('DeferredSetup', '═══ VM fully configured — all features active ═══');
    } catch (err) {
      logger.warn('DeferredSetup', `Could not update markers: ${err.message}`);
    }
  } else {
    // Partial success — keep GuestConfigPending=on so we retry on next start
    logger.warn('DeferredSetup', 'Guest setup partially complete. Will retry remaining steps on next start.');
  }

  return {
    success,
    guestResult,
    autoLoginConfigured: true,
    willRetry: !success
  };
}

module.exports = {
  runDeferredSetup,
  waitForGuestAdditionsReady,
  configureAutoLogin,
  disableWayland
};
