/**
 * core/config.js — Central Configuration Manager
 *
 * Multi-OS support: Ubuntu, Debian, Fedora, Linux Mint, Arch,
 * CentOS, AlmaLinux, Rocky Linux, Kali Linux, Windows 10/11,
 * FreeBSD, and custom ISOs.
 */

const path = require('path');
const os = require('os');

// ─── OS Catalog ───────────────────────────────────────────────────────────────
// All officially supported OS options grouped by category.
// 'unattended' = VBoxManage unattended install is supported.
// 'downloadUrl' = direct ISO download (null if user must supply ISO).
const OS_CATALOG = {
  // ── Ubuntu ──────────────────────────────────────────────────────────────────
  'Ubuntu 24.04.1 LTS (Noble Numbat)': {
    category: 'Ubuntu',
    osType: 'Ubuntu_64',
    filename: 'ubuntu-24.04.1-desktop-amd64.iso',
    downloadUrl: 'https://releases.ubuntu.com/24.04.1/ubuntu-24.04.1-desktop-amd64.iso',
    sha256Url: 'https://releases.ubuntu.com/24.04.1/SHA256SUMS',
    unattended: true,
    defaultUser: 'user',
    defaultPass: 'password',
    ram: 4096, cpus: 2, disk: 25600, vram: 128,
    graphicsController: 'vmsvga',
    notes: 'Latest Ubuntu LTS — recommended for most users'
  },
  'Ubuntu 24.04 LTS (Noble Numbat)': {
    category: 'Ubuntu',
    osType: 'Ubuntu_64',
    filename: 'ubuntu-24.04-desktop-amd64.iso',
    downloadUrl: 'https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso',
    sha256Url: 'https://releases.ubuntu.com/24.04/SHA256SUMS',
    unattended: true,
    defaultUser: 'user', defaultPass: 'password',
    ram: 4096, cpus: 2, disk: 25600, vram: 128,
    graphicsController: 'vmsvga',
    notes: 'Ubuntu 24.04 LTS'
  },
  'Ubuntu 22.04.4 LTS (Jammy Jellyfish)': {
    category: 'Ubuntu',
    osType: 'Ubuntu_64',
    filename: 'ubuntu-22.04.4-desktop-amd64.iso',
    downloadUrl: 'https://releases.ubuntu.com/22.04.4/ubuntu-22.04.4-desktop-amd64.iso',
    sha256Url: 'https://releases.ubuntu.com/22.04.4/SHA256SUMS',
    unattended: true,
    defaultUser: 'user', defaultPass: 'password',
    ram: 4096, cpus: 2, disk: 25600, vram: 128,
    graphicsController: 'vmsvga',
    notes: 'Stable Ubuntu LTS release'
  },
  'Ubuntu 20.04.6 LTS (Focal Fossa)': {
    category: 'Ubuntu',
    osType: 'Ubuntu_64',
    filename: 'ubuntu-20.04.6-desktop-amd64.iso',
    downloadUrl: 'https://releases.ubuntu.com/20.04.6/ubuntu-20.04.6-desktop-amd64.iso',
    sha256Url: 'https://releases.ubuntu.com/20.04.6/SHA256SUMS',
    unattended: true,
    defaultUser: 'user', defaultPass: 'password',
    ram: 2048, cpus: 2, disk: 20480, vram: 128,
    graphicsController: 'vmsvga',
    notes: 'Ubuntu 20.04 LTS — older but very stable'
  },

  // ── Debian ──────────────────────────────────────────────────────────────────
  'Debian 12 (Bookworm)': {
    category: 'Debian',
    osType: 'Debian_64',
    filename: 'debian-12.9.0-amd64-netinst.iso',
    downloadUrl: 'https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12.9.0-amd64-netinst.iso',
    sha256Url: null,
    unattended: true,
    defaultUser: 'user', defaultPass: 'password',
    ram: 2048, cpus: 2, disk: 20480, vram: 16,
    graphicsController: 'vmsvga',
    notes: 'Minimal Debian netinstall'
  },
  'Debian 11 (Bullseye)': {
    category: 'Debian',
    osType: 'Debian_64',
    filename: 'debian-11.9.0-amd64-netinst.iso',
    downloadUrl: 'https://cdimage.debian.org/cdimage/archive/11.9.0/amd64/iso-cd/debian-11.9.0-amd64-netinst.iso',
    sha256Url: null,
    unattended: true,
    defaultUser: 'user', defaultPass: 'password',
    ram: 2048, cpus: 2, disk: 20480, vram: 16,
    graphicsController: 'vmsvga',
    notes: 'Older stable Debian'
  },

  // ── Fedora ──────────────────────────────────────────────────────────────────
  'Fedora 41 Workstation': {
    category: 'Fedora',
    osType: 'Fedora_64',
    filename: 'Fedora-Workstation-Live-x86_64-41.iso',
    downloadUrl: 'https://download.fedoraproject.org/pub/fedora/linux/releases/41/Workstation/x86_64/iso/Fedora-Workstation-Live-x86_64-41-1.4.iso',
    sha256Url: null,
    unattended: false,
    defaultUser: 'user', defaultPass: 'password',
    ram: 4096, cpus: 2, disk: 30720, vram: 128,
    graphicsController: 'vmsvga',
    notes: 'Fedora 41 Workstation — manual install required'
  },

  // ── Linux Mint ──────────────────────────────────────────────────────────────
  'Linux Mint 22.1 Cinnamon': {
    category: 'Linux Mint',
    osType: 'Ubuntu_64',
    filename: 'linuxmint-22.1-cinnamon-64bit.iso',
    downloadUrl: 'https://mirrors.edge.kernel.org/linuxmint/stable/22.1/linuxmint-22.1-cinnamon-64bit.iso',
    sha256Url: null,
    unattended: false,
    defaultUser: 'user', defaultPass: 'password',
    ram: 4096, cpus: 2, disk: 25600, vram: 128,
    graphicsController: 'vmsvga',
    notes: 'Linux Mint — beginner-friendly'
  },

  // ── Arch Linux ──────────────────────────────────────────────────────────────
  'Arch Linux (Latest)': {
    category: 'Arch Linux',
    osType: 'ArchLinux_64',
    filename: 'archlinux-latest.iso',
    downloadUrl: 'https://mirrors.edge.kernel.org/archlinux/iso/latest/archlinux-x86_64.iso',
    sha256Url: null,
    unattended: false,
    defaultUser: 'root', defaultPass: '',
    ram: 2048, cpus: 2, disk: 20480, vram: 16,
    graphicsController: 'vmsvga',
    notes: 'Arch Linux — advanced users only, manual install'
  },

  // ── Kali Linux ──────────────────────────────────────────────────────────────
  'Kali Linux 2024.4': {
    category: 'Kali Linux',
    osType: 'Debian_64',
    filename: 'kali-linux-2024.4-installer-amd64.iso',
    downloadUrl: 'https://cdimage.kali.org/kali-2024.4/kali-linux-2024.4-installer-amd64.iso',
    sha256Url: null,
    unattended: false,
    defaultUser: 'kali', defaultPass: 'kali',
    ram: 4096, cpus: 2, disk: 25600, vram: 128,
    graphicsController: 'vmsvga',
    notes: 'Kali Linux — security & penetration testing'
  },

  // ── CentOS / AlmaLinux / Rocky ───────────────────────────────────────────
  'AlmaLinux 9.5': {
    category: 'RHEL-Based',
    osType: 'RedHat_64',
    filename: 'AlmaLinux-9.5-x86_64-minimal.iso',
    downloadUrl: 'https://repo.almalinux.org/almalinux/9.5/isos/x86_64/AlmaLinux-9.5-x86_64-minimal.iso',
    sha256Url: null,
    unattended: false,
    defaultUser: 'user', defaultPass: 'password',
    ram: 2048, cpus: 2, disk: 20480, vram: 16,
    graphicsController: 'vmsvga',
    notes: 'AlmaLinux — RHEL-compatible server OS'
  },
  'Rocky Linux 9.5': {
    category: 'RHEL-Based',
    osType: 'RedHat_64',
    filename: 'Rocky-9.5-x86_64-minimal.iso',
    downloadUrl: 'https://download.rockylinux.org/pub/rocky/9.5/isos/x86_64/Rocky-9.5-x86_64-minimal.iso',
    sha256Url: null,
    unattended: false,
    defaultUser: 'user', defaultPass: 'password',
    ram: 2048, cpus: 2, disk: 20480, vram: 16,
    graphicsController: 'vmsvga',
    notes: 'Rocky Linux — RHEL-compatible'
  },

  // ── FreeBSD ─────────────────────────────────────────────────────────────────
  'FreeBSD 14.2': {
    category: 'BSD',
    osType: 'FreeBSD_64',
    filename: 'FreeBSD-14.2-RELEASE-amd64-disc1.iso',
    downloadUrl: 'https://download.freebsd.org/releases/amd64/amd64/ISO-IMAGES/14.2/FreeBSD-14.2-RELEASE-amd64-disc1.iso',
    sha256Url: null,
    unattended: false,
    defaultUser: 'root', defaultPass: '',
    ram: 2048, cpus: 2, disk: 20480, vram: 16,
    graphicsController: 'vboxvga',
    notes: 'FreeBSD — Unix-like OS, manual install'
  },

  // ── Windows ─────────────────────────────────────────────────────────────────
  'Windows 11 (Custom ISO)': {
    category: 'Windows',
    osType: 'Windows11_64',
    filename: null,
    downloadUrl: null,
    sha256Url: null,
    unattended: false,
    requireCustomIso: true,
    defaultUser: 'User', defaultPass: '',
    ram: 4096, cpus: 2, disk: 51200, vram: 128,
    graphicsController: 'vboxsvga',
    notes: 'Provide your own Windows 11 ISO. Requires 4GB+ RAM and 50GB+ disk.'
  },
  'Windows 10 (Custom ISO)': {
    category: 'Windows',
    osType: 'Windows10_64',
    filename: null,
    downloadUrl: null,
    sha256Url: null,
    unattended: false,
    requireCustomIso: true,
    defaultUser: 'User', defaultPass: '',
    ram: 4096, cpus: 2, disk: 51200, vram: 128,
    graphicsController: 'vboxsvga',
    notes: 'Provide your own Windows 10 ISO.'
  },
  'Windows Server 2022 (Custom ISO)': {
    category: 'Windows',
    osType: 'Windows2022_64',
    filename: null,
    downloadUrl: null,
    sha256Url: null,
    unattended: false,
    requireCustomIso: true,
    defaultUser: 'Administrator', defaultPass: '',
    ram: 4096, cpus: 4, disk: 51200, vram: 128,
    graphicsController: 'vboxsvga',
    notes: 'Provide your own Windows Server 2022 ISO.'
  },

  // ── Custom ──────────────────────────────────────────────────────────────────
  'Custom ISO': {
    category: 'Custom',
    osType: 'Other_64',
    filename: null,
    downloadUrl: null,
    sha256Url: null,
    unattended: false,
    requireCustomIso: true,
    defaultUser: 'user', defaultPass: 'password',
    ram: 2048, cpus: 2, disk: 20480, vram: 64,
    graphicsController: 'vmsvga',
    notes: 'Use any ISO file you have. You will need to install the OS manually.'
  }
};

