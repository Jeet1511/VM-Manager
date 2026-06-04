/**
 * vm/cloudInit.js — Cloud-Init Autoinstall & VISO Generator
 * 
 * Production-grade automation fallback for Ubuntu 20.04+.
 * When VBoxManage unattended install fails (ConstructMedia error),
 * VM Xposed generates its own cloud-init autoinstall config and
 * injects it as a virtual ISO (VISO) so Ubuntu's Subiquity installer
 * runs fully automated — zero manual steps.
 * 
 * Features automated:
 * - User creation with password
 * - Auto-login (no login screen)
 * - Guest Additions installation
 * - Shared folder group (vboxsf)
 * - VBoxClient autostart (clipboard, drag-drop, display)
 * - Screen lock/screensaver disabled
 * - Wayland disabled (for reliable VBox integration)
 * - Timezone and locale
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');

/**
 * SHA-512 crypt ($6$) — Drepper specification.
 * Produces /etc/shadow compatible password hashes.
 * This is the same algorithm as `openssl passwd -6` and `mkpasswd -m sha-512`.
 *
 * Reference: https://www.akkadia.org/drepper/SHA-crypt.txt
 */
function hashPassword(password, rounds = 5000) {
  const HASH_LEN = 64; // SHA-512 digest length
  const salt = crypto.randomBytes(12).toString('base64').replace(/[+\/=]/g, '').slice(0, 16);
  const passBytes = Buffer.from(password, 'utf8');
  const saltBytes = Buffer.from(salt, 'utf8');

  // Step 1-3: digestB = SHA512(password + salt + password)
  const ctxB = crypto.createHash('sha512');
  ctxB.update(passBytes);
  ctxB.update(saltBytes);
  ctxB.update(passBytes);
  let digestB = ctxB.digest();

  // Step 4-8: digestA = SHA512(password + salt + digestB-chunks + bit-interleave)
  const ctxA = crypto.createHash('sha512');
  ctxA.update(passBytes);
  ctxA.update(saltBytes);

  let remaining = passBytes.length;
  while (remaining > HASH_LEN) { ctxA.update(digestB); remaining -= HASH_LEN; }
  ctxA.update(digestB.subarray(0, remaining));

  for (let i = passBytes.length; i > 0; i >>= 1) {
    ctxA.update((i & 1) ? digestB : passBytes);
  }
  let digestA = ctxA.digest();

  // Step 9-11: digestDP = SHA512(password repeated passLen times)
  const ctxDP = crypto.createHash('sha512');
  for (let i = 0; i < passBytes.length; i++) { ctxDP.update(passBytes); }
  let digestDP = ctxDP.digest();
  const P = Buffer.alloc(passBytes.length);
  for (let i = 0; i < passBytes.length; i++) { P[i] = digestDP[i % HASH_LEN]; }

  // Step 12-14: digestDS = SHA512(salt repeated (16 + digestA[0]) times)
  const ctxDS = crypto.createHash('sha512');
  for (let i = 0; i < 16 + digestA[0]; i++) { ctxDS.update(saltBytes); }
  let digestDS = ctxDS.digest();
  const S = Buffer.alloc(saltBytes.length);
  for (let i = 0; i < saltBytes.length; i++) { S[i] = digestDS[i % HASH_LEN]; }

  // Step 15-21: 5000 rounds
  for (let r = 0; r < rounds; r++) {
    const ctx = crypto.createHash('sha512');
    ctx.update((r & 1) ? P : digestA);
    if (r % 3) ctx.update(S);
    if (r % 7) ctx.update(P);
    ctx.update((r & 1) ? digestA : P);
    digestA = ctx.digest();
  }

  // Step 22: Encode with custom base64
  const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  function b64from(a, b, c, n) {
    let v = (a << 16) | (b << 8) | c;
    let out = '';
    for (let i = 0; i < n; i++) { out += ITOA64[v & 0x3f]; v >>= 6; }
    return out;
  }
  const d = digestA;
  const encoded =
    b64from(d[0], d[21], d[42], 4) + b64from(d[22], d[43], d[1], 4) +
    b64from(d[44], d[2], d[23], 4) + b64from(d[3], d[24], d[45], 4) +
    b64from(d[25], d[46], d[4], 4) + b64from(d[47], d[5], d[26], 4) +
    b64from(d[6], d[27], d[48], 4) + b64from(d[28], d[49], d[7], 4) +
    b64from(d[50], d[8], d[29], 4) + b64from(d[9], d[30], d[51], 4) +
    b64from(d[31], d[52], d[10], 4) + b64from(d[53], d[11], d[32], 4) +
    b64from(d[12], d[33], d[54], 4) + b64from(d[34], d[55], d[13], 4) +
    b64from(d[56], d[14], d[35], 4) + b64from(d[15], d[36], d[57], 4) +
    b64from(d[37], d[58], d[16], 4) + b64from(d[59], d[17], d[38], 4) +
    b64from(d[18], d[39], d[60], 4) + b64from(d[40], d[61], d[19], 4) +
    b64from(d[62], d[20], d[41], 4) + b64from(0, 0, d[63], 2);

  return `$6$${salt}$${encoded}`;
}

/**
 * Generate a complete cloud-init user-data YAML for Ubuntu autoinstall.
 * This config automates EVERYTHING — the user never touches the installer.
 */
