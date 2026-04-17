const https = require('https');
const { URL } = require('url');

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirected = new URL(res.headers.location, url).toString();
        return resolve(fetchText(redirected));
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? m[1] : null;
}

function firstExistingMatch(text, regexes) {
  for (const regex of regexes) {
    const m = text.match(regex);
    if (m && m[1]) return m[1];
  }
  return null;
}

function sortVersionsDesc(versions) {
  return versions.sort((a, b) => {
    const ap = a.split('.').map((n) => parseInt(n, 10));
    const bp = b.split('.').map((n) => parseInt(n, 10));
    const len = Math.max(ap.length, bp.length);
    for (let i = 0; i < len; i += 1) {
      const ai = Number.isFinite(ap[i]) ? ap[i] : 0;
      const bi = Number.isFinite(bp[i]) ? bp[i] : 0;
      if (ai !== bi) return bi - ai;
    }
    return 0;
  });
}

async function updateUbuntu(catalog) {
  const page = await fetchText('https://releases.ubuntu.com/');
  const regex = /ubuntu-(\d{2}\.\d{2}(?:\.\d+)?)-desktop-amd64\.iso/gi;
  const dirRegex = /href=["']?(\d{2}\.\d{2}(?:\.\d+)?)\/?["']?/gi;
  const versions = new Set();
  let match;

  while ((match = regex.exec(page)) !== null) {
    versions.add(match[1]);
  }

  while ((match = dirRegex.exec(page)) !== null) {
    versions.add(match[1]);
  }

  if (versions.size === 0) {
    const indexPage = await fetchText('https://old-releases.ubuntu.com/releases/');
    while ((match = dirRegex.exec(indexPage)) !== null) {
      versions.add(match[1]);
    }
  }

  const sorted = sortVersionsDesc(Array.from(versions));
  let added = 0;
  let found = 0;

  for (const version of sorted) {
    const key = `Ubuntu ${version}`;
    const filename = `ubuntu-${version}-desktop-amd64.iso`;
    const primaryUrl = `https://releases.ubuntu.com/${version}/${filename}`;
    const oldUrl = `https://old-releases.ubuntu.com/releases/${version}/${filename}`;

    let downloadUrl = primaryUrl;
    try {
      const dirPage = await fetchText(`https://releases.ubuntu.com/${version}/`);
      if (!dirPage.includes(filename)) {
        const oldPage = await fetchText(`https://old-releases.ubuntu.com/releases/${version}/`);
        if (!oldPage.includes(filename)) continue;
        downloadUrl = oldUrl;
      }
    } catch {
      try {
        const oldPage = await fetchText(`https://old-releases.ubuntu.com/releases/${version}/`);
        if (!oldPage.includes(filename)) continue;
        downloadUrl = oldUrl;
      } catch {
        continue;
      }
    }

    found += 1;
    if (!catalog[key]) {
      catalog[key] = {
        category: 'Ubuntu',
        osType: 'Ubuntu_64',
        filename,
        downloadUrl,
        sha256Url: downloadUrl.includes('old-releases')
          ? `https://old-releases.ubuntu.com/releases/${version}/SHA256SUMS`
          : `https://releases.ubuntu.com/${version}/SHA256SUMS`,
        unattended: true,
        defaultUser: 'user',
        defaultPass: 'password',
        ram: 4096,
        cpus: 2,
        disk: 25600,
        vram: 128,
        graphicsController: 'vmsvga',
        notes: `Ubuntu ${version} from releases.ubuntu.com`
      };
      added += 1;
    }
  }

  return { found, added };
}

async function updateKali(catalog) {
  const page = await fetchText('https://cdimage.kali.org/');
  const regex = /kali-(\d{4}\.\d+)\//gi;
  const versions = new Set();
  let match;

  while ((match = regex.exec(page)) !== null) {
    versions.add(match[1]);
  }

  const sorted = sortVersionsDesc(Array.from(versions));
  let added = 0;

  for (const version of sorted) {
    const key = `Kali Linux ${version}`;
    if (!catalog[key]) {
      catalog[key] = {
        category: 'Kali Linux',
        osType: 'Debian_64',
        filename: `kali-linux-${version}-installer-amd64.iso`,
        downloadUrl: `https://cdimage.kali.org/kali-${version}/kali-linux-${version}-installer-amd64.iso`,
        sha256Url: null,
        unattended: false,
        defaultUser: 'kali',
        defaultPass: 'kali',
        ram: 4096,
        cpus: 2,
        disk: 25600,
        vram: 128,
        graphicsController: 'vmsvga',
        notes: `Kali Linux ${version} from cdimage.kali.org`
      };
      added += 1;
    }
  }

  return { found: sorted.length, added };
}

async function updateDebian(catalog) {
  const releaseIndex = await fetchText('https://cdimage.debian.org/debian-cd/');
  const releaseRegex = /href=["']?(\d+\.\d+\.\d+)\/?["']?/gi;
  const versions = new Set();
  const archiveVersions = new Set();
  let match;

  while ((match = releaseRegex.exec(releaseIndex)) !== null) {
    versions.add(match[1]);
  }

  if (versions.size === 0) {
    const currentPage = await fetchText('https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/');
    const currentRegex = /debian-(\d+\.\d+\.\d+)-amd64-netinst\.iso/gi;
    while ((match = currentRegex.exec(currentPage)) !== null) {
      versions.add(match[1]);
    }
  }

  try {
    const archiveIndex = await fetchText('https://cdimage.debian.org/cdimage/archive/');
    while ((match = releaseRegex.exec(archiveIndex)) !== null) {
      const version = match[1];
      versions.add(version);
      archiveVersions.add(version);
    }
  } catch {
    // Archive index may be temporarily unavailable.
  }

  const sorted = sortVersionsDesc(Array.from(versions));
  let added = 0;
  let found = 0;

  for (const version of sorted) {
    const isoName = `debian-${version}-amd64-netinst.iso`;
    const candidateDirs = [
      `https://cdimage.debian.org/debian-cd/${version}/amd64/iso-cd/`,
      ...(archiveVersions.has(version)
        ? [`https://cdimage.debian.org/cdimage/archive/${version}/amd64/iso-cd/`]
        : [])
    ];

    let isoUrl = null;
    for (const dir of candidateDirs) {
      try {
        const isoDirPage = await fetchText(dir);
        if (isoDirPage.includes(isoName)) {
          isoUrl = `${dir}${isoName}`;
          break;
        }
      } catch {
        // Try next candidate path.
      }
    }

    if (!isoUrl) continue;
    found += 1;

    const major = version.split('.')[0];
    const key = `Debian ${major} (${version})`;
    if (!catalog[key]) {
      catalog[key] = {
        category: 'Debian',
        osType: 'Debian_64',
        filename: isoName,
        downloadUrl: isoUrl,
        sha256Url: null,
        unattended: true,
        defaultUser: 'user',
        defaultPass: 'password',
        ram: 2048,
        cpus: 2,
        disk: 20480,
        vram: 16,
        graphicsController: 'vmsvga',
        notes: `Debian ${version} netinst from cdimage.debian.org`
      };
      added += 1;
    }
  }

  return { found, added };
}

async function updateFedora(catalog) {
  const feedText = await fetchText('https://fedoraproject.org/releases.json');
  let feed;
  try {
    feed = JSON.parse(feedText);
  } catch {
    throw new Error('Invalid Fedora releases feed format');
  }

  const entries = Array.isArray(feed) ? feed : [];
  const isIso = (url) => /\.iso($|\?)/i.test(url || '');

  const candidates = entries
    .filter((entry) => entry && entry.arch === 'x86_64' && isIso(entry.link))
    .filter((entry) => !/\/test\//i.test(entry.link || ''))
    .filter((entry) => {
      const variant = String(entry.variant || '').toLowerCase();
      return variant === 'workstation' || variant === 'server' || variant === 'everything' || variant === 'kde';
    });

  const byVersion = new Map();
  const rankVariant = (variant) => {
    const v = String(variant || '').toLowerCase();
    if (v === 'workstation') return 1;
    if (v === 'server') return 2;
    if (v === 'everything') return 3;
    if (v === 'kde') return 4;
    return 99;
  };

  for (const item of candidates) {
    const version = String(item.version || '').trim();
    if (!version) continue;

    const current = byVersion.get(version);
    if (!current || rankVariant(item.variant) < rankVariant(current.variant)) {
      byVersion.set(version, item);
    }
  }

  const versions = Array.from(byVersion.keys()).sort((a, b) => {
    const parse = (v) => {
      const m = String(v).match(/(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    };
    return parse(b) - parse(a);
  });

  let found = 0;
  let added = 0;

  for (const version of versions) {
    const item = byVersion.get(version);
    if (!item?.link) continue;

    const fileName = item.link.split('/').pop() || `Fedora-${version}.iso`;
    const variant = String(item.variant || 'Workstation');
    const key = `Fedora ${version} ${variant}`;

    found += 1;
    if (!catalog[key]) {
      catalog[key] = {
        category: 'Fedora',
        osType: 'Fedora_64',
        filename: fileName,
        downloadUrl: item.link,
        sha256Url: null,
        unattended: false,
        defaultUser: 'user',
        defaultPass: 'password',
        ram: 4096,
        cpus: 2,
        disk: 30720,
        vram: 128,
        graphicsController: 'vmsvga',
        notes: `Fedora ${version} ${variant} from fedoraproject.org/releases.json`
      };
      added += 1;
    }
  }

  return { found, added };
}

async function updateArch(catalog) {
  const base = 'https://mirrors.edge.kernel.org/archlinux/iso/';
  const page = await fetchText(base);
  const regex = /href="(\d{4}\.\d{2}\.\d{2})\/"/gi;
  const versions = new Set();
  let match;

  while ((match = regex.exec(page)) !== null) {
    versions.add(match[1]);
  }

  const sorted = sortVersionsDesc(Array.from(versions));
  let added = 0;

  for (const version of sorted) {
    const key = `Arch Linux ${version}`;
    if (!catalog[key]) {
      catalog[key] = {
        category: 'Arch Linux',
        osType: 'ArchLinux_64',
        filename: 'archlinux-x86_64.iso',
        downloadUrl: `${base}${version}/archlinux-x86_64.iso`,
        sha256Url: `${base}${version}/sha256sums.txt`,
        unattended: false,
        defaultUser: 'root',
        defaultPass: '',
        ram: 2048,
        cpus: 2,
        disk: 20480,
        vram: 16,
        graphicsController: 'vmsvga',
        notes: `Arch Linux snapshot ${version} from mirrors.edge.kernel.org`
      };
      added += 1;
    }
  }

  return { found: sorted.length, added };
}

async function updateRocky(catalog) {
  const base = 'https://download.rockylinux.org/pub/rocky/';
  const page = await fetchText(base);
  const regex = /href="(\d+\.\d+)\/"/gi;
  const versions = new Set();
  let match;

  while ((match = regex.exec(page)) !== null) {
    versions.add(match[1]);
  }

  const sorted = sortVersionsDesc(Array.from(versions));
  let added = 0;

  for (const version of sorted) {
    const isoDir = `${base}${version}/isos/x86_64/`;
    try {
      const isoPage = await fetchText(isoDir);
      const isoName = firstMatch(isoPage, /(Rocky-[\d.\-]+-x86_64-(?:minimal|dvd)\.iso)/i);
      if (!isoName) continue;

      const key = `Rocky Linux ${version}`;
      if (!catalog[key]) {
        catalog[key] = {
          category: 'RHEL-Based',
          osType: 'RedHat_64',
          filename: isoName,
          downloadUrl: `${isoDir}${isoName}`,
          sha256Url: null,
          unattended: false,
          defaultUser: 'user',
          defaultPass: 'password',
          ram: 2048,
          cpus: 2,
          disk: 20480,
          vram: 16,
          graphicsController: 'vmsvga',
          notes: `Rocky Linux ${version} from download.rockylinux.org`
        };
        added += 1;
      }
    } catch {
      // Skip broken mirrors/releases
    }
  }

  return { found: sorted.length, added };
}

async function updateAlma(catalog) {
  const base = 'https://repo.almalinux.org/almalinux/';
  const page = await fetchText(base);
  const regex = /href="(\d+\.\d+)\/"/gi;
  const versions = new Set();
  let match;

  while ((match = regex.exec(page)) !== null) {
    versions.add(match[1]);
  }

  const sorted = sortVersionsDesc(Array.from(versions));
  let added = 0;

  for (const version of sorted) {
    const isoDir = `${base}${version}/isos/x86_64/`;
    try {
      const isoPage = await fetchText(isoDir);
      const isoName = firstMatch(isoPage, /(AlmaLinux-[\d.\-]+-x86_64-(?:minimal|dvd)\.iso)/i);
      if (!isoName) continue;

      const key = `AlmaLinux ${version}`;
      if (!catalog[key]) {
        catalog[key] = {
          category: 'RHEL-Based',
          osType: 'RedHat_64',
          filename: isoName,
          downloadUrl: `${isoDir}${isoName}`,
          sha256Url: null,
          unattended: false,
          defaultUser: 'user',
          defaultPass: 'password',
          ram: 2048,
          cpus: 2,
          disk: 20480,
          vram: 16,
          graphicsController: 'vmsvga',
          notes: `AlmaLinux ${version} from repo.almalinux.org`
        };
        added += 1;
      }
    } catch {
      // Skip broken mirrors/releases
    }
  }

  return { found: sorted.length, added };
}

async function updateLinuxMint(catalog) {
  const base = 'https://mirrors.edge.kernel.org/linuxmint/stable/';
  const page = await fetchText(base);
  const regex = /href="(\d+\.\d+)\/"/gi;
  const versions = new Set();
  let match;

  while ((match = regex.exec(page)) !== null) {
    versions.add(match[1]);
  }

  const sorted = sortVersionsDesc(Array.from(versions));
  let added = 0;

  for (const version of sorted) {
    const dir = `${base}${version}/`;
    try {
      const p = await fetchText(dir);
      const isoName = firstMatch(p, /(linuxmint-[\d.\-]+-cinnamon-64bit\.iso)/i);
      if (!isoName) continue;

      const key = `Linux Mint ${version} Cinnamon`;
      if (!catalog[key]) {
        catalog[key] = {
          category: 'Linux Mint',
          osType: 'Ubuntu_64',
          filename: isoName,
          downloadUrl: `${dir}${isoName}`,
          sha256Url: null,
          unattended: false,
          defaultUser: 'user',
          defaultPass: 'password',
          ram: 4096,
          cpus: 2,
          disk: 25600,
          vram: 128,
          graphicsController: 'vmsvga',
          notes: `Linux Mint ${version} Cinnamon from mirrors.edge.kernel.org`
        };
        added += 1;
      }
    } catch {
      // Skip if unavailable
    }
  }

  return { found: sorted.length, added };
}

async function updateFreeBSD(catalog) {
  const base = 'https://download.freebsd.org/releases/amd64/amd64/ISO-IMAGES/';
  const page = await fetchText(base);
  const regex = /href="(\d+\.\d+)\/"/gi;
  const versions = new Set();
  let match;

  while ((match = regex.exec(page)) !== null) {
    versions.add(match[1]);
  }

  const sorted = sortVersionsDesc(Array.from(versions));
  let added = 0;

  for (const version of sorted) {
    const key = `FreeBSD ${version}`;
    if (!catalog[key]) {
      catalog[key] = {
        category: 'BSD',
        osType: 'FreeBSD_64',
        filename: `FreeBSD-${version}-RELEASE-amd64-disc1.iso`,
        downloadUrl: `${base}${version}/FreeBSD-${version}-RELEASE-amd64-disc1.iso`,
        sha256Url: null,
        unattended: false,
        defaultUser: 'root',
        defaultPass: '',
        ram: 2048,
        cpus: 2,
        disk: 20480,
        vram: 16,
        graphicsController: 'vboxvga',
        notes: `FreeBSD ${version} from download.freebsd.org`
      };
      added += 1;
    }
  }

  return { found: sorted.length, added };
}

async function refreshOfficialCatalog(baseCatalog, log = null) {
  const catalog = { ...baseCatalog };
  const summary = {
    ubuntu: { found: 0, added: 0, error: null },
    kali: { found: 0, added: 0, error: null },
    debian: { found: 0, added: 0, error: null },
    fedora: { found: 0, added: 0, error: null },
    arch: { found: 0, added: 0, error: null },
    rocky: { found: 0, added: 0, error: null },
    alma: { found: 0, added: 0, error: null },
    mint: { found: 0, added: 0, error: null },
    freebsd: { found: 0, added: 0, error: null }
  };

  const safeRun = async (key, fn) => {
    try {
      const result = await fn(catalog);
      summary[key] = { ...summary[key], ...result };
    } catch (err) {
      summary[key].error = err.message;
      if (log && log.warn) {
        log.warn('CatalogUpdater', `${key} refresh failed: ${err.message}`);
      }
    }
  };

  await safeRun('ubuntu', updateUbuntu);
  await safeRun('kali', updateKali);
  await safeRun('debian', updateDebian);
  await safeRun('fedora', updateFedora);
  await safeRun('arch', updateArch);
  await safeRun('rocky', updateRocky);
  await safeRun('alma', updateAlma);
  await safeRun('mint', updateLinuxMint);
  await safeRun('freebsd', updateFreeBSD);

  const totalAdded = Object.values(summary).reduce((acc, s) => acc + (s.added || 0), 0);

  if (log && log.info) {
    log.info('CatalogUpdater', `Official catalog refresh complete. Added ${totalAdded} entries.`);
  }

  return { catalog, summary, totalAdded };
}

module.exports = { refreshOfficialCatalog };