// Keep legacy UBUNTU_RELEASES for backward compat
const UBUNTU_RELEASES = {
  '24.04.1 LTS (Noble Numbat)': OS_CATALOG['Ubuntu 24.04.1 LTS (Noble Numbat)'],
  '24.04 LTS (Noble Numbat)': OS_CATALOG['Ubuntu 24.04 LTS (Noble Numbat)'],
  '22.04.4 LTS (Jammy Jellyfish)': OS_CATALOG['Ubuntu 22.04.4 LTS (Jammy Jellyfish)']
};

// ─── VirtualBox Download URLs ─────────────────────────────────────────────────
const VIRTUALBOX_DOWNLOADS = {
  windows: {
    urlPattern: 'https://download.virtualbox.org/virtualbox/{VERSION}/VirtualBox-{VERSION}-{BUILD}-Win.exe',
    latestUrl: 'https://www.virtualbox.org/wiki/Downloads',
    extPackPattern: 'https://download.virtualbox.org/virtualbox/{VERSION}/Oracle_VirtualBox_Extension_Pack-{VERSION}.vbox-extpack'
  },
  linux: {
    urlPattern: 'https://download.virtualbox.org/virtualbox/{VERSION}/virtualbox-{MAJOR_VERSION}_{VERSION}~Ubuntu~{DISTRO_VERSION}_amd64.deb',
    latestUrl: 'https://www.virtualbox.org/wiki/Linux_Downloads'
  }
};

