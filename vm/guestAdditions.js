/**
 * vm/guestAdditions.js — Guest Additions Automation (Host + Guest Side)
 * 
 * Design Decision: This module handles BOTH sides of Guest Additions:
 * 
 * HOST SIDE (VBoxManage modifyvm — before first boot):
 *   - Clipboard bidirectional
 *   - Drag-and-drop bidirectional
 *   - Display integration preferences (without forcing graphics controller)
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

const LINUX_USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const SHARE_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

function shellQuote(value = '') {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function validateLinuxGuestUsername(username = '') {
  const normalized = String(username || '').trim();
  if (!normalized) {
    throw new Error('Guest username is required.');
  }
  if (!LINUX_USERNAME_PATTERN.test(normalized)) {
    throw new Error('Guest username must start with a letter/underscore and contain only letters, numbers, underscores, or hyphens.');
  }
  return normalized;
}

function validateSharedFolderName(name = '') {
  const normalized = String(name || '').trim() || 'shared';
  if (!SHARE_NAME_PATTERN.test(normalized)) {
    throw new Error('Shared folder name can contain only letters, numbers, dot, underscore, and hyphen.');
  }
  return normalized;
}

function buildSudoPrefix(password = '') {
  const normalized = String(password ?? '');
  if (!normalized) {
    throw new Error('Guest password is required for elevated guest setup commands.');
  }
  return `printf '%s\\n' ${shellQuote(normalized)} | sudo -S --`;
}

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
async function configureGuestFeatures(vmName, options = {}) {
  const {
    fullscreen = true,
    accelerate3d = false,
    graphicsController = '',
    vram = 128,
    clipboardMode = 'bidirectional',
    dragAndDrop = 'bidirectional'
  } = options;
  logger.info('GuestAdditions', `Configuring Guest Additions features for "${vmName}"...`);

  try {
    // Set graphics and GUI integration preferences for fullscreen/dynamic resize
    await virtualbox.configureDisplayIntegration(vmName, {
      fullscreen,
      accelerate3d: accelerate3d === true,
      graphicsController,
      vram
    });
    logger.success('GuestAdditions', 'Display integration preferences applied');

    // Enable bidirectional clipboard
    await virtualbox.configureVM(vmName, {
      clipboardMode: clipboardMode || 'disabled'
    });
    logger.success('GuestAdditions', `Clipboard mode applied: ${clipboardMode || 'disabled'}`);

    // Enable bidirectional drag and drop
    await virtualbox.configureVM(vmName, {
      dragAndDrop: dragAndDrop || 'disabled'
    });
    logger.success('GuestAdditions', `Drag & Drop mode applied: ${dragAndDrop || 'disabled'}`);

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
  const normalizedUsername = validateLinuxGuestUsername(username);
  const configureSharedFolder = options.configureSharedFolder !== false;
  const sharedFolderName = validateSharedFolderName(options.sharedFolderName || 'shared');
  const sudoPrefix = buildSudoPrefix(password);
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
      normalizedUsername,
      password,
      `export DEBIAN_FRONTEND=noninteractive; ${sudoPrefix} apt-get update -y`,
      { timeout: 240000, retries: 2, description: 'apt-get update' }
    );

    await runGuestStep(
      vmName,
      normalizedUsername,
      password,
      `export DEBIAN_FRONTEND=noninteractive; ${sudoPrefix} apt-get install -y ` +
      'virtualbox-guest-utils virtualbox-guest-x11 virtualbox-guest-dkms dkms build-essential linux-headers-$(uname -r)',
      { timeout: 480000, retries: 2, description: 'Guest Additions package install' }
    );

    _progress('Guest Additions packages installed', 25);

    // ─── Step 2: Add user to vboxsf group (shared folder access) ──
    _progress('Configuring shared folder access...', 35);

    await runGuestStep(
      vmName,
      normalizedUsername,
      password,
      `${sudoPrefix} usermod -aG vboxsf ${shellQuote(normalizedUsername)}`,
      { timeout: 30000, retries: 1, description: 'Add user to vboxsf group' }
    );

    // Also add to video group for display
    await runGuestStep(
      vmName,
      normalizedUsername,
      password,
      `${sudoPrefix} usermod -aG video ${shellQuote(normalizedUsername)}`,
      { timeout: 30000, retries: 1, description: 'Add user to video group' }
    );

    logger.success('GuestAdditions', `User "${normalizedUsername}" added to vboxsf and video groups`);

    // ─── Step 3: Load kernel modules ──────────────────────────────
    _progress('Loading Guest Additions kernel modules...', 45);

    await runGuestStep(
      vmName,
      normalizedUsername,
      password,
      `${sudoPrefix} modprobe vboxguest; ` +
      `${sudoPrefix} modprobe vboxsf; ` +
      `${sudoPrefix} modprobe vboxvideo; echo done`,
      { timeout: 45000, retries: 2, description: 'Load VBox kernel modules' }
    );

    // Ensure modules load on every boot
    await runGuestStep(
      vmName,
      normalizedUsername,
      password,
      `${sudoPrefix} sh -c ${shellQuote('printf "vboxguest\\nvboxsf\\nvboxvideo\\n" > /etc/modules-load.d/virtualbox.conf')}`,
      {
        timeout: 30000,
        retries: 1,
        description: 'Persist VBox modules config',
        verify: async () => {
          const verifyOut = await virtualbox.guestShell(vmName, normalizedUsername, password, 'cat /etc/modules-load.d/virtualbox.conf || true', { timeout: 15000, ignoreErrors: false });
          return verifyOut.includes('vboxguest') && verifyOut.includes('vboxsf');
        }
      }
    );

    logger.success('GuestAdditions', 'Kernel modules loaded and set to auto-load');

    // ─── Step 4: Start VBoxClient services ────────────────────────
    _progress('Starting VBoxClient services (clipboard, drag-drop, display)...', 55);

    // Kill any existing VBoxClient processes first
    await virtualbox.guestShell(vmName, normalizedUsername, password, 'killall VBoxClient 2>/dev/null || true; sleep 1; echo ok', { timeout: 15000, ignoreErrors: true });

    // Start all VBoxClient services
    await runGuestStep(
      vmName,
      normalizedUsername,
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
      normalizedUsername,
      password,
      `mkdir -p /home/${normalizedUsername}/.config/autostart && ` +
      `echo -e "${autostartScript}" > /home/${normalizedUsername}/.config/autostart/vboxclient.desktop && ` +
      `test -f /home/${normalizedUsername}/.config/autostart/vboxclient.desktop && echo ok`,
      {
        timeout: 30000,
        retries: 1,
        description: 'Create VBoxClient autostart entry',
        verify: async (out) => out.includes('ok')
      }
    );

    // Also ensure the system-wide vboxadd service is enabled
    await virtualbox.guestShell(vmName, normalizedUsername, password,
      `${sudoPrefix} systemctl enable vboxadd.service 2>/dev/null || true; ` +
      `${sudoPrefix} systemctl enable vboxadd-service.service 2>/dev/null || true; echo done`,
      { timeout: 30000, ignoreErrors: true }
    );

    logger.success('GuestAdditions', 'Autostart configured — services will persist across reboots');

    let sharedMounted = false;
    if (configureSharedFolder) {
      // ─── Step 6: Fix shared folder mount & permissions ────────────
      _progress('Configuring shared folder mount and permissions...', 80);

      const guestMountPoint = `/media/sf_${sharedFolderName}`;
      const mountEntry = `${sharedFolderName} ${guestMountPoint} vboxsf rw,_netdev,umask=0007 0 0`;

      // Create mount point if it doesn't exist
      await runGuestStep(
        vmName,
        normalizedUsername,
        password,
        `${sudoPrefix} mkdir -p ${shellQuote(guestMountPoint)} && ` +
        `${sudoPrefix} chown root:vboxsf ${shellQuote(guestMountPoint)} && ` +
        `${sudoPrefix} chmod 770 ${shellQuote(guestMountPoint)} && echo ok`,
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
      normalizedUsername,
      password,
      `${sudoPrefix} bash -lc ${shellQuote(
        `sed -i "\\|^${sharedFolderName} ${guestMountPoint} vboxsf |d" /etc/fstab; ` +
        `printf '%s\\n' ${shellQuote(mountEntry)} >> /etc/fstab`
      )} && echo ok`,
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
        normalizedUsername,
        password,
        `${sudoPrefix} mount -t vboxsf ${shellQuote(sharedFolderName)} ${shellQuote(guestMountPoint)} 2>/dev/null || ` +
        `${sudoPrefix} mount -a 2>/dev/null; ` +
        `mount | grep -q ${shellQuote(guestMountPoint)} && echo mounted`,
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

    // Drag & drop is unreliable on Ubuntu Wayland sessions in VirtualBox.
    // Prefer Xorg when gdm3 is present so VBoxClient draganddrop can attach reliably.
    await virtualbox.guestShell(
      vmName,
      normalizedUsername,
      password,
      'if [ -f /etc/gdm3/custom.conf ]; then ' +
      `${sudoPrefix} sed -i "s/^#\\?WaylandEnable=.*/WaylandEnable=false/" /etc/gdm3/custom.conf 2>/dev/null || true; ` +
      `grep -q "^WaylandEnable=false" /etc/gdm3/custom.conf || ${sudoPrefix} bash -lc ${shellQuote('printf "\\n[daemon]\\nWaylandEnable=false\\n" >> /etc/gdm3/custom.conf')}; ` +
      'fi; echo done',
      { timeout: 15000, ignoreErrors: true }
    );

    await runGuestStep(
      vmName,
      normalizedUsername,
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
      normalizedUsername,
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
    await virtualbox.guestShell(vmName, normalizedUsername, password,
      'gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null; ' +
      'gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null; ' +
      'gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type "nothing" 2>/dev/null; echo done',
      { timeout: 15000, ignoreErrors: true }
    );

    logger.success('GuestAdditions', 'Fullscreen and dynamic resolution configured');

    // ─── Verification ─────────────────────────────────────────────
    const verifyGroups = await virtualbox.guestShell(vmName, normalizedUsername, password, `id -nG ${shellQuote(normalizedUsername)} || true`, { timeout: 15000, ignoreErrors: false });
    const verifyAutostart = await virtualbox.guestShell(vmName, normalizedUsername, password, `test -f /home/${normalizedUsername}/.config/autostart/vboxclient.desktop && echo ok || echo missing`, { timeout: 15000, ignoreErrors: false });
    const verifyDisplayClient = await virtualbox.guestShell(vmName, normalizedUsername, password, 'pgrep -f "VBoxClient --display" >/dev/null && echo running || echo missing', { timeout: 15000, ignoreErrors: false });
    const verifyClipboardClient = await virtualbox.guestShell(vmName, normalizedUsername, password, 'pgrep -f "VBoxClient --clipboard" >/dev/null && echo running || echo missing', { timeout: 15000, ignoreErrors: false });
    const verifyDnDClient = await virtualbox.guestShell(vmName, normalizedUsername, password, 'pgrep -f "VBoxClient --draganddrop" >/dev/null && echo running || echo missing', { timeout: 15000, ignoreErrors: false });
    const verifySessionType = await virtualbox.guestShell(
      vmName,
      normalizedUsername,
      password,
      'sid=$(loginctl list-sessions --no-legend 2>/dev/null | awk -v u="$(whoami)" \'$3==u {print $1; exit}\'); ' +
      'if [ -n "$sid" ]; then loginctl show-session "$sid" -p Type --value 2>/dev/null; else echo unknown; fi',
      { timeout: 15000, ignoreErrors: true }
    );
    const verifyMount = configureSharedFolder
      ? await virtualbox.guestShell(vmName, normalizedUsername, password, `mount | grep -q ${shellQuote(`/media/sf_${sharedFolderName}`)} && echo mounted || echo not-mounted`, { timeout: 15000, ignoreErrors: false })
      : 'skipped';
    const sessionType = String(verifySessionType || '').trim().toLowerCase() || 'unknown';
    const sessionX11 = sessionType.includes('x11') || sessionType.includes('xorg') || sessionType === 'unknown';

    const checks = {
      userInVboxsf: verifyGroups.includes('vboxsf'),
      autostartFile: verifyAutostart.includes('ok'),
      displayClient: verifyDisplayClient.includes('running'),
      clipboardClient: verifyClipboardClient.includes('running'),
      dragDropClient: verifyDnDClient.includes('running'),
      sharedMounted: configureSharedFolder ? verifyMount.includes('mounted') : true,
      sessionType,
      sessionX11
    };

    if (!checks.userInVboxsf
      || !checks.autostartFile
      || !checks.displayClient
      || !checks.clipboardClient
      || !checks.dragDropClient
      || (configureSharedFolder && !checks.sharedMounted)
      || !checks.sessionX11) {
      throw new Error(
        `Guest verification failed: userInVboxsf=${checks.userInVboxsf}, autostartFile=${checks.autostartFile}, displayClient=${checks.displayClient}, clipboardClient=${checks.clipboardClient}, dragDropClient=${checks.dragDropClient}, sharedMounted=${checks.sharedMounted}, sessionType=${checks.sessionType}`
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
      sessionType: checks.sessionType,
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
