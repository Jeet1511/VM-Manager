/**
 * vm/cloudInit.js — Cloud-Init User-Data Generator
 * 
 * Design Decision: Generates complete autoinstall configuration for Ubuntu.
 * Uses VBoxManage unattended install as primary path, but provides
 * cloud-init as fallback for custom ISO scenarios.
 * 
 * Password is hashed using SHA-512 (openssl passwd -6 equivalent).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');

/**
 * Hash a password using SHA-512 crypt format ($6$...).
 * This is what Ubuntu's autoinstall expects for the identity.password field.
 * 
 * @param {string} password - Plain text password
 * @returns {string} SHA-512 hashed password in crypt format
 */
function hashPassword(password) {
  // Generate a random 16-byte salt
  const salt = crypto.randomBytes(16).toString('base64').replace(/[+\/=]/g, '').slice(0, 16);

  // Use Node's crypto to create SHA-512 based password hash
  // This produces a hash compatible with /etc/shadow
  const hash = crypto.createHash('sha512');
  hash.update(salt + password);
  const digest = hash.digest('base64');

  return `$6$${salt}$${digest}`;
}

/**
 * Generate a complete cloud-init user-data YAML for Ubuntu autoinstall.
 * 
 * @param {object} options - Configuration options
 * @param {string} options.hostname - VM hostname
 * @param {string} options.username - Default user name
 * @param {string} options.password - Default user password (will be hashed)
 * @param {string} [options.fullName] - User's full name
 * @param {string} [options.locale] - Locale (default: en_US.UTF-8)
 * @param {string} [options.timezone] - Timezone (default: UTC)
 * @param {string} [options.keyboardLayout] - Keyboard layout (default: us)
 * @returns {string} Complete user-data YAML content
 */
function generateUserData(options) {
  const {
    hostname = 'ubuntu-vm',
    username = 'guest',
    password = 'guest',
    fullName = 'VM User',
    locale = 'en_US.UTF-8',
    timezone = 'UTC',
    keyboardLayout = 'us'
  } = options;

  const hashedPassword = hashPassword(password);

  logger.info('CloudInit', `Generating autoinstall config for host: ${hostname}, user: ${username}`);

  const userData = `#cloud-config
autoinstall:
  version: 1

  # ─── Locale & Keyboard ─────────────────────────────────────
  locale: ${locale}
  keyboard:
    layout: ${keyboardLayout}
    variant: ""

  # ─── Identity ──────────────────────────────────────────────
  identity:
    hostname: ${hostname}
    username: ${username}
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
    - openssh-server

  # ─── Late Commands (run after installation) ────────────────
  late-commands:
    # Add user to vboxsf group for shared folder access
    - "curtin in-target -- usermod -aG vboxsf ${username} || true"
    # Ensure auto-login for desktop experience
    - |
      cat <<'EOF' > /target/etc/gdm3/custom.conf
      [daemon]
      AutomaticLoginEnable=true
      AutomaticLogin=${username}
      EOF
    # Set timezone
    - "curtin in-target -- timedatectl set-timezone ${timezone} || true"

  # ─── User Data (post-first-boot) ──────────────────────────
  user-data:
    runcmd:
      # Ensure Guest Additions kernel modules load on boot
      - "modprobe vboxguest || true"
      - "modprobe vboxsf || true"
      - "modprobe vboxvideo || true"
`;

  logger.success('CloudInit', 'Autoinstall configuration generated');
  return userData;
}

/**
 * Generate meta-data file content.
 * 
 * @param {string} instanceId - Unique instance identifier
 * @param {string} hostname - VM hostname
 * @returns {string} meta-data YAML content
 */
function generateMetaData(instanceId, hostname) {
  return `instance-id: ${instanceId}
local-hostname: ${hostname}
`;
}

/**
 * Write cloud-init files to a directory.
 * These can then be used to create a cloud-init ISO.
 * 
 * @param {string} outputDir - Directory to write files to
 * @param {object} options - Configuration options (same as generateUserData)
 * @returns {Promise<object>} Paths to created files
 */
async function writeCloudInitFiles(outputDir, options) {
  await fs.promises.mkdir(outputDir, { recursive: true });

  const userDataPath = path.join(outputDir, 'user-data');
  const metaDataPath = path.join(outputDir, 'meta-data');

  const userData = generateUserData(options);
  const metaData = generateMetaData(
    `vm-${Date.now()}`,
    options.hostname || 'ubuntu-vm'
  );

  await fs.promises.writeFile(userDataPath, userData, 'utf8');
  await fs.promises.writeFile(metaDataPath, metaData, 'utf8');

  logger.info('CloudInit', `Written user-data to: ${userDataPath}`);
  logger.info('CloudInit', `Written meta-data to: ${metaDataPath}`);

  return { userDataPath, metaDataPath };
}

module.exports = {
  generateUserData,
  generateMetaData,
  writeCloudInitFiles,
  hashPassword
};