// ─── Default VM Configuration ─────────────────────────────────────────────────
const VM_DEFAULTS = {
  name: 'My VM',
  ram: 4096,
  cpus: 2,
  disk: 25600,
  vram: 128,
  network: 'nat',
  graphicsController: 'vmsvga',
  audioController: 'hda',
  clipboardMode: 'bidirectional',
  dragAndDrop: 'bidirectional',
  bootOrder: ['dvd', 'disk', 'none', 'none'],
  efi: false,
  nestedVt: false,
  audio: true,
  usb: true,
  '3d': false
};

// ─── System Requirements ──────────────────────────────────────────────────────
const SYSTEM_REQUIREMENTS = {
  minRAM: 4,
  minDisk: 30,
  minCPUs: 2,
  requires64Bit: true,
  requiresVirtualization: true
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDefaultInstallPath() {
  return path.join(os.homedir(), 'VirtualMachines');
}

function getAppDataPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'VMAutoInstaller');
  }
  return path.join(os.homedir(), '.vm-auto-installer');
}

function getDefaultSharedFolderPath() {
  return path.join(os.homedir(), 'Documents');
}

function getDownloadDir() {
  return path.join(getAppDataPath(), 'downloads');
}

function getLogDir() {
  return path.join(getAppDataPath(), 'logs');
}

/** Return list of OS names grouped by category */
function getOSCategories() {
  const cats = {};
  for (const [name, info] of Object.entries(OS_CATALOG)) {
    if (!cats[info.category]) cats[info.category] = [];
    cats[info.category].push(name);
  }
  return cats;
}

/** Find an OS entry by name (supports partial match) */
function findOS(name) {
  if (OS_CATALOG[name]) return { name, ...OS_CATALOG[name] };
  // legacy lookup
  for (const [key, val] of Object.entries(UBUNTU_RELEASES)) {
    if (name.includes(key) || key.includes(name)) return { name: key, ...val };
  }
  return null;
}

module.exports = {
  OS_CATALOG,
  UBUNTU_RELEASES,
  VIRTUALBOX_DOWNLOADS,
  VM_DEFAULTS,
  SYSTEM_REQUIREMENTS,
  getDefaultInstallPath,
  getAppDataPath,
  getDefaultSharedFolderPath,
  getDownloadDir,
  getLogDir,
  getOSCategories,
  findOS
};