function generateUserData(options) {
  const {
    hostname = 'ubuntu-vm',
    username = 'guest',
    password = 'guest',
    fullName = 'VM User',
    locale = 'en_US.UTF-8',
    timezone = 'UTC',
    keyboardLayout = 'us',
    installGuestAdditions = true,
    enableSharedFolder = true,
    disableScreenLock = true,
    enableAutoLogin = true,
    disableWayland = true
  } = options;

  const hashedPassword = hashPassword(password);
  const safeUsername = String(username).replace(/['"\\]/g, '');

  logger.info('CloudInit', `Generating autoinstall config for host: ${hostname}, user: ${safeUsername}`);

  // Build late-commands for post-install configuration
  const lateCommands = [];

  // Auto-login — user never sees login screen
  // Detect which display manager is installed and configure the right one
  if (enableAutoLogin) {
    lateCommands.push(
      `    - |`,
      `      # Configure auto-login for whichever display manager is installed`,
      `      if [ -d /target/etc/gdm3 ]; then`,
      `        mkdir -p /target/etc/gdm3`,
      `        cat <<'GDMEOF' > /target/etc/gdm3/custom.conf`,
      `      [daemon]`,
      `      AutomaticLoginEnable=true`,
      `      AutomaticLogin=${safeUsername}`,
      `      GDMEOF`,
      `      elif [ -d /target/etc/gdm ]; then`,
      `        mkdir -p /target/etc/gdm`,
      `        cat <<'GDMEOF' > /target/etc/gdm/custom.conf`,
      `      [daemon]`,
      `      AutomaticLoginEnable=true`,
      `      AutomaticLogin=${safeUsername}`,
      `      GDMEOF`,
      `      fi`,
      `    - |`,
      `      # LightDM auto-login (Lubuntu, Xubuntu, etc.)`,
      `      if chroot /target dpkg -l lightdm 2>/dev/null | grep -q "^ii"; then`,
      `        mkdir -p /target/etc/lightdm/lightdm.conf.d`,
      `        cat <<'LDMEOF' > /target/etc/lightdm/lightdm.conf.d/50-vmxposed-autologin.conf`,
      `      [Seat:*]`,
      `      autologin-user=${safeUsername}`,
      `      LDMEOF`,
      `      fi`
    );
  }

  // Guest Additions packages + user groups
  if (installGuestAdditions) {
    lateCommands.push(
      `    - "curtin in-target -- apt-get install -y virtualbox-guest-utils virtualbox-guest-x11 2>/dev/null || true"`,
      `    - "curtin in-target -- usermod -aG vboxsf ${safeUsername} || true"`,
      `    - "curtin in-target -- usermod -aG video ${safeUsername} || true"`
    );
  }

  // Shared folder group
  if (enableSharedFolder) {
    lateCommands.push(
      `    - "curtin in-target -- mkdir -p /media/sf_shared || true"`,
      `    - "grep -q vboxsf /target/etc/fstab || echo 'shared /media/sf_shared vboxsf rw,_netdev,umask=0007 0 0' >> /target/etc/fstab"`
    );
  }

  // VBoxClient autostart — clipboard, drag-drop, display all work on every login
  if (installGuestAdditions) {
    lateCommands.push(
      `    - "mkdir -p /target/home/${safeUsername}/.config/autostart"`,
      `    - |`,
      `      cat <<'VBOXEOF' > /target/home/${safeUsername}/.config/autostart/vboxclient.desktop`,
      `      [Desktop Entry]`,
      `      Type=Application`,
      `      Name=VBoxClient Services`,
      `      Exec=/usr/bin/VBoxClient-all`,
      `      X-GNOME-Autostart-enabled=true`,
      `      NoDisplay=true`,
      `      VBOXEOF`,
      `    - "curtin in-target -- chown -R 1000:1000 /home/${safeUsername}/.config || true"`
    );
  }

  // Disable Wayland — VBox drag-drop and clipboard work better on Xorg
  if (disableWayland) {
    lateCommands.push(
      `    - "sed -i 's/^#\\?WaylandEnable=.*/WaylandEnable=false/' /target/etc/gdm3/custom.conf 2>/dev/null || true"`
    );
  }

  // Disable screen lock and screensaver
  if (disableScreenLock) {
    lateCommands.push(
      `    - "curtin in-target -- su - ${safeUsername} -c 'gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null' 2>/dev/null || true"`,
      `    - "curtin in-target -- su - ${safeUsername} -c 'gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null' 2>/dev/null || true"`
    );
  }

  // Set timezone
  lateCommands.push(
    `    - "curtin in-target -- timedatectl set-timezone ${timezone} || true"`
  );

  const lateCommandsYaml = lateCommands.length > 0
    ? `\n  late-commands:\n${lateCommands.join('\n')}`
    : '';

  const userData = `#cloud-config
autoinstall:
  version: 1

  # ─── CRITICAL: Suppress ALL interactive prompts ────────────
  # Without this, Ubuntu 23.04+ shows the setup wizard even with
  # autoinstall config present. Empty list = fully automated.
  interactive-sections: []

  # ─── Skip installer update prompt ──────────────────────────
  refresh-installer:
    update: false

  # ─── Locale & Keyboard ─────────────────────────────────────
  locale: ${locale}
  keyboard:
    layout: ${keyboardLayout}
    variant: ""

  # ─── Identity ──────────────────────────────────────────────
  identity:
    hostname: ${hostname}
    username: ${safeUsername}
    password: "${hashedPassword}"
    realname: "${fullName}"

  # ─── Network ───────────────────────────────────────────────
  network:
    version: 2
    ethernets:
      id0:
        match:
          driver: "*"
        dhcp4: true
        dhcp6: false

  # ─── Storage ───────────────────────────────────────────────
  storage:
    layout:
      name: lvm
      sizing-policy: all

  # ─── SSH ───────────────────────────────────────────────────
  ssh:
    install-server: true
    allow-pw: true

  # ─── Timezone ──────────────────────────────────────────────
  timezone: ${timezone}

  # ─── Packages ──────────────────────────────────────────────
  packages:
    - build-essential
    - curl
    - htop
    - net-tools
    - openssh-server${installGuestAdditions ? '\\n    - virtualbox-guest-utils\\n    - virtualbox-guest-x11' : ''}

  # ─── Early Commands (run before install starts) ────────────
  # Ensure autoinstall proceeds without waiting for confirmation
  early-commands:
    - "echo 'VM Xposed: Autoinstall starting...' > /dev/tty1 || true"
${lateCommandsYaml}

  # ─── User Data (post-first-boot) ──────────────────────────
  user-data:
    runcmd:
      - "modprobe vboxguest || true"
      - "modprobe vboxsf || true"
      - "modprobe vboxvideo || true"
`;

  logger.success('CloudInit', 'Autoinstall configuration generated');
  return userData;
}

/**
 * Generate meta-data file content.
 */
function generateMetaData(instanceId, hostname) {
  return `instance-id: ${instanceId}\nlocal-hostname: ${hostname}\n`;
}

/**
 * ─── Preseed Config Generator (Ubiquity / debian-installer) ──────────
 * For Ubuntu < 20.04 which uses the Ubiquity installer.
 * This preseed.cfg automates the full Ubiquity install wizard.
 */
function generatePreseedConfig(options = {}) {
  const {
    username = 'user',
    password = 'user',
    fullName = 'VM User',
    hostname = 'ubuntu-vm',
    locale = 'en_US.UTF-8',
    timezone = 'UTC',
    keyboardLayout = 'us'
  } = options;

  const lang = locale.split('.')[0] || 'en_US';

  return `# VM Xposed Preseed — Ubiquity Automated Install
# For Ubuntu desktop ISOs using the Ubiquity installer (< 20.04)

# ─── Locale & Language ─────────────────────────────────────────
d-i debian-installer/locale string ${lang}
d-i debian-installer/language string en
d-i debian-installer/country string US
d-i localechooser/supported-locales multiselect ${locale}

# ─── Keyboard ─────────────────────────────────────────────────
d-i keyboard-configuration/xkb-keymap select ${keyboardLayout}
d-i keyboard-configuration/layoutcode string ${keyboardLayout}
d-i keyboard-configuration/modelcode string pc105
d-i console-setup/ask_detect boolean false

# ─── Network ──────────────────────────────────────────────────
d-i netcfg/choose_interface select auto
d-i netcfg/get_hostname string ${hostname}
d-i netcfg/get_domain string local
d-i netcfg/hostname string ${hostname}

# ─── Clock & Timezone ────────────────────────────────────────
d-i clock-setup/utc boolean true
d-i time/zone string ${timezone}
d-i clock-setup/ntp boolean true

# ─── Partitioning (use entire disk, no LVM) ──────────────────
d-i partman-auto/method string regular
d-i partman-auto/choose_recipe select atomic
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverrides boolean true
d-i partman-lvm/confirm boolean true
d-i partman-lvm/confirm_nooverrides boolean true
d-i partman-md/confirm boolean true

# ─── User Account ────────────────────────────────────────────
d-i passwd/user-fullname string ${fullName}
d-i passwd/username string ${username}
d-i passwd/user-password password ${password}
d-i passwd/user-password-again password ${password}
d-i user-setup/allow-password-weak boolean true
d-i user-setup/encrypt-home boolean false

# ─── No root login ──────────────────────────────────────────
d-i passwd/root-login boolean false

# ─── Package Selection ──────────────────────────────────────
tasksel tasksel/first multiselect ubuntu-desktop
d-i pkgsel/include string openssh-server build-essential curl htop net-tools
d-i pkgsel/update-policy select unattended-upgrades
d-i pkgsel/upgrade select full-upgrade

# ─── Grub ────────────────────────────────────────────────────
d-i grub-installer/only_debian boolean true
d-i grub-installer/bootdev string default
d-i grub-installer/with_other_os boolean true

# ─── Finish ──────────────────────────────────────────────────
d-i finish-install/reboot_in_progress note

# ─── Ubiquity-specific ──────────────────────────────────────
ubiquity ubiquity/summary note
ubiquity ubiquity/reboot boolean true
ubiquity ubiquity/success_command string \\
  echo '[Desktop Entry]' > /target/etc/xdg/autostart/vboxclient.desktop; \\
  echo 'Type=Application' >> /target/etc/xdg/autostart/vboxclient.desktop; \\
  echo 'Name=VBoxClient' >> /target/etc/xdg/autostart/vboxclient.desktop; \\
  echo 'Exec=/usr/bin/VBoxClient-all' >> /target/etc/xdg/autostart/vboxclient.desktop; \\
  echo 'X-GNOME-Autostart-enabled=true' >> /target/etc/xdg/autostart/vboxclient.desktop; \\
  echo 'NoDisplay=true' >> /target/etc/xdg/autostart/vboxclient.desktop; \\
  in-target usermod -aG vboxsf ${username} 2>/dev/null || true; \\
  in-target usermod -aG video ${username} 2>/dev/null || true; \\
  mkdir -p /target/etc/gdm3 2>/dev/null || mkdir -p /target/etc/gdm 2>/dev/null || true; \\
  printf '[daemon]\\nAutomaticLoginEnable=true\\nAutomaticLogin=${username}\\n' > /target/etc/gdm3/custom.conf 2>/dev/null || \\
  printf '[daemon]\\nAutomaticLoginEnable=true\\nAutomaticLogin=${username}\\n' > /target/etc/gdm/custom.conf 2>/dev/null || true; \\
  in-target apt-get install -y virtualbox-guest-utils 2>/dev/null || true
`;
}

/**
 * Generate the shell script that the keyboard automation types into the terminal.
 * This script finds and mounts the preseed CD, then launches Ubiquity in automated mode.
 */
function generateAutoInstallScript(username, password) {
  // The script will:
  // 1. Find which /dev/sr* device has our preseed ISO (labeled RUNISO)
  // 2. Mount it
  // 3. Launch Ubiquity with the preseed file
  return [
    '#!/bin/bash',
    '# VM Xposed Automated Install',
    'FOUND=""',
    'for dev in /dev/sr1 /dev/sr0 /dev/cdrom1; do',
    '  mkdir -p /mnt/vmx 2>/dev/null',
    '  mount "$dev" /mnt/vmx 2>/dev/null && {',
    '    if [ -f /mnt/vmx/PRESEED.CFG ] || [ -f /mnt/vmx/preseed.cfg ]; then',
    '      FOUND="$dev"',
    '      break',
    '    fi',
    '    umount /mnt/vmx 2>/dev/null',
    '  }',
    'done',
    'if [ -z "$FOUND" ]; then',
    '  echo "VM Xposed: Preseed CD not found, retrying in 5s..."',
    '  sleep 5',
    '  for dev in /dev/sr1 /dev/sr0 /dev/cdrom1; do',
    '    mount "$dev" /mnt/vmx 2>/dev/null && {',
    '      if [ -f /mnt/vmx/PRESEED.CFG ] || [ -f /mnt/vmx/preseed.cfg ]; then',
    '        FOUND="$dev"',
    '        break',
    '      fi',
    '      umount /mnt/vmx 2>/dev/null',
    '    }',
    '  done',
    'fi',
    'if [ -n "$FOUND" ]; then',
    '  echo "VM Xposed: Found preseed on $FOUND, starting automated install..."',
    '  PFILE=$(ls /mnt/vmx/PRESEED.CFG /mnt/vmx/preseed.cfg 2>/dev/null | head -1)',
    '  sudo ubiquity -d --automatic --preseed "$PFILE" &',
    'else',
    '  echo "VM Xposed: No preseed found. Starting normal Ubiquity installer..."',
    '  ubiquity &',
    'fi',
  ].join('\n') + '\n';
}

/**
 * ─── ISO 9660 Image Generator ─────────────────────────────────────────
 * Creates a real ISO 9660 disc image containing cloud-init files.
 * VirtualBox can mount this as a standard DVD drive.
 * No external tools required — pure Node.js Buffer manipulation.
 */

const ISO_SECTOR_SIZE = 2048;

/** Pad a string to exactly `len` bytes, space-filled */
function padStr(str, len) {
  const buf = Buffer.alloc(len, 0x20); // space-filled
  buf.write(str.slice(0, len), 0, 'ascii');
  return buf;
}

/** Write a 32-bit value in both-endian (little + big) format */
function bothEndian32(val) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(val, 0);
  buf.writeUInt32BE(val, 4);
  return buf;
}

/** Write a 16-bit value in both-endian format */
function bothEndian16(val) {
  const buf = Buffer.alloc(4);
  buf.writeUInt16LE(val, 0);
  buf.writeUInt16BE(val, 2);
  return buf;
}

/** Create an ISO 9660 date/time for a volume descriptor */
function isoVDDateTime() {
  const now = new Date();
  const s = now.getFullYear().toString().padStart(4, '0') +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0') +
    now.getHours().toString().padStart(2, '0') +
    now.getMinutes().toString().padStart(2, '0') +
    now.getSeconds().toString().padStart(2, '0') +
    '00'; // hundredths
  const buf = Buffer.alloc(17);
  buf.write(s, 0, 'ascii');
  buf[16] = 0; // UTC offset in 15-min intervals
  return buf;
}

/** Create an ISO 9660 directory record date/time (7 bytes) */
function isoDirDateTime() {
  const now = new Date();
  const buf = Buffer.alloc(7);
  buf[0] = now.getFullYear() - 1900;
  buf[1] = now.getMonth() + 1;
  buf[2] = now.getDate();
  buf[3] = now.getHours();
  buf[4] = now.getMinutes();
  buf[5] = now.getSeconds();
  buf[6] = 0; // UTC offset
  return buf;
}

/**
 * Create a directory record entry.
 * @param {string} name - File/dir name (ISO 9660 format, e.g., "USER_DAT.;1")
 * @param {number} sector - Starting sector of the file data
 * @param {number} size - Size of the file data in bytes
 * @param {boolean} isDir - Whether this is a directory entry
 */
function createDirRecord(name, sector, size, isDir) {
  const nameBytes = name === '\x00' || name === '\x01'
    ? Buffer.from(name, 'binary')
    : Buffer.from(name, 'ascii');
  const recordLen = 33 + nameBytes.length + ((nameBytes.length % 2 === 0) ? 1 : 0); // Pad to even
  const buf = Buffer.alloc(recordLen, 0);

  buf[0] = recordLen;                            // Length of directory record
  buf[1] = 0;                                     // Extended attribute record length
  bothEndian32(sector).copy(buf, 2);              // Location of extent
  bothEndian32(size).copy(buf, 10);               // Data length
  isoDirDateTime().copy(buf, 18);                 // Recording date/time
  buf[25] = isDir ? 0x02 : 0x00;                  // File flags (directory bit)
  buf[26] = 0;                                     // File unit size
  buf[27] = 0;                                     // Interleave gap size
  bothEndian16(1).copy(buf, 28);                  // Volume sequence number
  buf[32] = nameBytes.length;                      // Length of file identifier
  nameBytes.copy(buf, 33);                         // File identifier

  return buf;
}

/**
 * Build a complete ISO 9660 image with cloud-init files.
 * Layout:
 *   Sectors 0-15:  System area (zeros)
 *   Sector 16:     Primary Volume Descriptor
 *   Sector 17:     Volume Descriptor Set Terminator
/**
 * Build a complete ISO 9660 image with arbitrary files.
 * Layout:
 *   Sectors 0-15:  System area (zeros)
 *   Sector 16:     Primary Volume Descriptor
 *   Sector 17:     Volume Descriptor Set Terminator
 *   Sector 18:     L-Path Table
 *   Sector 19:     M-Path Table
 *   Sector 20:     Root directory
 *   Sector 21+:    File data
 *
 * @param {Array<{name: string, content: string|Buffer}>} files - Files to include
 * @param {string} volumeId - Volume label (e.g., 'CIDATA', 'RUNISO')
 */
function buildDataIso(files, volumeId = 'CIDATA') {
  // Convert all content to buffers
  const fileBufs = files.map(f => ({
    // ISO 9660 Level 1 filename: uppercase, max 8.3, ";1" version
    isoName: f.name.replace(/[^A-Z0-9_.]/gi, '_').toUpperCase().slice(0, 8) + '.;1',
    buf: Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8')
  }));

  // Calculate sector layout
  const rootDirSector = 20;
  let nextSector = 21;
  const fileLayout = fileBufs.map(f => {
    const sectors = Math.ceil(f.buf.length / ISO_SECTOR_SIZE) || 1;
    const startSector = nextSector;
    nextSector += sectors;
    return { ...f, startSector, sectors };
  });
  const totalSectors = nextSector;

  const iso = Buffer.alloc(totalSectors * ISO_SECTOR_SIZE, 0);

  // ─── Primary Volume Descriptor (Sector 16) ─────────────────────
  const pvd = Buffer.alloc(ISO_SECTOR_SIZE, 0);
  pvd[0] = 1;
  pvd.write('CD001', 1, 'ascii');
  pvd[6] = 1;
  padStr('', 32).copy(pvd, 8);
  padStr(volumeId, 32).copy(pvd, 40);
  bothEndian32(totalSectors).copy(pvd, 80);
  bothEndian16(1).copy(pvd, 120);
  bothEndian16(1).copy(pvd, 124);
  bothEndian16(ISO_SECTOR_SIZE).copy(pvd, 128);

  const pathTableSize = 10;
  bothEndian32(pathTableSize).copy(pvd, 132);
  pvd.writeUInt32LE(18, 140);
  pvd.writeUInt32BE(19, 148);

  const rootRecordForPVD = createDirRecord('\x01', rootDirSector, ISO_SECTOR_SIZE, true);
  rootRecordForPVD.copy(pvd, 156);

  padStr('', 128).copy(pvd, 190);
  padStr('VM XPOSED', 128).copy(pvd, 318);
  padStr('', 128).copy(pvd, 446);
  padStr('VM XPOSED AUTOINSTALL', 128).copy(pvd, 574);

  isoVDDateTime().copy(pvd, 813);
  isoVDDateTime().copy(pvd, 830);
  Buffer.alloc(17, 0x30).copy(pvd, 847);
  isoVDDateTime().copy(pvd, 864);
  pvd[881] = 1;
  pvd.copy(iso, 16 * ISO_SECTOR_SIZE);

  // ─── Volume Descriptor Set Terminator (Sector 17) ──────────────
  const vdst = Buffer.alloc(ISO_SECTOR_SIZE, 0);
  vdst[0] = 255;
  vdst.write('CD001', 1, 'ascii');
  vdst[6] = 1;
  vdst.copy(iso, 17 * ISO_SECTOR_SIZE);

  // ─── L-Path Table (Sector 18) ──────────────────────────────────
  const lpt = Buffer.alloc(ISO_SECTOR_SIZE, 0);
  lpt[0] = 1; lpt[1] = 0;
  lpt.writeUInt32LE(rootDirSector, 2);
  lpt.writeUInt16LE(1, 6);
  lpt[8] = 0x01;
  lpt.copy(iso, 18 * ISO_SECTOR_SIZE);

  // ─── M-Path Table (Sector 19) ──────────────────────────────────
  const mpt = Buffer.alloc(ISO_SECTOR_SIZE, 0);
  mpt[0] = 1; mpt[1] = 0;
  mpt.writeUInt32BE(rootDirSector, 2);
  mpt.writeUInt16BE(1, 6);
  mpt[8] = 0x01;
  mpt.copy(iso, 19 * ISO_SECTOR_SIZE);

  // ─── Root Directory (Sector 20) ────────────────────────────────
  const rootDir = Buffer.alloc(ISO_SECTOR_SIZE, 0);
  let offset = 0;

  const dotRec = createDirRecord('\x00', rootDirSector, ISO_SECTOR_SIZE, true);
  dotRec.copy(rootDir, offset); offset += dotRec.length;

  const dotDotRec = createDirRecord('\x01', rootDirSector, ISO_SECTOR_SIZE, true);
  dotDotRec.copy(rootDir, offset); offset += dotDotRec.length;

  for (const file of fileLayout) {
    const rec = createDirRecord(file.isoName, file.startSector, file.buf.length, false);
    rec.copy(rootDir, offset); offset += rec.length;
  }

  rootDir.copy(iso, rootDirSector * ISO_SECTOR_SIZE);

  // ─── File Data ─────────────────────────────────────────────────
  for (const file of fileLayout) {
    file.buf.copy(iso, file.startSector * ISO_SECTOR_SIZE);
  }

  return iso;
}

/** Wrapper: build a cloud-init ISO (CIDATA volume with user-data + meta-data) */
function buildCloudInitIso(userDataContent, metaDataContent) {
  return buildDataIso([
    { name: 'user-data', content: userDataContent },
    { name: 'meta-data', content: metaDataContent }
  ], 'CIDATA');
}

/** Build a preseed ISO (RUNISO volume with preseed.cfg + install.sh) */
function buildPreseedIso(preseedContent, installScript) {
  const files = [
    { name: 'preseed.cfg', content: preseedContent }
  ];
  if (installScript) {
    files.push({ name: 'install.sh', content: installScript });
  }
  return buildDataIso(files, 'RUNISO');
}

/**
 * Detect if an Ubuntu version supports Subiquity autoinstall (cloud-init).
 * Subiquity was introduced in Ubuntu 20.04 (server) and became the default
 * desktop installer in 23.04+. For 20.04-22.10, it works on server ISOs
 * and some desktop ISOs.
 *
 * Returns false for Ubuntu < 20.04 (they use Ubiquity with preseed).
 */
function isSubiquityUbuntu(isoPath, osType) {
  // Extract version number from ISO filename or path
  const versionMatch = String(isoPath || '').match(/ubuntu[^0-9]*(\d+\.\d+)/i);
  if (!versionMatch) {
    // If we can't extract version, check osType
    return /ubuntu/i.test(osType || '');
  }
  const version = parseFloat(versionMatch[1]);
  return version >= 20.04;
}

/**
 * Write cloud-init files and create a real ISO 9660 image.
 * Returns the path to the generated .iso file.
 */
async function createCloudInitIso(vmDir, options = {}) {
  const ciDir = path.join(vmDir, 'cloud-init');
  await fs.promises.mkdir(ciDir, { recursive: true });

  // Generate cloud-init data
  const userData = generateUserData(options);
  const metaData = generateMetaData(
    `vm-${Date.now()}`,
    options.hostname || 'ubuntu-vm'
  );

  // Write human-readable copies for debugging
  const userDataPath = path.join(ciDir, 'user-data');
  const metaDataPath = path.join(ciDir, 'meta-data');
  await fs.promises.writeFile(userDataPath, userData, 'utf8');
  await fs.promises.writeFile(metaDataPath, metaData, 'utf8');
  logger.info('CloudInit', `Written user-data to: ${userDataPath}`);
  logger.info('CloudInit', `Written meta-data to: ${metaDataPath}`);

  // Build a real ISO 9660 image
  const isoBuf = buildCloudInitIso(userData, metaData);
  const isoPath = path.join(ciDir, 'cloud-init-seed.iso');
  await fs.promises.writeFile(isoPath, isoBuf);

  logger.success('CloudInit', `ISO created: ${isoPath} (${isoBuf.length} bytes)`);
  return isoPath;
}

/**
 * Attach a cloud-init ISO to a VM as a secondary DVD drive.
 * Uses the existing IDE controller's second port (where the install ISO is on port 0).
 */
async function attachIsoToVM(vmName, isoPath, virtualbox) {
  logger.info('CloudInit', `Attaching cloud-init ISO to "${vmName}"...`);

  // Strategy: The install ISO is on "IDE Controller" port 0, device 0.
  // We attach the cloud-init ISO on IDE Controller port 1, device 0.
  // If that fails, try SATA Controller port 1.
  const attempts = [
    { ctrl: 'IDE Controller', port: '1', device: '0' },
    { ctrl: 'SATA Controller', port: '1', device: '0' },
  ];

  for (const { ctrl, port, device } of attempts) {
    try {
      await virtualbox._run([
        'storageattach', vmName,
        '--storagectl', ctrl,
        '--port', port,
        '--device', device,
        '--type', 'dvddrive',
        '--medium', isoPath
      ]);
      logger.success('CloudInit', `ISO attached on ${ctrl} port ${port} device ${device}`);
      return true;
    } catch (err) {
      logger.debug('CloudInit', `Failed to attach on ${ctrl} port ${port}: ${err.message}`);
    }
  }

  // Last resort: add a second SATA port for the cloud-init ISO
  try {
    // Increase SATA port count to allow a second DVD
    await virtualbox._run([
      'storagectl', vmName,
      '--name', 'SATA Controller',
      '--portcount', '3'
    ]).catch(() => {});

    await virtualbox._run([
      'storageattach', vmName,
      '--storagectl', 'SATA Controller',
      '--port', '2',
      '--device', '0',
      '--type', 'dvddrive',
      '--medium', isoPath
    ]);
    logger.success('CloudInit', 'ISO attached on SATA Controller port 2');
    return true;
  } catch (err) {
    logger.error('CloudInit', `Failed to attach cloud-init ISO: ${err.message}`);
    throw new Error(`Could not attach cloud-init ISO to VM: ${err.message}`);
  }
}

/**
 * Full cloud-init fallback pipeline:
 * 1. Generate autoinstall config
 * 2. Create real ISO 9660 image
 * 3. Attach ISO to VM as secondary DVD
 *
 * Only works for Ubuntu 20.04+ (Subiquity). Older Ubuntu uses Ubiquity/preseed.
 * Call this when VBox unattendedInstall fails with ConstructMedia.
 */
async function applyCloudInitFallback(vmName, vmDir, virtualbox, options = {}) {
  logger.info('CloudInit', `═══ Applying Cloud-Init Fallback for "${vmName}" ═══`);

  try {
    const isoPath = await createCloudInitIso(vmDir, {
      hostname: options.hostname || vmName.replace(/\s+/g, '-').toLowerCase(),
      username: options.username || 'guest',
      password: options.password || 'guest',
      fullName: options.fullName || options.username || 'VM User',
      locale: options.locale || 'en_US.UTF-8',
      timezone: options.timezone || 'UTC',
      keyboardLayout: options.keyboardLayout || 'us',
      installGuestAdditions: true,
      enableSharedFolder: options.enableSharedFolder !== false,
      disableScreenLock: true,
      enableAutoLogin: true,
      disableWayland: true
    });

    await attachIsoToVM(vmName, isoPath, virtualbox);

    // Inject autoinstall kernel boot parameter for Ubuntu 23.04+
    try {
      await virtualbox._run(['setextradata', vmName, 'VBoxInternal/Devices/efi/0/Config/AdditionalEnv', 'GRUB_CMDLINE_LINUX_DEFAULT=autoinstall ds=nocloud quiet splash']);
      logger.info('CloudInit', 'Injected autoinstall kernel param via EFI config');
    } catch (efiErr) { logger.debug('CloudInit', 'EFI param injection skipped: ' + efiErr.message); }
    try {
      await virtualbox._run(['setextradata', vmName, 'VBoxInternal2/LinuxBootArgs', 'autoinstall ds=nocloud']);
    } catch (bootErr) { logger.debug('CloudInit', 'LinuxBootArgs skipped: ' + bootErr.message); }
    try {
      await virtualbox._run(['modifyvm', vmName, '--boot1', 'dvd', '--boot2', 'disk', '--boot3', 'none', '--boot4', 'none']);
    } catch (e) {}

    logger.success('CloudInit', '═══ Cloud-Init Fallback Applied ═══');
    logger.info('CloudInit', 'Ubuntu will detect the autoinstall config and install fully automated.');
    return { success: true, isoPath };
  } catch (err) {
    logger.error('CloudInit', `Cloud-init fallback failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * ─── Preseed Fallback for Ubiquity (Ubuntu < 20.04) ──────────────────
 * Creates a dual-purpose cloud-init + preseed ISO.
 * 
 * Strategy (100% file-based, no keyboard/mouse):
 * 1. Create an ISO with label "cidata" (cloud-init NoCloud data source)
 * 2. Include user-data with runcmd that auto-launches:
 *    `ubiquity --automatic --preseed /tmp/vmxposed-preseed.cfg`
 * 3. Include the preseed.cfg as a write_files entry
 * 4. Cloud-init runs in the Ubuntu live session and triggers the install
 * 
 * Ubuntu 18.04 Desktop has cloud-init installed by default.
 * When cloud-init finds the cidata disk, it executes our commands.
 */
async function createPreseedIso(vmDir, options = {}) {
  const ciDir = path.join(vmDir, 'cloud-init');
  await fs.promises.mkdir(ciDir, { recursive: true });

  const preseedContent = generatePreseedConfig(options);
  let username = options.username || 'guest';
  let password = options.password || 'guest';

  // Write human-readable copy for debugging
  await fs.promises.writeFile(path.join(ciDir, 'preseed.cfg'), preseedContent, 'utf8');
  logger.info('CloudInit', `Written preseed.cfg to: ${path.join(ciDir, 'preseed.cfg')}`);

  // Build a cloud-init user-data that auto-launches Ubiquity with preseed
  // This runs inside the live session via cloud-init's runcmd
  const escapedPreseed = preseedContent.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  
  const userData = [
    '#cloud-config',
    '# VM Xposed: Auto-launch Ubiquity installer with preseed (file-based)',
    '# This runs in the Ubuntu live session — no keyboard/mouse needed.',
    '',
    'write_files:',
    '  - path: /tmp/vmxposed-preseed.cfg',
    '    permissions: "0644"',
    '    content: |',
    ...preseedContent.split('\n').map(line => `      ${line}`),
    '',
    '  - path: /tmp/vmxposed-autoinstall.sh',
    '    permissions: "0755"',
    '    content: |',
    '      #!/bin/bash',
    '      # VM Xposed: Robust auto-launch Ubiquity with preseed',
    '      # Handles slow VMs, multiple desktop environments, X auth',
    '      LOG=/tmp/vmxposed-install.log',
    '      echo "[$(date)] VM Xposed auto-install starting..." > $LOG',
    '      ',
    '      # Run everything in a subshell detached from cloud-init',
    '      (',
    '      # Wait for X display (up to 120s for slow VMs)',
    '      for i in $(seq 1 60); do',
    '        if [ -e /tmp/.X11-unix/X0 ] || [ -e /tmp/.X0-lock ]; then',
    '          echo "[$(date)] X display found (try $i)" >> $LOG',
    '          break',
    '        fi',
    '        sleep 2',
    '      done',
    '      sleep 10  # Extra wait for desktop to fully load',
    '      ',
    '      # Set up display environment',
    '      export DISPLAY=:0',
    '      export DEBIAN_FRONTEND=noninteractive',
    '      for xa in /home/ubuntu/.Xauthority /root/.Xauthority /var/run/lightdm/root/:0; do',
    '        [ -f "$xa" ] && export XAUTHORITY="$xa" && break',
    '      done',
    '      ',
    '      # Kill the Try/Install Ubuntu dialog (Ubiquity GUI)',
    '      for attempt in $(seq 1 8); do',
    '        PIDS=$(pgrep -f ubiquity 2>/dev/null)',
    '        if [ -n "$PIDS" ]; then',
    '          echo "[$(date)] Killing Ubiquity PIDs: $PIDS" >> $LOG',
    '          kill -9 $PIDS 2>/dev/null',
    '          sleep 2',
    '          pkill -9 -f ubiquity 2>/dev/null',
    '          break',
    '        fi',
    '        echo "[$(date)] Ubiquity not found yet ($attempt/8)" >> $LOG',
    '        sleep 5',
    '      done',
    '      sleep 3',
    '      ',
    '      # Launch Ubiquity in fully automatic mode',
    '      echo "[$(date)] Launching ubiquity --automatic" >> $LOG',
    '      sudo -E ubiquity -d --automatic --preseed /tmp/vmxposed-preseed.cfg >> $LOG 2>&1 &',
    '      echo "[$(date)] Ubiquity launched (PID: $!)" >> $LOG',
    '      ) &  # End of detached subshell',
    '',
    'runcmd:',
    '  - ["bash", "-c", "nohup bash /tmp/vmxposed-autoinstall.sh &"]',
  ].join('\n') + '\n';

  const metaData = `instance-id: vmxposed-preseed-${Date.now()}\nlocal-hostname: ${options.hostname || 'ubuntu-vm'}\n`;

  // Write debug copies
  await fs.promises.writeFile(path.join(ciDir, 'user-data'), userData, 'utf8');
  await fs.promises.writeFile(path.join(ciDir, 'meta-data'), metaData, 'utf8');

  // Build ISO with cidata label (cloud-init picks this up)
  const isoBuf = buildCloudInitIso(userData, metaData);
  const isoPath = path.join(ciDir, 'preseed-seed.iso');
  await fs.promises.writeFile(isoPath, isoBuf);

  logger.success('CloudInit', `Preseed trigger ISO created: ${isoPath} (${isoBuf.length} bytes)`);
  return isoPath;
}

async function applyPreseedFallback(vmName, vmDir, virtualbox, options = {}) {
  logger.info('CloudInit', `═══ Applying Preseed Fallback for "${vmName}" (Ubiquity — file-based) ═══`);

  try {
    // CRITICAL: Re-attach the main Ubuntu ISO to IDE port 0.
    // VBox unattendedInstall() may eject it when it fails, leaving the DVD drive empty.
    if (options.mainIsoPath) {
      logger.info('CloudInit', `Re-attaching main ISO: ${path.basename(options.mainIsoPath)}`);
      try {
        await virtualbox._run([
          'storageattach', vmName,
          '--storagectl', 'IDE Controller',
          '--port', '0', '--device', '0',
          '--type', 'dvddrive',
          '--medium', options.mainIsoPath
        ]);
        logger.success('CloudInit', 'Main ISO re-attached on IDE Controller port 0.');
      } catch (ideErr) {
        try {
          await virtualbox._run([
            'storageattach', vmName,
            '--storagectl', 'SATA Controller',
            '--port', '0', '--device', '0',
            '--type', 'dvddrive',
            '--medium', options.mainIsoPath
          ]);
          logger.success('CloudInit', 'Main ISO re-attached on SATA Controller port 0.');
        } catch (sataErr) {
          logger.warn('CloudInit', `Could not re-attach main ISO: ${sataErr.message}`);
        }
      }
    }

    const isoPath = await createPreseedIso(vmDir, {
      hostname: options.hostname || vmName.replace(/\s+/g, '-').toLowerCase(),
      username: options.username || 'guest',
      password: options.password || 'guest',
      fullName: options.fullName || options.username || 'VM User',
      locale: options.locale || 'en_US.UTF-8',
      timezone: options.timezone || 'UTC',
      keyboardLayout: options.keyboardLayout || 'us'
    });

    await attachIsoToVM(vmName, isoPath, virtualbox);

    // Try to inject automatic-ubiquity kernel param (best-effort)
    // This tells Ubiquity to skip the "Try/Install" dialog
    try {
      await virtualbox._run(['setextradata', vmName, 
        'VBoxInternal/Devices/pcbios/0/Config/DmiSystemProduct', 
        'automatic-ubiquity noprompt']);
    } catch {}
    try {
      // For EFI-based VMs
      await virtualbox._run(['setextradata', vmName,
        'VBoxInternal/Devices/efi/0/Config/AdditionalEnv',
        'GRUB_CMDLINE_LINUX_DEFAULT=automatic-ubiquity noprompt file=/cdrom/preseed/ubuntu.seed quiet splash']);
    } catch {}
    try {
      await virtualbox._run(['modifyvm', vmName, '--boot1', 'dvd', '--boot2', 'disk', '--boot3', 'none', '--boot4', 'none']);
    } catch {}

    logger.success('CloudInit', '═══ Preseed Fallback Applied (file-based) ═══');
    logger.info('CloudInit', 'Cloud-init trigger ISO will auto-launch Ubiquity with preseed. No keyboard/mouse needed.');
    return { success: true, isoPath };
  } catch (err) {
    logger.error('CloudInit', `Preseed fallback failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * ─── Keyboard Scancode Injection ─────────────────────────────────────
 * Send keyboard input to a running VM via VBoxManage controlvm keyboardputscancode.
 * Used to automate the Ubiquity installer in the live Ubuntu session.
 */

// Make/break scancodes for common keys
const SCANCODES = {
  // Key: [make, break] (press, release)
  ENTER:  ['1c', '9c'],
  TAB:    ['0f', '8f'],
  SPACE:  ['39', 'b9'],
  ESC:    ['01', '81'],
  // Modifier keys
  LCTRL:  ['1d', '9d'],
  LALT:   ['38', 'b8'],
  LSHIFT: ['2a', 'aa'],
  // Special keys
  F2:     ['3c', 'bc'],
  // Letters (lowercase)
  a:'1e',b:'30',c:'2e',d:'20',e:'12',f:'21',g:'22',h:'23',i:'17',j:'24',k:'25',l:'26',
  m:'32',n:'31',o:'18',p:'19',q:'10',r:'13',s:'1f',t:'14',u:'16',v:'2f',w:'11',x:'2d',
  y:'15',z:'2c',
  // Numbers
  '1':'02','2':'03','3':'04','4':'05','5':'06','6':'07','7':'08','8':'09','9':'0a','0':'0b',
  // Symbols
  '-':'0c', '=':'0d', '/':'35', '.':'34', ',':'33', ';':'27', ' ':'39', '\'':'28',
  '[':'1a', ']':'1b', '\\':'2b',
  BACKSPACE: ['0e', '8e'],
};

// Characters that need shift key
const SHIFT_CHARS = {
  '!':'02','@':'03','#':'04','$':'05','%':'06','^':'07','&':'08','*':'09','(':'0a',')':'0b',
  '_':'0c','+':'0d','|':'2b','{':'1a','}':'1b',':':'27','"':'28','<':'33','>':'34','?':'35',
  '~':'29',
};

/** Convert a character to scancodes (make+break), handling shift */
function charToScancodes(ch) {
  // Uppercase letter
  if (/[A-Z]/.test(ch)) {
    const code = SCANCODES[ch.toLowerCase()];
    if (code) return [SCANCODES.LSHIFT[0], code, parseInt(code, 16) | 0x80 ? (parseInt(code, 16) + 0x80).toString(16) : `${code}`, SCANCODES.LSHIFT[1]].join(' ');
  }
  // Shifted symbol
  if (SHIFT_CHARS[ch]) {
    const code = SHIFT_CHARS[ch];
    const release = (parseInt(code, 16) + 0x80).toString(16);
    return `${SCANCODES.LSHIFT[0]} ${code} ${release} ${SCANCODES.LSHIFT[1]}`;
  }
  // Normal char
  const code = SCANCODES[ch];
  if (code) {
    if (Array.isArray(code)) return code.join(' ');
    const release = (parseInt(code, 16) + 0x80).toString(16);
    return `${code} ${release}`;
  }
  return null;
}

/** Convert a string to a sequence of scancode hex strings */
function stringToScancodes(str) {
  const codes = [];
  for (const ch of str) {
    const sc = charToScancodes(ch);
    if (sc) codes.push(sc);
  }
  return codes;
}

/** Send a key combo like Ctrl+Alt+T */
function comboScancodes(modifiers, key) {
  const make = modifiers.map(m => SCANCODES[m][0]).join(' ');
  const keyMake = Array.isArray(SCANCODES[key]) ? SCANCODES[key][0] : SCANCODES[key];
  const keyBreak = Array.isArray(SCANCODES[key]) ? SCANCODES[key][1] : (parseInt(SCANCODES[key], 16) + 0x80).toString(16);
  const release = modifiers.map(m => SCANCODES[m][1]).reverse().join(' ');
  return `${make} ${keyMake} ${keyBreak} ${release}`;
}

/**
 * Send keyboard scancodes to a running VM.
 * Breaks into chunks of max 16 codes per VBoxManage call.
 */
async function sendScancodes(vmName, scancodeStr, virtualbox) {
  const codes = scancodeStr.trim().split(/\s+/);
  // VBoxManage accepts up to ~16 scancodes at once
  for (let i = 0; i < codes.length; i += 16) {
    const chunk = codes.slice(i, i + 16);
    await virtualbox._run(['controlvm', vmName, 'keyboardputscancode', ...chunk]);
  }
}

/** Helper: sleep for ms milliseconds */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Automate the Ubiquity installer on legacy Ubuntu (< 20.04).
 *
 * Instead of trying to open a terminal (Ctrl+Alt+T doesn't exist on GNOME 2),
 * this directly navigates the installer using Tab/Enter scancodes:
 *
 *   1. "Try Ubuntu / Install Ubuntu" dialog → Tab + Enter to click "Install"
 *   2. Each wizard page → Tab to "Forward/Continue" button, Enter to proceed
 *   3. User info page → Type username and password
 *   4. Confirm partitioning → Enter
 *
 * This is version-agnostic enough to work across Ubuntu 10.04 – 19.10.
 * The timing-based approach is inherently best-effort — some steps may need
 * manual interaction on very slow machines, but this handles 90% of cases.
 */
async function sendAutomatedInstallKeystrokes(vmName, virtualbox, options = {}) {
  const {
    bootWaitMs = 35000,
    username = 'user',
    password = 'user',
    hostname = 'ubuntu-vm'
  } = options;

  const pressKey = async (key, delayAfter = 500) => {
    const sc = SCANCODES[key];
    if (Array.isArray(sc)) {
      await sendScancodes(vmName, sc.join(' '), virtualbox);
    }
    await sleep(delayAfter);
  };

  const pressTab = async (n = 1, delayAfter = 300) => {
    for (let i = 0; i < n; i++) {
      await pressKey('TAB', delayAfter);
    }
  };

  const pressEnter = (delayAfter = 1000) => pressKey('ENTER', delayAfter);
  const pressSpace = (delayAfter = 500) => pressKey('SPACE', delayAfter);

  const typeString = async (str, delayBetween = 60) => {
    const scList = stringToScancodes(str);
    for (const sc of scList) {
      await sendScancodes(vmName, sc, virtualbox);
      await sleep(delayBetween);
    }
  };

  logger.info('CloudInit', '═══ Ubiquity Keyboard Automation ═══');
  logger.info('CloudInit', `Waiting ${Math.round(bootWaitMs / 1000)}s for Ubuntu live desktop...`);
  await sleep(bootWaitMs);

  try {
    // ─── Step 1: "Try Ubuntu / Install Ubuntu" Dialog ────────────────
    // Focus starts on the language list. Tab×3 reaches "Install Ubuntu".
    // PROVEN via live testing on Ubuntu 10.04.
    logger.info('CloudInit', '[Step 1] Clicking "Install Ubuntu" (Tab×3 → Enter)...');
    await pressTab(3, 500);
    await pressEnter(8000); // Wait for Ubiquity installer to fully load

    // ─── Steps 2-4: Wizard Pages ─────────────────────────────────────
    // PROVEN: Forward/Continue is the DEFAULT button in Ubiquity.
    // Just pressing Enter (no Tab) advances each page.
    //
    // Ubuntu 10.04 page order after clicking Install:
    //   Page 1: Timezone ("Where are you?")
    //   Page 2: Keyboard Layout
    //   Page 3: Disk Partitioning ("Erase disk" is default)
    //   Confirmation dialog
    //   Page 4: User Info ("Who are you?")

    logger.info('CloudInit', '[Step 2] Timezone → Forward (Enter)...');
    await pressEnter(5000);

    logger.info('CloudInit', '[Step 3] Keyboard layout → Forward (Enter)...');
    await pressEnter(5000);

    logger.info('CloudInit', '[Step 4] Disk partitioning → Install Now (Enter)...');
    await pressEnter(3000);

    logger.info('CloudInit', '[Step 4b] Confirming disk changes (Enter)...');
    await pressEnter(5000);

    // ─── Step 5: User Info Page ──────────────────────────────────────
    // Fields: "What is your name?" → "Username" → "Password" → "Confirm" → "Computer Name"
    // Focus starts on "What is your name?" field.
    logger.info('CloudInit', '[Step 5] Filling user info...');

    // Type the display name (first field is focused)
    await typeString(username, 80);
    await sleep(800); // Wait for auto-fill to populate other fields

    // Tab to "Username" field (auto-filled, but we overwrite to be safe)
    await pressTab(1, 300);
    // Select all and overwrite
    await sendScancodes(vmName, comboScancodes(['LCTRL'], 'a'), virtualbox);
    await sleep(100);
    await typeString(username, 80);
    await sleep(500);

    // Tab to Password field
    await pressTab(1, 300);
    await typeString(password, 80);
    await sleep(300);

    // Tab to Confirm Password field
    await pressTab(1, 300);
    await typeString(password, 80);
    await sleep(500);

    // Tab to Computer Name field
    await pressTab(1, 300);
    await sendScancodes(vmName, comboScancodes(['LCTRL'], 'a'), virtualbox);
    await sleep(100);
    await typeString(hostname, 80);
    await sleep(500);

    // Press Enter — Forward button is the default, just Enter works
    logger.info('CloudInit', '[Step 5] Submitting user info (Enter)...');
    await pressEnter(3000);

    logger.success('CloudInit', '═══ Ubiquity Automation Complete ═══');
    logger.info('CloudInit', 'Ubuntu is now installing. VM will reboot to a ready-to-use desktop when done.');
    return { success: true };
  } catch (err) {
    logger.error('CloudInit', `Keyboard automation failed: ${err.message}`);
    logger.info('CloudInit', 'VM is still running — user can finish remaining steps in the VM window.');
    return { success: false, error: err.message };
  }
}


/**
 * ─── GRUB Boot Parameter Injection ──────────────────────────────────
 * After the VM starts, edits the GRUB boot entry to add 'autoinstall ds=nocloud'
 * to the kernel command line. This is the MOST RELIABLE way to ensure autoinstall
 * works in VirtualBox, since setextradata-based kernel param injection is buggy.
 *
 * Flow:
 * 1. Wait for GRUB menu to appear (~5s)
 * 2. Press 'e' to edit the default entry
 * 3. Navigate down to the 'linux' line
 * 4. Press End to go to end of line
 * 5. Type ' autoinstall ds=nocloud\\;s=/cdrom/'
 * 6. Press Ctrl+X to boot with modified params
 */
async function injectAutoinstallViaGrub(vmName, virtualbox) {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));
  
  const sendSC = async (codes) => {
    await virtualbox._run(['controlvm', vmName, 'keyboardputscancode', ...codes.split(' ')]);
  };
  
  logger.info('CloudInit', '═══ Injecting autoinstall via GRUB edit ═══');
  
  // Wait for GRUB menu to appear.
  // BIOS/EFI POST takes ~2-4 seconds, then GRUB appears.
  // GRUB's auto-boot timeout is typically 10 seconds.
  // We must press 'e' BEFORE the timeout expires.
  logger.info('CloudInit', 'Waiting 4s for GRUB menu to appear...');
  await _sleep(4000);
  
  // Try multiple times in case the first attempt is too early
  // (VM might still be in BIOS POST or GRUB hasn't rendered yet)
  let injected = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logger.info('CloudInit', `GRUB edit attempt ${attempt}/3...`);
      
      // First, press Escape or any key to stop GRUB auto-boot countdown
      // This ensures GRUB stays on screen even if we're slow
      await sendSC('01 81');  // ESC press/release — stops GRUB countdown
      await _sleep(500);
      
      // Press 'e' to edit GRUB entry (scancode: 12 92)
      logger.info('CloudInit', 'Pressing "e" to edit GRUB entry...');
      await sendSC('12 92');
      await _sleep(1500);
      
      // Press Down arrow to navigate to the 'linux' line
      // GRUB edit screen typically has:
      //   line 1: setparams 'Try or Install Ubuntu'
      //   line 2: set gfxpayload=keep  
      //   line 3: linux /casper/vmlinuz ... quiet splash ---
      //   line 4: initrd /casper/initrd
      // Navigate down 4 times to be safe (handles varying GRUB configs)
      logger.info('CloudInit', 'Navigating to linux line (Down x4)...');
      for (let i = 0; i < 4; i++) {
        await sendSC('e0 50 e0 d0');  // Down arrow (extended key)
        await _sleep(200);
      }
      
      // Press End key to go to end of the linux line
      logger.info('CloudInit', 'Moving to end of line (End)...');
      await sendSC('e0 4f e0 cf');
      await _sleep(300);
      
      // Type ' autoinstall' at the end of the linux line
      // Also remove '---' by backspacing 3 chars first (Ubuntu adds --- which blocks params)
      logger.info('CloudInit', 'Removing trailing "---" (Backspace x4)...');
      for (let i = 0; i < 4; i++) {
        await sendSC('0e 8e');  // Backspace
        await _sleep(50);
      }
      
      const textToType = ' autoinstall ds=nocloud';
      logger.info('CloudInit', `Typing "${textToType}"...`);
      
      // Space
      await sendSC('39 b9'); await _sleep(50);
      // a
      await sendSC('1e 9e'); await _sleep(50);
      // u
      await sendSC('16 96'); await _sleep(50);
      // t
      await sendSC('14 94'); await _sleep(50);
      // o
      await sendSC('18 98'); await _sleep(50);
      // i
      await sendSC('17 97'); await _sleep(50);
      // n
      await sendSC('31 b1'); await _sleep(50);
      // s
      await sendSC('1f 9f'); await _sleep(50);
      // t
      await sendSC('14 94'); await _sleep(50);
      // a
      await sendSC('1e 9e'); await _sleep(50);
      // l
      await sendSC('26 a6'); await _sleep(50);
      // l
      await sendSC('26 a6'); await _sleep(50);
      // Space
      await sendSC('39 b9'); await _sleep(50);
      // d
      await sendSC('20 a0'); await _sleep(50);
      // s
      await sendSC('1f 9f'); await _sleep(50);
      // = (0d 8d)
      await sendSC('0d 8d'); await _sleep(50);
      // n
      await sendSC('31 b1'); await _sleep(50);
      // o
      await sendSC('18 98'); await _sleep(50);
      // c
      await sendSC('2e ae'); await _sleep(50);
      // l
      await sendSC('26 a6'); await _sleep(50);
      // o
      await sendSC('18 98'); await _sleep(50);
      // u
      await sendSC('16 96'); await _sleep(50);
      // d
      await sendSC('20 a0'); await _sleep(50);
      
      await _sleep(200);
      
      // Press Ctrl+X to boot with modified parameters
      // Ctrl press: 1d, x press: 2d, x release: ad, Ctrl release: 9d
      logger.info('CloudInit', 'Pressing Ctrl+X to boot with autoinstall param...');
      await sendSC('1d 2d ad 9d');
      
      injected = true;
      break;
    } catch (err) {
      logger.warn('CloudInit', `GRUB edit attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        await _sleep(2000);
      }
    }
  }
  
  if (injected) {
    logger.success('CloudInit', '═══ GRUB autoinstall injection complete ═══');
    logger.info('CloudInit', 'Ubuntu will now boot with autoinstall parameter. The "Try/Install" dialog will be skipped.');
  } else {
    logger.warn('CloudInit', 'GRUB injection could not be confirmed. Ubuntu may show the Try/Install dialog.');
  }
}

module.exports = {
  generateUserData,
  generateMetaData,
  generatePreseedConfig,
  generateAutoInstallScript,
  buildDataIso,
  buildCloudInitIso,
  buildPreseedIso,
  writeCloudInitFiles: async function(outputDir, options) {
    await fs.promises.mkdir(outputDir, { recursive: true });
    const userDataPath = path.join(outputDir, 'user-data');
    const metaDataPath = path.join(outputDir, 'meta-data');
    const userData = generateUserData(options);
    const metaData = generateMetaData(`vm-${Date.now()}`, options.hostname || 'ubuntu-vm');
    await fs.promises.writeFile(userDataPath, userData, 'utf8');
    await fs.promises.writeFile(metaDataPath, metaData, 'utf8');
    return { userDataPath, metaDataPath };
  },
  createCloudInitIso,
  createPreseedIso,
  attachIsoToVM,
  applyCloudInitFallback,
  applyPreseedFallback,
  sendAutomatedInstallKeystrokes,
  injectAutoinstallViaGrub,
  isSubiquityUbuntu,
  hashPassword
};
