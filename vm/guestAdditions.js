/**
 * vm/guestAdditions.js — Guest Additions Automation (Host + Guest Side)
 * 
 * Design Decision: This module handles BOTH sides of Guest Additions:
 * 
 * HOST SIDE (VBoxManage modifyvm — before first boot):
 *   - Clipboard bidirectional
 *   - Drag-and-drop bidirectional
 *   - VMSVGA graphics + 128MB VRAM
 * 
 * GUEST SIDE (VBoxManage guestcontrol — after Ubuntu boots):
 *   - Install Guest Additions packages (virtualbox-guest-utils, etc.)
 *   - Add user to vboxsf group (for shared folder access)
 *   - Enable and start VBoxClient services (clipboard, drag-drop, display)
 *   - Create autostart entry so everything persists across reboots
 *   - Fix shared folder permissions
 *   - Enable dynamic resolution / fullscreen
 * 
 * The user NEVER needs to open Ubuntu terminal. Our app does everything.
 */

const logger = require('../core/logger');
const virtualbox = require('../adapters/virtualbox');

async function runGuestStep(vmName, username, password, script, options = {}) {
  const {
    timeout = 120000,
    retries = 2,
    description = 'guest step',
    verify = null
  } = options;

  let lastError = null;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const output = await virtualbox.guestShell(vmName, username, password, script, {
        timeout,
        ignoreErrors: false
      });

      if (typeof verify === 'function') {
        const verified = await verify(output || '');
        if (!verified) {
          throw new Error(`Verification failed for ${description}`);
        }
      }

      return output;
    } catch (err) {
      lastError = err;
      if (attempt <= retries) {
        logger.warn('GuestAdditions', `${description} failed (attempt ${attempt}/${retries + 1}). Retrying... ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  }

  throw new Error(`${description} failed after ${retries + 1} attempts: ${lastError?.message || 'Unknown error'}`);
}

// ═══════════════════════════════════════════════════════════════════════
// HOST SIDE — Configure VirtualBox settings (before VM boot)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Configure all Guest Additions features on the HOST side.
 * This should be called after the VM is created but before first boot.
 */
async function configureGuestFeatures(vmName) {
  logger.info('GuestAdditions', `Configuring Guest Additions features for "${vmName}"...`);

  try {
    // Set graphics and GUI integration preferences for fullscreen/dynamic resize
    await virtualbox.configureDisplayIntegration(vmName);
    logger.success('GuestAdditions', 'Display integration preferences applied');

    // Enable bidirectional clipboard
    await virtualbox.configureVM(vmName, {
      clipboardMode: 'bidirectional'
    });
    logger.success('GuestAdditions', 'Clipboard: Bidirectional sharing enabled');

    // Enable bidirectional drag and drop
    await virtualbox.configureVM(vmName, {
      dragAndDrop: 'bidirectional'
    });
    logger.success('GuestAdditions', 'Drag & Drop: Bidirectional enabled');

    logger.success('GuestAdditions', 'All host-side Guest Additions features configured');

  } catch (err) {
    logger.error('GuestAdditions', `Failed to configure guest features: ${err.message}`);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// GUEST SIDE — Run commands INSIDE Ubuntu (after VM boots)
// This is what makes "zero user touch" possible.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run the complete post-install guest configuration.
 * This is called after Ubuntu has booted and Guest Additions are detected.
 * 
 * Executes commands INSIDE Ubuntu via VBoxManage guestcontrol:
 * 1. Install Guest Additions packages
 * 2. Add user to vboxsf group  
 * 3. Enable VBoxClient services (clipboard, drag-drop, display)
 * 4. Create autostart script for persistence
 * 5. Fix shared folder permissions
 * 6. Set up fullscreen / dynamic resolution
 * 
 * @param {string} vmName - VM name
 * @param {string} username - Ubuntu username
 * @param {string} password - Ubuntu password
 * @param {function} [onProgress] - Progress callback
 */
async function configureGuestInside(vmName, username, password, onProgress = null, options = {}) {
  const configureSharedFolder = options.configureSharedFolder !== false;
  const sharedFolderName = options.sharedFolderName || 'shared';
  logger.info('GuestAdditions', '═══ Starting In-Guest Configuration ═══');
  logger.info('GuestAdditions', 'Running commands inside Ubuntu — no user action needed');

  const _progress = (msg, pct) => {
    logger.info('GuestAdditions', msg);
    if (onProgress) onProgress({ message: msg, percent: pct });
  };

  try {
    // ─── Step 1: Update packages & install Guest Additions ────────
    _progress('Installing Guest Additions packages inside Ubuntu...', 10);

    await runGuestStep(
      vmName,
      username,
      password,
      'export DEBIAN_FRONTEND=noninteractive; echo "' + password + '" | sudo -S apt-get update -y',
      { timeout: 240000, retries: 2, description: 'apt-get update' }
    );

    await runGuestStep(
      vmName,
      username,
      password,
      'export DEBIAN_FRONTEND=noninteractive; echo "' + password + '" | sudo -S apt-get install -y ' +
      'virtualbox-guest-utils virtualbox-guest-x11 virtualbox-guest-dkms dkms build-essential linux-headers-$(uname -r)',
      { timeout: 480000, retries: 2, description: 'Guest Additions package install' }
    );

    _progress('Guest Additions packages installed', 25);

    // ─── Step 2: Add user to vboxsf group (shared folder access) ──
    _progress('Configuring shared folder access...', 35);

    await runGuestStep(
      vmName,
      username,
      password,
      'echo "' + password + '" | sudo -S usermod -aG vboxsf ' + username,
      { timeout: 30000, retries: 1, description: 'Add user to vboxsf group' }
    );

    // Also add to video group for display
    await runGuestStep(
      vmName,
      username,
      password,
      'echo "' + password + '" | sudo -S usermod -aG video ' + username,
      { timeout: 30000, retries: 1, description: 'Add user to video group' }
    );

    logger.success('GuestAdditions', `User "${username}" added to vboxsf and video groups`);

    // ─── Step 3: Load kernel modules ──────────────────────────────
    _progress('Loading Guest Additions kernel modules...', 45);

    await runGuestStep(
      vmName,
      username,
      password,
      'echo "' + password + '" | sudo -S modprobe vboxguest; ' +
      'echo "' + password + '" | sudo -S modprobe vboxsf; ' +
      'echo "' + password + '" | sudo -S modprobe vboxvideo; echo done',
      { timeout: 45000, retries: 2, description: 'Load VBox kernel modules' }
    );

    // Ensure modules load on every boot
    await runGuestStep(
      vmName,
      username,
      password,
      'echo "' + password + '" | sudo -S bash -c \'printf "vboxguest\\nvboxsf\\nvboxvideo\\n" > /etc/modules-load.d/virtualbox.conf\'',
      {
        timeout: 30000,
        retries: 1,
        description: 'Persist VBox modules config',
        verify: async () => {
          const verifyOut = await virtualbox.guestShell(vmName, username, password, 'cat /etc/modules-load.d/virtualbox.conf || true', { timeout: 15000, ignoreErrors: false });
          return verifyOut.includes('vboxguest') && verifyOut.includes('vboxsf');
        }
      }
    );

    logger.success('GuestAdditions', 'Kernel modules loaded and set to auto-load');

    // ─── Step 4: Start VBoxClient services ────────────────────────
    _progress('Starting VBoxClient services (clipboard, drag-drop, display)...', 55);

    // Kill any existing VBoxClient processes first
    await virtualbox.guestShell(vmName, username, password, 'killall VBoxClient 2>/dev/null || true; sleep 1; echo ok', { timeout: 15000, ignoreErrors: true });

    // Start all VBoxClient services
    await runGuestStep(
      vmName,
      username,
      password,
      'nohup VBoxClient-all >/tmp/vboxclient-all.log 2>&1 & sleep 2; pgrep -f VBoxClient >/dev/null && echo running',
      {
        timeout: 30000,
        retries: 2,
        description: 'Start VBoxClient services',
        verify: async (out) => out.includes('running')
      }
    );

    logger.success('GuestAdditions', 'VBoxClient services started');

    // ─── Step 5: Create autostart script for persistence ──────────
    _progress('Setting up autostart for VBoxClient services...', 70);

    // Create autostart desktop entry so VBoxClient starts on every login
    const autostartScript = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=VBoxClient Services',
      'Comment=VirtualBox Guest Additions Services',
      'Exec=/usr/bin/VBoxClient-all',
      'X-GNOME-Autostart-enabled=true',
      'NoDisplay=true'
    ].join('\\n');

    await runGuestStep(
      vmName,
      username,
      password,
      `mkdir -p /home/${username}/.config/autostart && ` +
      `echo -e "${autostartScript}" > /home/${username}/.config/autostart/vboxclient.desktop && ` +
      `test -f /home/${username}/.config/autostart/vboxclient.desktop && echo ok`,
      {
        timeout: 30000,
        retries: 1,
        description: 'Create VBoxClient autostart entry',
        verify: async (out) => out.includes('ok')
      }
    );

    // Also ensure the system-wide vboxadd service is enabled
    await virtualbox.guestShell(vmName, username, password,
      'echo "' + password + '" | sudo -S systemctl enable vboxadd.service 2>/dev/null || true; ' +
      'echo "' + password + '" | sudo -S systemctl enable vboxadd-service.service 2>/dev/null || true; echo done',
      { timeout: 30000, ignoreErrors: true }
    );

    logger.success('GuestAdditions', 'Autostart configured — services will persist across reboots');

    let sharedMounted = false;
    if (configureSharedFolder) {
      // ─── Step 6: Fix shared folder mount & permissions ────────────
      _progress('Configuring shared folder mount and permissions...', 80);

      const guestMountPoint = `/media/sf_${sharedFolderName}`;

      // Create mount point if it doesn't exist
      await runGuestStep(
        vmName,
        username,
        password,
        'echo "' + password + '" | sudo -S mkdir -p ' + guestMountPoint + ' && ' +
        'echo "' + password + '" | sudo -S chown root:vboxsf ' + guestMountPoint + ' && ' +
        'echo "' + password + '" | sudo -S chmod 770 ' + guestMountPoint + ' && echo ok',
        {
          timeout: 30000,
          retries: 2,
          description: 'Prepare shared folder mountpoint',
          verify: async (out) => out.includes('ok')
        }
      );

      // Add fstab entry for persistent mount
      await runGuestStep(
        vmName,
        username,
        password,
        'echo "' + password + '" | sudo -S bash -c \'' +
        'grep -q "' + sharedFolderName + ' ' + guestMountPoint + ' vboxsf" /etc/fstab || ' +
        'echo "' + sharedFolderName + ' ' + guestMountPoint + ' vboxsf defaults,uid=1000,gid=1000,_netdev 0 0" >> /etc/fstab\' && echo ok',
        {
          timeout: 30000,
          retries: 2,
          description: 'Persist shared folder mount in fstab',
          verify: async (out) => out.includes('ok')
        }
      );

      // Try to mount it now
      await runGuestStep(
        vmName,
        username,
        password,
        'echo "' + password + '" | sudo -S mount -t vboxsf ' + sharedFolderName + ' ' + guestMountPoint + ' 2>/dev/null || ' +
        'echo "' + password + '" | sudo -S mount -a 2>/dev/null; ' +
        'mount | grep -q "' + guestMountPoint + '" && echo mounted',
        {
          timeout: 30000,
          retries: 2,
          description: 'Mount shared folder in guest',
          verify: async (out) => out.includes('mounted')
        }
      );

      sharedMounted = true;
      logger.success('GuestAdditions', 'Shared folder mounted and configured for auto-mount');
    }

    // ─── Step 7: Enable fullscreen / dynamic resolution ───────────
    _progress('Enabling fullscreen and dynamic resolution...', 90);

    await runGuestStep(
      vmName,
      username,
      password,
      'pkill -f "VBoxClient --display" 2>/dev/null || true; ' +
      'pkill -f "VBoxClient --clipboard" 2>/dev/null || true; ' +
      'pkill -f "VBoxClient --draganddrop" 2>/dev/null || true; ' +
      'nohup VBoxClient --display >/tmp/vbox-display.log 2>&1 & ' +
      'nohup VBoxClient --clipboard >/tmp/vbox-clipboard.log 2>&1 & ' +
      'nohup VBoxClient --draganddrop >/tmp/vbox-dnd.log 2>&1 & ' +
      'sleep 2; ' +
      'pgrep -f "VBoxClient --display" >/dev/null && echo display-ok',
      {
        timeout: 30000,
        retries: 2,
        description: 'Start VBoxClient display/clipboard/dragdrop services',
        verify: async (out) => out.includes('display-ok')
      }
    );

    await runGuestStep(
      vmName,
      username,
      password,
      'xrandr --output Virtual-1 --auto 2>/dev/null || xrandr --auto 2>/dev/null || true; echo done',
      {
        timeout: 20000,
        retries: 1,
        description: 'Apply dynamic display auto-resize',
        verify: async (out) => out.includes('done')
      }
    );

    // Remove screen lock / screensaver for better VM experience
    await virtualbox.guestShell(vmName, username, password,
      'gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null; ' +
      'gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null; ' +
      'gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type "nothing" 2>/dev/null; echo done',
      { timeout: 15000, ignoreErrors: true }
    );

    logger.success('GuestAdditions', 'Fullscreen and dynamic resolution configured');

    // ─── Verification ─────────────────────────────────────────────
    const verifyGroups = await virtualbox.guestShell(vmName, username, password, `id -nG ${username} || true`, { timeout: 15000, ignoreErrors: false });
    const verifyAutostart = await virtualbox.guestShell(vmName, username, password, `test -f /home/${username}/.config/autostart/vboxclient.desktop && echo ok || echo missing`, { timeout: 15000, ignoreErrors: false });
    const verifyDisplayClient = await virtualbox.guestShell(vmName, username, password, 'pgrep -f "VBoxClient --display" >/dev/null && echo running || echo missing', { timeout: 15000, ignoreErrors: false });
    const verifyClipboardClient = await virtualbox.guestShell(vmName, username, password, 'pgrep -f "VBoxClient --clipboard" >/dev/null && echo running || echo missing', { timeout: 15000, ignoreErrors: false });
    const verifyDnDClient = await virtualbox.guestShell(vmName, username, password, 'pgrep -f "VBoxClient --draganddrop" >/dev/null && echo running || echo missing', { timeout: 15000, ignoreErrors: false });
    const verifyMount = configureSharedFolder
      ? await virtualbox.guestShell(vmName, username, password, `mount | grep -q "/media/sf_${sharedFolderName}" && echo mounted || echo not-mounted`, { timeout: 15000, ignoreErrors: false })
      : 'skipped';

    const checks = {
      userInVboxsf: verifyGroups.includes('vboxsf'),
      autostartFile: verifyAutostart.includes('ok'),
      displayClient: verifyDisplayClient.includes('running'),
      clipboardClient: verifyClipboardClient.includes('running'),
      dragDropClient: verifyDnDClient.includes('running'),
      sharedMounted: configureSharedFolder ? verifyMount.includes('mounted') : true
    };

    if (!checks.userInVboxsf || !checks.autostartFile || !checks.displayClient || !checks.clipboardClient || !checks.dragDropClient) {
      throw new Error(
        `Guest verification failed: userInVboxsf=${checks.userInVboxsf}, autostartFile=${checks.autostartFile}, displayClient=${checks.displayClient}, clipboardClient=${checks.clipboardClient}, dragDropClient=${checks.dragDropClient}, sharedMounted=${checks.sharedMounted}`
      );
    }

    // ─── Done ─────────────────────────────────────────────────────
    _progress('In-guest configuration complete!', 100);

    logger.success('GuestAdditions', '═══ In-Guest Configuration Complete ═══');
    logger.success('GuestAdditions', 'Configured:');
    logger.success('GuestAdditions', '  ✓ Guest Additions packages installed');
    logger.success('GuestAdditions', '  ✓ Shared folder access (vboxsf group)');
    logger.success('GuestAdditions', '  ✓ Clipboard sharing (bidirectional)');
    logger.success('GuestAdditions', '  ✓ Drag and drop (bidirectional)');
    logger.success('GuestAdditions', '  ✓ Fullscreen / dynamic resolution');
    logger.success('GuestAdditions', '  ✓ VBoxClient autostart on boot');
    logger.success('GuestAdditions', '  ✓ Shared folder auto-mount on boot');
    logger.success('GuestAdditions', '  ✓ Screen lock disabled for VM');

    return {
      guestAdditionsInstalled: true,
      clipboardEnabled: true,
      dragDropEnabled: true,
      fullscreenEnabled: true,
      sharedFolderMounted: checks.sharedMounted,
      autostartConfigured: true,
      checks
    };

  } catch (err) {
    logger.error('GuestAdditions', `In-guest configuration failed: ${err.message}`);
    throw err;
  }
}

/**
 * Check if Guest Additions are installed and running in a VM.
 */
async function checkGuestAdditionsStatus(vmName) {
  try {
    const info = await virtualbox.getVMInfo(vmName);
    return {
      installed: !!info.GuestAdditionsVersion,
      version: info.GuestAdditionsVersion || null,
      runLevel: info.GuestAdditionsRunLevel || null
    };
  } catch (err) {
    logger.warn('GuestAdditions', `Could not check GA status: ${err.message}`);
    return { installed: false, version: null, runLevel: null };
  }
}

module.exports = {
  configureGuestFeatures,
  configureGuestInside,
  checkGuestAdditionsStatus
};
