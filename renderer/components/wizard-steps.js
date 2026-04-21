/**
 * renderer/components/wizard-steps.js — Wizard Step Templates
 * 
 * 5-Step VM Creation Flow Customization.
 */

const renderStepIndicator = (activeIdx) => {
  const steps = ['Choose OS', 'ISO Fetch', 'Hardware', 'Advanced', 'Review'];
  return `
    <div class="step-indicator wizard-step-indicator" id="stepIndicator">
      ${steps.map((s, i) => `
        <div class="step-item wizard-step-item ${i === activeIdx ? 'active' : ''} ${i < activeIdx ? 'completed' : ''}">
          <div class="step-circle wizard-step-circle">
            ${i < activeIdx ? '✓' : i + 1}
          </div>
          ${s}
          ${i < steps.length - 1 ? '<div class="wizard-step-connector"></div>' : ''}
        </div>
      `).join('')}
    </div>
  `;
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDiskFreeFromReport(report) {
  const diskCheck = (report?.checks || []).find((c) => c.name === 'Disk Space');
  if (!diskCheck?.value) return null;
  const m = String(diskCheck.value).match(/(\d+(?:\.\d+)?)\s*GB/i);
  return m ? parseFloat(m[1]) : null;
}

function buildRecommendations(catalog, report) {
  const totalRamGb = Number(report?.systemInfo?.totalRAM || 0);
  const cpuCount = Number(report?.systemInfo?.cpuCount || 0);
  const freeDiskGb = getDiskFreeFromReport(report);

  const scores = {};
  const byCategoryTop = {};
  let overallBest = null;

  for (const [name, info] of Object.entries(catalog || {})) {
    const reqRamGb = Math.max(1, Math.round((Number(info.ram || 2048) / 1024) * 10) / 10);
    const reqCpu = Math.max(1, Number(info.cpus || 2));
    const reqDiskGb = Math.max(10, Math.round(Number(info.disk || 20480) / 1024));

    let score = 50;

    if (totalRamGb > 0) {
      if (totalRamGb < reqRamGb) score -= 45;
      else score += Math.min(20, Math.floor((totalRamGb - reqRamGb) * 3));
    }

    if (cpuCount > 0) {
      if (cpuCount < reqCpu) score -= 30;
      else score += Math.min(15, (cpuCount - reqCpu) * 3);
    }

    if (freeDiskGb !== null) {
      if (freeDiskGb < reqDiskGb) score -= 40;
      else score += Math.min(15, Math.floor((freeDiskGb - reqDiskGb) / 15));
    }

    const osName = String(name || '').toLowerCase();
    if (osName.includes('lts')) score += 4;
    if (osName.includes('workstation')) score += 2;

    const fit = score >= 75 ? 'Excellent' : score >= 60 ? 'Good' : score >= 45 ? 'Limited' : 'Low';
    const category = info.category || 'Other';

    const row = {
      name,
      score,
      fit,
      category,
      reasons: {
        reqRamGb,
        reqCpu,
        reqDiskGb
      }
    };
    scores[name] = row;

    if (!byCategoryTop[category] || row.score > byCategoryTop[category].score) {
      byCategoryTop[category] = row;
    }
    if (!overallBest || row.score > overallBest.score) {
      overallBest = row;
    }
  }

  return {
    scores,
    byCategoryTop,
    overallBest,
    profile: {
      totalRamGb,
      cpuCount,
      freeDiskGb
    }
  };
}

function _getDefaultVmNameFromOs(osName) {
  const normalized = String(osName || '')
    .replace(/\s*\(.+\)$/, '')
    .trim()
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return `My-${normalized || 'V-OS'}`;
}

function _syncVmNameWithSelectedOs(state, options = {}) {
  const force = !!options.force;
  if (!state) return;
  if (!String(state.osName || '').trim()) return;

  const defaultName = _getDefaultVmNameFromOs(state.osName);
  const currentName = String(state.vmName || '').trim();
  const previousAutoName = String(state._autoVmName || '').trim();
  const shouldApplyDefault = force || !currentName || (previousAutoName && currentName === previousAutoName);

  if (shouldApplyDefault) {
    state.vmName = defaultName;
  }
  state._autoVmName = defaultName;
}

function _hydrateAutoVmNameState(state) {
  if (!state || state._autoVmName) return;
  if (!String(state.vmName || '').trim()) return;
  if (!String(state.osName || '').trim()) return;

  const inferredDefault = _getDefaultVmNameFromOs(state.osName);
  if (String(state.vmName || '').trim() === inferredDefault) {
    state._autoVmName = inferredDefault;
  }
}

const WizardSteps = {
  // ─── Step 1: Choose OS ─────────────────────────────────────────────
  chooseOs: {
    render(state) {
      const catalog = state.defaults?.osCatalog || {};
      const grouped = Object.entries(catalog).reduce((acc, [name, info]) => {
        const category = info.category || 'Other';
        if (!acc[category]) acc[category] = [];
        acc[category].push({ name, ...info });
        return acc;
      }, {});

      const categories = Object.keys(grouped);
      const selectedCategory = state.osCategory && grouped[state.osCategory]
        ? state.osCategory
        : (state.osName && catalog[state.osName]?.category)
          ? catalog[state.osName].category
          : categories[0];

      const recommendation = buildRecommendations(catalog, state.systemReport);
      const versions = (grouped[selectedCategory] || []).sort((a, b) => {
        const aScore = recommendation.scores[a.name]?.score ?? 0;
        const bScore = recommendation.scores[b.name]?.score ?? 0;
        if (aScore !== bScore) return bScore - aScore;
        return a.name.localeCompare(b.name);
      });

      const recommendedByCategory = recommendation.byCategoryTop[selectedCategory]?.name || '';
      const selectedVersion = (state.osName && versions.some(v => v.name === state.osName))
        ? state.osName
        : (recommendedByCategory || versions[0]?.name || '');

      const cards = categories.map((category) => {
        const versionsCount = grouped[category]?.length || 0;
        const isActive = category === selectedCategory;
        const topInCategory = recommendation.byCategoryTop[category];
        return `
          <div class="os-card" data-os-category="${category}" style="padding: 16px; border: 1px solid ${isActive ? '#007acc' : '#333'}; border-radius: 6px; cursor: pointer; background: ${isActive ? '#252526' : '#1e1e1e'}; flex: 1; min-width: 170px;">
            <div style="font-size: 22px; margin-bottom: 8px;">${typeof Icons !== 'undefined' ? Icons.monitor : ''}</div>
            <div style="font-weight: 600; color: #ccc;">${category}</div>
            <div style="font-size: 12px; color: #888; margin-top: 4px;">${versionsCount} version${versionsCount !== 1 ? 's' : ''}</div>
            ${topInCategory ? `<div style="font-size:11px; color:#58a6ff; margin-top:6px;">Top: ${topInCategory.name}</div>` : ''}
          </div>
        `;
      }).join('');

      const versionOptions = versions.map((version) => `
        <option value="${version.name}" ${version.name === selectedVersion ? 'selected' : ''}>${version.name}${version.name === recommendedByCategory ? ' ★ Recommended' : ''}</option>
      `).join('');

      const selectedVersionInfo = catalog[selectedVersion] || {};
      const selectedScore = recommendation.scores[selectedVersion];
      const top3 = versions.slice(0, 3).map((v) => recommendation.scores[v.name]).filter(Boolean);
      const sourceUrl = selectedVersionInfo.downloadUrl || '';
      const sourceDomain = sourceUrl ? new URL(sourceUrl).hostname : '';
      const lastSyncText = state.catalogRefreshMeta?.timestamp
        ? new Date(state.catalogRefreshMeta.timestamp).toLocaleString()
        : 'Not synced yet';

      return `
        <div class="glass-card wizard-shell">
          ${renderStepIndicator(0)}
          <h2 class="step-title" style="margin-bottom: 8px; color: #fff;">Choose OS</h2>
          <p class="step-description" style="color: #888; margin-bottom: 24px;">Choose OS family and version from the official catalog.</p>

          <div class="wizard-section wizard-section-muted" style="margin-bottom: 16px;">
            <div style="font-size:12px; color:#9da7b3; margin-bottom:6px;">Smart Recommendations ${state.systemReport ? '(Based on your PC specs)' : '(Analyzing your PC specs...)'}</div>
            ${state.systemReport ? `
              <div style="font-size:12px; color:#c9d1d9; margin-bottom:6px;">Detected: ${recommendation.profile.cpuCount || '?'} CPU cores · ${recommendation.profile.totalRamGb || '?'} GB RAM${recommendation.profile.freeDiskGb !== null ? ` · ${recommendation.profile.freeDiskGb} GB free disk` : ''}</div>
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                ${top3.map((row) => `<button class="btn btn-secondary recommendation-chip" data-version-name="${row.name}" type="button" style="padding:4px 8px; font-size:12px;">${row.name} (${row.fit})</button>`).join('')}
              </div>
            ` : '<div style="font-size:12px; color:#8b949e;">Running system check in background to rank versions for your hardware...</div>'}
          </div>
          
          <div style="display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px;" id="osCards">
            ${cards}
          </div>

          <div class="wizard-section" style="margin-bottom: 24px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px;">
              <label style="display: block; color: #fff; margin:0;">Version</label>
              <button class="btn btn-secondary" id="btnRefreshWizardCatalog" type="button" style="padding:4px 10px; font-size:12px;">Refresh Official Versions</button>
            </div>
            <div style="font-size:11px; color:#9da7b3; margin-bottom:8px;">Last sync: ${lastSyncText}</div>
            <select id="osVersionSelect" style="width:100%; padding:8px; background:#252526; border:1px solid #444; color:#ccc; border-radius:4px; margin-bottom:10px;">
              ${versionOptions}
            </select>

            <div style="font-size: 12px; color:#888; margin-bottom: 6px;">${selectedVersionInfo.notes || 'No notes available.'}</div>
            <div style="font-size: 12px; color:#888;">OS Type: ${selectedVersionInfo.osType || 'Other_64'} · Unattended: ${selectedVersionInfo.unattended ? 'Supported' : 'Manual'}</div>
            ${selectedScore ? `<div style="font-size:12px; color:${selectedScore.fit === 'Excellent' || selectedScore.fit === 'Good' ? '#2ea043' : (selectedScore.fit === 'Limited' ? '#d29922' : '#f85149')}; margin-top:6px;">Recommended Fit: ${selectedScore.fit} · Needs ${selectedScore.reasons.reqCpu} CPU, ${selectedScore.reasons.reqRamGb} GB RAM, ${selectedScore.reasons.reqDiskGb} GB disk</div>` : ''}

            ${sourceUrl ? `
              <div style="margin-top: 12px; display:flex; align-items:center; justify-content:space-between; gap:10px;">
                <span style="font-size:12px; color:#9da7b3;">Official Source: ${sourceDomain}</span>
                <button class="btn btn-secondary" id="btnOpenSource" type="button">Open Official Page</button>
              </div>
            ` : `
              <div style="margin-top: 12px; font-size:12px; color:#9da7b3;">No direct official download URL in catalog. You can continue and select a local ISO in Step 2.</div>
            `}
          </div>

          <div class="btn-row wizard-nav-row">
            <div></div> <!-- No back button on first step -->
            <button class="btn btn-primary wizard-nav-next" id="btnNext">Next →</button>
          </div>
        </div>
      `;
    },
    init(state, app) {
      const catalog = state.defaults?.osCatalog || {};
      const recommendation = buildRecommendations(catalog, state.systemReport);

      const pickBestVersion = (category) => {
        const best = recommendation.byCategoryTop[category]?.name;
        if (best) return best;
        const firstMatch = Object.entries(catalog).find(([name, info]) => info.category === category);
        return firstMatch ? firstMatch[0] : '';
      };

      document.querySelectorAll('.os-card').forEach((card) => {
        card.addEventListener('click', () => {
          const category = card.dataset.osCategory;
          if (!category) return;
          state.osCategory = category;
          const firstVersion = pickBestVersion(category);
          if (firstVersion) state.osName = firstVersion;
          _syncVmNameWithSelectedOs(state);
          if (typeof renderStep === 'function') {
            renderStep(0);
          }
        });
      });

      document.querySelectorAll('.recommendation-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const name = chip.getAttribute('data-version-name');
          if (!name || !catalog[name]) return;
          state.osName = name;
          state.osCategory = catalog[name].category || state.osCategory;
          _syncVmNameWithSelectedOs(state);
          if (typeof renderStep === 'function') {
            renderStep(0);
          }
        });
      });

      document.getElementById('osVersionSelect')?.addEventListener('change', (e) => {
        const selected = e.target.value;
        if (!selected) return;
        state.osName = selected;
        state.osCategory = catalog[selected]?.category || state.osCategory;
        _syncVmNameWithSelectedOs(state);
      });

      document.getElementById('btnOpenSource')?.addEventListener('click', async () => {
        const selected = catalog[state.osName];
        if (!selected?.downloadUrl) return;
        if (window.vmInstaller?.openExternal) {
          await window.vmInstaller.openExternal(selected.downloadUrl);
        }
      });

      document.getElementById('btnRefreshWizardCatalog')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Refreshing...';

        try {
          const refreshed = await window.vmInstaller.refreshOfficialCatalog();
          if (!refreshed?.success) {
            if (typeof Dashboard !== 'undefined' && Dashboard._notify) {
              Dashboard._notify(`Catalog refresh failed: ${refreshed?.error || 'Unknown error'}`, 'error');
            }
            return;
          }

          state.defaults.osCatalog = refreshed.osCatalog || state.defaults.osCatalog;
          state.defaults.osCategories = refreshed.osCategories || state.defaults.osCategories;
          state.catalogRefreshMeta = {
            timestamp: Date.now(),
            totalAdded: refreshed.totalAdded || 0,
            summary: refreshed.summary || {}
          };

          if (!state.osName || !state.defaults.osCatalog?.[state.osName]) {
            const fallback = Object.keys(state.defaults.osCatalog || {})[0] || '';
            if (fallback) state.osName = fallback;
          }
          _syncVmNameWithSelectedOs(state);

          if (typeof Dashboard !== 'undefined' && Dashboard._notify) {
            Dashboard._notify(`Official catalog updated. Added ${refreshed.totalAdded || 0} versions.`, 'success');
          }

          if (typeof renderStep === 'function') {
            renderStep(0);
          }
        } finally {
          btn.disabled = false;
          btn.textContent = 'Refresh Official Versions';
        }
      });

      if (!state.osName) {
        const fallback = recommendation.overallBest?.name || Object.keys(catalog)[0];
        if (fallback) {
          state.osName = fallback;
          state.osCategory = catalog[fallback]?.category || '';
        }
      }
      _hydrateAutoVmNameState(state);

      if (!state.systemReport && !state._systemReportLoading && window.vmInstaller?.checkSystem) {
        state._systemReportLoading = true;
        window.vmInstaller.checkSystem(state.installPath)
          .then((report) => {
            state.systemReport = report;
            if (typeof renderStep === 'function' && state.currentStep === 0) {
              renderStep(0);
            }
          })
          .catch(() => {
            // Keep UI usable without recommendations when system check fails.
          })
          .finally(() => {
            state._systemReportLoading = false;
          });
      }

      if (!state.vmName && state.osName) {
        _syncVmNameWithSelectedOs(state, { force: true });
      }
    },
    validate(state) {
      if (!state.osName) return { valid: false, message: 'Please select an OS to continue.' };
      return { valid: true };
    }
  },

  // ─── Step 2: ISO Fetch ─────────────────────────────────────────────
  fetchIso: {
    render(state) {
      const selected = state.defaults?.osCatalog?.[state.osName];
      const hasOfficial = !!selected?.downloadUrl;
      const source = state.isoSource || 'official';
      const defaultDownloadDir = state.downloadPath || state.defaults?.defaultDownloadDir || '';
      const officialIsoPath = (hasOfficial && defaultDownloadDir && selected?.filename)
        ? `${defaultDownloadDir}/${selected.filename}`
        : '';

      return `
        <div class="glass-card wizard-shell">
          ${renderStepIndicator(1)}
          <h2 class="step-title" style="margin-bottom: 8px; color: #fff;">ISO Selection</h2>
          <p class="step-description" style="color: #888; margin-bottom: 24px;">Download an official ISO or provide a path to a local ISO file.</p>
          
          <div class="wizard-section">
            <label style="display: block; margin-bottom: 8px; color: #fff;">Download Official ISO</label>
            <p style="font-size: 13px; color: #888; margin-bottom: 12px;">
              ${hasOfficial ? `Use catalog download for ${state.osName}.` : `No official URL for ${state.osName}. Use Local ISO instead.`}
            </p>
            <div style="display: flex; gap: 8px; margin-bottom: 10px;">
              <input type="text" id="downloadPathInput" value="${state.downloadPath || state.defaults?.defaultDownloadDir || ''}" placeholder="Select official ISO download folder" style="flex: 1; padding: 8px; background: #252526; border: 1px solid #444; color: #ccc; border-radius: 4px;" />
              <button class="btn btn-secondary" id="btnBrowseDownloadPath" style="background: #333; color: #ccc; border: 1px solid #444; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Browse</button>
            </div>
            ${officialIsoPath ? `<p style="font-size:12px; color:#9da7b3; margin-bottom:10px;">ISO will be stored at: ${officialIsoPath}</p>` : ''}
            <div style="display:flex; align-items:center; gap:10px;">
              <input type="radio" id="isoOfficial" name="isoSource" value="official" ${source !== 'custom' ? 'checked' : ''} ${!hasOfficial ? 'disabled' : ''}>
              <label for="isoOfficial">Use official catalog download</label>
            </div>
          </div>

          <div class="wizard-section">
            <label style="display: block; margin-bottom: 8px; color: #fff;">Local ISO File</label>
            <p style="font-size: 13px; color: #888; margin-bottom: 12px;">Already have an ISO? Provide the file path below.</p>
            <div style="display:flex; align-items:center; gap:10px; margin-bottom: 10px;">
              <input type="radio" id="isoCustom" name="isoSource" value="custom" ${source === 'custom' || !hasOfficial ? 'checked' : ''}>
              <label for="isoCustom">Use local ISO file</label>
            </div>
            <div style="display: flex; gap: 8px;">
              <input type="text" id="isoPathInput" value="${state.customIsoPath || ''}" placeholder="/path/to/image.iso" style="flex: 1; padding: 8px; background: #252526; border: 1px solid #444; color: #ccc; border-radius: 4px;" />
              <button class="btn btn-secondary" id="btnBrowseIso" style="background: #333; color: #ccc; border: 1px solid #444; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Browse</button>
            </div>
          </div>

          <div class="btn-row wizard-nav-row">
            <button class="btn btn-secondary wizard-nav-back" id="btnBack">← Back</button>
            <button class="btn btn-primary wizard-nav-next" id="btnNext">Next →</button>
          </div>
        </div>
      `;
    },
    init(state, app) {
      const isoInput = document.getElementById('isoPathInput');
      const downloadPathInput = document.getElementById('downloadPathInput');
      const radioOfficial = document.getElementById('isoOfficial');
      const radioCustom = document.getElementById('isoCustom');

      const syncMode = () => {
        state.isoSource = radioCustom?.checked ? 'custom' : 'official';
        const customMode = state.isoSource === 'custom';
        if (isoInput) isoInput.disabled = !customMode;
        const browse = document.getElementById('btnBrowseIso');
        if (browse) browse.disabled = !customMode;
        if (!customMode) state.customIsoPath = '';
      };

      isoInput?.addEventListener('input', (e) => {
        state.customIsoPath = e.target.value;
      });

      downloadPathInput?.addEventListener('input', (e) => {
        state.downloadPath = e.target.value;
      });

      radioOfficial?.addEventListener('change', syncMode);
      radioCustom?.addEventListener('change', syncMode);

      document.getElementById('btnBrowseIso')?.addEventListener('click', async () => {
        const selected = await window.vmInstaller.selectFile('Select ISO image', [
          { name: 'ISO Images', extensions: ['iso'] },
          { name: 'All Files', extensions: ['*'] }
        ]);
        if (selected) {
          if (isoInput) isoInput.value = selected;
          state.customIsoPath = selected;
          if (radioCustom) radioCustom.checked = true;
          syncMode();
        }
      });

      document.getElementById('btnBrowseDownloadPath')?.addEventListener('click', async () => {
        const selected = await window.vmInstaller.selectFolder('Select official ISO download folder', state.downloadPath || state.defaults?.defaultDownloadDir || '');
        if (selected) {
          state.downloadPath = selected;
          if (downloadPathInput) downloadPathInput.value = selected;
        }
      });

      syncMode();
    },
    validate(state) {
      if (state.isoSource === 'custom' && (!state.customIsoPath || state.customIsoPath.trim() === '')) {
        return { valid: false, message: 'Please provide or download an ISO image.' };
      }

      if (state.isoSource !== 'custom' && !state.defaults?.osCatalog?.[state.osName]?.downloadUrl) {
        return { valid: false, message: 'Selected OS has no official download URL. Choose Local ISO.' };
      }

      if (state.isoSource !== 'custom' && (!state.downloadPath || !state.downloadPath.trim())) {
        return { valid: false, message: 'Please select the folder where official ISO should be downloaded.' };
      }

      return { valid: true };
    }
  },

  // ─── Step 3: Setup Configuration ─────────────────────────────────────
  setupConfig: {
    render(state) {
      const caps = state?._resourcePolicyCaps || {};
      const maxRamMb = Math.max(1024, Number(caps.maxRamMb || 16384));
      const maxCpus = Math.max(1, Number(caps.maxCpus || 16));
      const ramValue = Math.max(1024, Math.min(parseInt(state.ram, 10) || 4096, maxRamMb));
      const cpuValue = Math.max(1, Math.min(parseInt(state.cpus, 10) || 2, maxCpus));
      state.ram = ramValue;
      state.cpus = cpuValue;
      const ramCapPct = Math.max(40, Math.min(95, parseInt(state.maxHostRamPercent, 10) || 75));
      const cpuCapPct = Math.max(40, Math.min(95, parseInt(state.maxHostCpuPercent, 10) || 75));

      return `
        <div class="glass-card wizard-shell">
          ${renderStepIndicator(2)}
          <h2 class="step-title" style="margin-bottom: 8px; color: #fff;">Hardware Setup</h2>
          <p class="step-description" style="color: #888; margin-bottom: 24px;">Configure standard hardware for your virtual OS. Policy caps: RAM ${ramCapPct}% host, CPU ${cpuCapPct}% host.</p>
          
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">
            <div class="config-group">
              <label style="display: block; margin-bottom: 8px; color: #fff;">V Os Name</label>
              <input type="text" id="vmName" value="${state.vmName || ''}" placeholder="My-${state.osName || 'V-OS'}" style="width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #ccc; border-radius: 4px; box-sizing: border-box;" />
            </div>
            
            <div class="config-group">
              <label style="display: block; margin-bottom: 8px; color: #fff;">Network Type</label>
              <select id="networkType" style="width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #ccc; border-radius: 4px; box-sizing: border-box;">
                <option value="nat" ${state.network === 'nat' ? 'selected' : ''}>NAT (Default)</option>
                <option value="bridged" ${state.network === 'bridged' ? 'selected' : ''}>Bridged Adapter</option>
                <option value="hostonly" ${state.network === 'hostonly' ? 'selected' : ''}>Host-Only Adapter</option>
              </select>
            </div>

            <div class="config-group" style="grid-column: 1 / -1;">
              <label style="display: block; margin-bottom: 8px; color: #fff;">V Os Install Folder</label>
              <div style="display: flex; gap: 8px;">
                <input type="text" id="vmInstallPath" value="${state.installPath || state.defaults?.defaultInstallPath || ''}" placeholder="Select where V Os files should be stored" style="flex: 1; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #ccc; border-radius: 4px; box-sizing: border-box;" />
                <button class="btn btn-secondary" id="btnBrowseVmInstallPath" type="button">Browse</button>
              </div>
            </div>

            <div class="config-group">
              <label style="display: block; margin-bottom: 8px; color: #fff;">RAM: <span id="ramLabel">${ramValue}</span> MB</label>
              <input type="range" id="ram" min="1024" max="${maxRamMb}" step="1024" value="${ramValue}" style="width: 100%;" />
            </div>

            <div class="config-group">
              <label style="display: block; margin-bottom: 8px; color: #fff;">CPU Cores: <span id="cpuLabel">${cpuValue}</span></label>
              <input type="range" id="cpus" min="1" max="${maxCpus}" step="1" value="${cpuValue}" style="width: 100%;" />
            </div>

            <div class="config-group" style="grid-column: 1 / -1;">
              <label style="display: block; margin-bottom: 8px; color: #fff;">Disk Size: <span id="diskLabel">${Math.floor((state.disk || 25600) / 1024)}</span> GB</label>
              <input type="range" id="disk" min="10240" max="256000" step="10240" value="${state.disk || 25600}" style="width: 100%;" />
            </div>
          </div>

          <div class="btn-row wizard-nav-row">
            <button class="btn btn-secondary wizard-nav-back" id="btnBack">← Back</button>
            <button class="btn btn-primary wizard-nav-next" id="btnNext">Next →</button>
          </div>
        </div>
      `;
    },
    init(state, app) {
      _hydrateAutoVmNameState(state);
      _syncVmNameWithSelectedOs(state);
      const n = document.getElementById('vmName');
      if (n && state.vmName) n.value = state.vmName;
      document.getElementById('vmName')?.addEventListener('input', e => state.vmName = e.target.value);
      document.getElementById('networkType')?.addEventListener('change', e => state.network = e.target.value);
      document.getElementById('vmInstallPath')?.addEventListener('input', (e) => {
        state.installPath = e.target.value;
      });

      document.getElementById('btnBrowseVmInstallPath')?.addEventListener('click', async () => {
        const selected = await window.vmInstaller.selectFolder('Select V Os install folder', state.installPath || state.defaults?.defaultInstallPath || '');
        if (!selected) return;
        state.installPath = selected;
        const input = document.getElementById('vmInstallPath');
        if (input) input.value = selected;
      });
      
      const ram = document.getElementById('ram');
      ram?.addEventListener('input', e => {
        const max = parseInt(ram.max, 10) || 16384;
        state.ram = Math.max(1024, Math.min(parseInt(e.target.value, 10) || 4096, max));
        document.getElementById('ramLabel').innerText = state.ram;
      });
      
      const cpus = document.getElementById('cpus');
      cpus?.addEventListener('input', e => {
        const max = parseInt(cpus.max, 10) || 16;
        state.cpus = Math.max(1, Math.min(parseInt(e.target.value, 10) || 2, max));
        document.getElementById('cpuLabel').innerText = state.cpus;
      });
      
      const disk = document.getElementById('disk');
      disk?.addEventListener('input', e => { state.disk = parseInt(e.target.value, 10); document.getElementById('diskLabel').innerText = Math.floor(state.disk / 1024); });
    },
    validate(state) {
      if (!state.vmName) return { valid: false, message: 'Please provide a V Os name.' };
      if (!state.installPath || !String(state.installPath).trim()) return { valid: false, message: 'Please select V Os install folder.' };
      return { valid: true };
    }
  },

  // ─── Step 4: Advanced Options ────────────────────────────────────────
  advanced: {
    render(state) {
      const accountType = state.accountType === 'user' ? 'user' : 'guest';
      const defaultUserUsername = String(state.defaultUserUsername || 'user').trim() || 'user';
      const defaultUserPassword = String(state.defaultUserPassword ?? 'user');
      const guestUsername = String(state.guestUsername || 'guest').trim() || 'guest';
      const guestPassword = String(state.guestPassword ?? 'guest');
      const defaultUsername = accountType === 'user' ? defaultUserUsername : guestUsername;
      const defaultPassword = accountType === 'user' ? defaultUserPassword : guestPassword;
      const accountLabel = accountType === 'user' ? 'User Credentials' : 'Guest User';
      const accountHint = accountType === 'user'
        ? `Default credentials are ${defaultUserUsername} / ${defaultUserPassword}. You can change them here.`
        : `Default credentials are ${guestUsername} / ${guestPassword}. You can change them here.`;
      return `
        <div class="glass-card wizard-shell">
          ${renderStepIndicator(3)}
          <h2 class="step-title" style="margin-bottom: 8px; color: #fff;">Advanced Options</h2>
          <p class="step-description" style="color: #888; margin-bottom: 24px;">Configure guest features and integrations.</p>
          
          <div class="wizard-section">
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
              <input type="checkbox" id="cbClipboard" ${state.clipboardMode !== 'disabled' ? 'checked' : ''} style="width: 16px; height: 16px;" />
              <div>
                <label for="cbClipboard" style="color: #fff; display: block;">Bidirectional Clipboard</label>
                <span style="font-size: 12px; color: #888;">Copy and paste between host and guest.</span>
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
              <input type="checkbox" id="cbDnD" ${state.dragAndDrop !== 'disabled' ? 'checked' : ''} style="width: 16px; height: 16px;" />
              <div>
                <label for="cbDnD" style="color: #fff; display: block;">Drag & Drop</label>
                <span style="font-size: 12px; color: #888;">Drag files directly into the virtual OS.</span>
              </div>
            </div>

            <hr style="border: 0; border-top: 1px solid #333; margin: 16px 0;" />

            <div>
              <label class="form-label" style="display:flex; align-items:center; gap:10px; margin-bottom:10px; color:#fff;">
                <input type="checkbox" id="cbFullscreen" ${state.startFullscreen !== false ? 'checked' : ''} style="width: 16px; height: 16px;" />
                Guest OS display in fullscreen resolution
              </label>
            </div>
            <div>
              <label class="form-label" style="display:flex; align-items:center; gap:10px; margin-bottom:10px; color:#fff;">
                <input type="checkbox" id="cb3dAcceleration" ${state.accelerate3d === true ? 'checked' : ''} style="width: 16px; height: 16px;" />
                Enable 3D Acceleration
              </label>
            </div>

            <div>
              <label class="form-label" style="display:flex; align-items:center; gap:10px; margin-bottom:10px; color:#fff;">
                <input type="checkbox" id="cbEnableSharedFolder" ${state.enableSharedFolder ? 'checked' : ''} style="width: 16px; height: 16px;" />
                Enable Shared Folder
              </label>
              <label style="display: block; margin-bottom: 8px; color: #fff;">Shared Folder (Optional)</label>
              <div style="display: flex; gap: 8px;">
                <input type="text" id="sharedFolder" value="${state.sharedFolderPath || ''}" placeholder="/path/to/host/folder" style="flex: 1; padding: 8px; background: #252526; border: 1px solid #444; color: #ccc; border-radius: 4px;" />
                <button class="btn btn-secondary" id="btnBrowseSharedFolder" type="button">Browse</button>
              </div>
              <p style="font-size: 12px; color: #888; margin-top: 8px;">Mount a directory from your host to the guest.</p>
            </div>

            <hr style="border: 0; border-top: 1px solid #333; margin: 16px 0;" />

            <div>
              <label style="display:block; margin-bottom:8px; color:#fff;">Account Type</label>
              <select id="accountType" style="width:100%; padding:8px; background:#252526; border:1px solid #444; color:#ccc; border-radius:4px; margin-bottom:10px;">
                <option value="guest" ${accountType === 'guest' ? 'selected' : ''}>Guest</option>
                <option value="user" ${accountType === 'user' ? 'selected' : ''}>User</option>
              </select>
              <p style="font-size:12px; color:#888; margin-top: 4px; margin-bottom: 10px;">Choose account style, then customize username/password if needed.</p>

              <label id="accountCredentialsLabel" style="display:block; margin-bottom:8px; color:#fff;">${accountLabel}</label>
              <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <input type="text" id="guestUsername" value="${state.username || defaultUsername}" placeholder="Username" style="padding: 8px; background: #252526; border: 1px solid #444; color: #ccc; border-radius: 4px;" />
                <input type="text" id="guestPassword" value="${state.password || defaultPassword}" placeholder="Password" style="padding: 8px; background: #252526; border: 1px solid #444; color: #ccc; border-radius: 4px;" />
              </div>
              <p id="accountCredentialsHint" style="font-size: 12px; color: #888; margin-top: 8px;">${accountHint}</p>
            </div>
          </div>

          <div class="btn-row wizard-nav-row">
            <button class="btn btn-secondary wizard-nav-back" id="btnBack">← Back</button>
            <button class="btn btn-primary wizard-nav-next" id="btnNext">Next →</button>
          </div>
        </div>
      `;
    },
    init(state, app) {
      const enableSharedFolderCheckbox = document.getElementById('cbEnableSharedFolder');
      const sharedFolderInput = document.getElementById('sharedFolder');
      const sharedBrowseBtn = document.getElementById('btnBrowseSharedFolder');

      const syncSharedFolderUi = () => {
        state.enableSharedFolder = !!enableSharedFolderCheckbox?.checked;
        const disabled = !state.enableSharedFolder;
        if (sharedFolderInput) sharedFolderInput.disabled = disabled;
        if (sharedBrowseBtn) sharedBrowseBtn.disabled = disabled;
        if (disabled) {
          state.sharedFolderPath = '';
          if (sharedFolderInput) sharedFolderInput.value = '';
        }
      };

      document.getElementById('sharedFolder')?.addEventListener('input', e => {
        state.sharedFolderPath = e.target.value;
      });

      document.getElementById('btnBrowseSharedFolder')?.addEventListener('click', async () => {
        const selected = await window.vmInstaller.selectFolder('Select shared folder path', state.sharedFolderPath || state.defaults?.defaultSharedFolder || '');
        if (!selected) return;
        state.sharedFolderPath = selected;
        if (sharedFolderInput) sharedFolderInput.value = selected;
      });

      document.getElementById('cbClipboard')?.addEventListener('change', (e) => {
        state.clipboardMode = e.target.checked ? 'bidirectional' : 'disabled';
      });
      document.getElementById('cbDnD')?.addEventListener('change', (e) => {
        state.dragAndDrop = e.target.checked ? 'bidirectional' : 'disabled';
      });
      document.getElementById('cbFullscreen')?.addEventListener('change', (e) => {
        state.startFullscreen = !!e.target.checked;
      });
      document.getElementById('cb3dAcceleration')?.addEventListener('change', (e) => {
        state.accelerate3d = !!e.target.checked;
      });
      document.getElementById('accountType')?.addEventListener('change', (e) => {
        const selectedType = e.target.value === 'user' ? 'user' : 'guest';
        state.accountType = selectedType;

        const guestUsername = document.getElementById('guestUsername');
        const guestPassword = document.getElementById('guestPassword');
        const accountCredentialsLabel = document.getElementById('accountCredentialsLabel');
        const accountCredentialsHint = document.getElementById('accountCredentialsHint');
        const syncAccountCopy = () => {
          if (accountCredentialsLabel) {
            accountCredentialsLabel.textContent = selectedType === 'user' ? 'User Credentials' : 'Guest User';
          }
          if (accountCredentialsHint) {
            accountCredentialsHint.textContent = selectedType === 'user'
              ? `Default credentials are ${state.defaultUserUsername || 'user'} / ${state.defaultUserPassword ?? 'user'}. You can change them here.`
              : `Default credentials are ${state.guestUsername || 'guest'} / ${state.guestPassword ?? 'guest'}. You can change them here.`;
          }
        };

        if (selectedType === 'guest') {
          state.username = String(state.guestUsername || 'guest').trim() || 'guest';
          state.password = String(state.guestPassword ?? 'guest');
        } else {
          state.username = String(state.defaultUserUsername || 'user').trim() || 'user';
          state.password = String(state.defaultUserPassword ?? 'user');
        }

        if (guestUsername) guestUsername.value = state.username;
        if (guestPassword) guestPassword.value = state.password;
        syncAccountCopy();
      });
      enableSharedFolderCheckbox?.addEventListener('change', syncSharedFolderUi);
      document.getElementById('guestUsername')?.addEventListener('input', (e) => {
        state.username = e.target.value;
      });
      document.getElementById('guestPassword')?.addEventListener('input', (e) => {
        state.password = e.target.value;
      });

      syncSharedFolderUi();
    },
    validate(state) {
      if (!state.username || !String(state.username).trim()) {
        return { valid: false, message: 'Please enter username.' };
      }
      if (!state.password || !String(state.password).trim()) {
        return { valid: false, message: 'Please enter password.' };
      }
      if (state.enableSharedFolder && !String(state.sharedFolderPath || '').trim()) {
        return { valid: false, message: 'Enable shared folder requires a host folder path.' };
      }
      return { valid: true };
    }
  },

  // ─── Step 5: Review + Create ─────────────────────────────────────────
  review: {
    render(state) {
      const selectedOs = state.defaults?.osCatalog?.[state.osName] || null;
      const downloadDir = state.defaults?.defaultDownloadDir || '';
      const officialIsoPath = (selectedOs?.filename && downloadDir)
        ? `${downloadDir}/${selectedOs.filename}`
        : 'Will be downloaded automatically';
      const isoDisplay = state.isoSource === 'custom'
        ? (state.customIsoPath || 'Not set')
        : officialIsoPath;

      const existingVMs = Array.isArray(state.existingVMs) ? state.existingVMs : [];
      const selectedExisting = state.existingVmName || '';
      const existingOptions = existingVMs.length > 0
        ? existingVMs.map((vm) => {
          const vmName = String(vm.name || '');
          const vmState = String(vm.state || 'unknown');
          return `<option value="${escapeHtml(vmName)}" ${vmName === selectedExisting ? 'selected' : ''}>${escapeHtml(vmName)} (${escapeHtml(vmState)})</option>`;
        }).join('')
        : '<option value="">No registered V Os found</option>';

      return `
        <div class="glass-card wizard-shell">
          ${renderStepIndicator(4)}
          <h2 class="step-title" style="margin-bottom: 8px; color: #fff;">Review & Create</h2>
          <p class="step-description" style="color: #888; margin-bottom: 24px;">Review your virtual OS configuration before creating it.</p>
          
          <div class="wizard-section wizard-summary-grid" style="font-size: 14px;">
            <div style="display: grid; grid-template-columns: 150px 1fr; gap: 12px; margin-bottom: 8px;">
              <span style="color: #888;">Name:</span>
              <strong style="color: #fff;">${state.vmName}</strong>
              
              <span style="color: #888;">OS Image:</span>
              <strong style="color: #fff;">${state.osName}</strong>
              
              <span style="color: #888;">ISO Path:</span>
              <span style="color: #ccc; word-break: break-all;">${isoDisplay}</span>
              
              <span style="color: #888;">CPU:</span>
              <strong style="color: #fff;">${state.cpus} Cores</strong>
              
              <span style="color: #888;">Memory:</span>
              <strong style="color: #fff;">${Math.round(state.ram / 1024)} GB</strong>
              
              <span style="color: #888;">Storage:</span>
              <strong style="color: #fff;">${Math.floor(state.disk / 1024)} GB</strong>
              
              <span style="color: #888;">Network:</span>
              <span style="color: #ccc;">${state.network || 'nat'}</span>

              <span style="color: #888;">V Os Folder:</span>
              <span style="color: #ccc; word-break: break-all;">${state.installPath || '-'}</span>

              <span style="color: #888;">ISO Download Folder:</span>
              <span style="color: #ccc; word-break: break-all;">${state.downloadPath || state.defaults?.defaultDownloadDir || '-'}</span>

              <span style="color: #888;">Guest Display Fullscreen:</span>
              <span style="color: #ccc;">${state.startFullscreen !== false ? 'Enabled' : 'Disabled'}</span>

              <span style="color: #888;">3D Acceleration:</span>
              <span style="color: #ccc;">${state.accelerate3d === true ? 'Enabled' : 'Disabled'}</span>

              <span style="color: #888;">Shared Folder:</span>
              <span style="color: #ccc; word-break: break-all;">${state.enableSharedFolder ? (state.sharedFolderPath || '-') : 'Disabled'}</span>

              <span style="color: #888;">Guest Account:</span>
              <span style="color: #ccc;">${state.username || 'guest'} / ${state.password || 'guest'}</span>

              <span style="color: #888;">Account Type:</span>
              <span style="color: #ccc;">${state.accountType === 'user' ? 'User' : 'Guest'}</span>
            </div>
          </div>

          <div class="wizard-section wizard-section-muted" style="margin-top: 14px; padding: 12px;">
            <div style="font-size: 12px; color: #9da7b3; margin-bottom: 10px;">V Os Source</div>
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
              <input type="checkbox" id="useExistingVm" ${state.useExistingVm ? 'checked' : ''} style="width:16px; height:16px;" />
              <label for="useExistingVm" style="color:#fff;">Use an already downloaded V Os (registered V Os or selected folder)</label>
            </div>

            <div id="existingVmSection" style="display:${state.useExistingVm ? 'block' : 'none'}; padding:10px; border:1px solid #2f3640; border-radius:6px; background:#151a20; margin-bottom:10px;">
              <label style="display:block; margin-bottom:6px; color:#fff;">Registered V Os</label>
              <select id="existingVmSelect" style="width:100%; padding:8px; background:#252526; border:1px solid #444; color:#ccc; border-radius:4px; margin-bottom:10px;">
                <option value="">-- Select registered V Os --</option>
                ${existingOptions}
              </select>

              <label style="display:block; margin-bottom:6px; color:#fff;">Or select downloaded V Os folder</label>
              <div style="display:flex; gap:8px;">
                <input type="text" id="existingVmFolder" value="${state.existingVmFolder || ''}" placeholder="Path containing .vbox file" style="flex:1; padding:8px; background:#252526; border:1px solid #444; color:#ccc; border-radius:4px;" />
                <button class="btn btn-secondary" id="btnBrowseExistingVmFolder" type="button">Browse</button>
                <button class="btn" id="btnScanExistingVmFolder" type="button">Detect V Os</button>
              </div>
              <div id="existingVmFolderResult" style="margin-top:8px; font-size:12px; color:#9da7b3;">Pick a registered V Os, or browse a folder with a downloaded V Os.</div>
            </div>

          </div>

          <div class="wizard-section wizard-section-muted" style="margin-top: 14px; padding: 12px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
              <div style="font-size: 12px; color: #9da7b3;">Preflight Simulation</div>
              <button class="btn btn-secondary" id="btnPreflight" type="button">Run Preflight</button>
            </div>
            <div id="preflightResult" style="margin-top:8px; font-size:12px; color:#9da7b3;">Run preflight to verify system, VirtualBox, and setup inputs before creation.</div>
          </div>

          <div class="btn-row wizard-nav-row">
            <button class="btn btn-secondary wizard-nav-back" id="btnBack">← Back</button>
            <button class="btn btn-primary wizard-nav-next wizard-create-btn" id="btnNext">Create V Os</button>
          </div>
        </div>
      `;
    },
    init(state, app) {
      const useExistingCheckbox = document.getElementById('useExistingVm');
      const existingSection = document.getElementById('existingVmSection');
      const existingSelect = document.getElementById('existingVmSelect');
      const existingFolderInput = document.getElementById('existingVmFolder');
      const existingResult = document.getElementById('existingVmFolderResult');

      const syncExistingSection = () => {
        state.useExistingVm = !!useExistingCheckbox?.checked;
        if (existingSection) {
          existingSection.style.display = state.useExistingVm ? 'block' : 'none';
        }
      };

      useExistingCheckbox?.addEventListener('change', syncExistingSection);

      existingSelect?.addEventListener('change', (e) => {
        state.existingVmName = e.target.value || '';
      });

      existingFolderInput?.addEventListener('input', (e) => {
        state.existingVmFolder = e.target.value || '';
      });

      document.getElementById('btnBrowseExistingVmFolder')?.addEventListener('click', async () => {
        const selected = await window.vmInstaller.selectFolder('Select downloaded V Os folder', state.existingVmFolder || '');
        if (!selected) return;
        state.existingVmFolder = selected;
        if (existingFolderInput) existingFolderInput.value = selected;
      });

      document.getElementById('btnScanExistingVmFolder')?.addEventListener('click', async () => {
        if (!window.vmInstaller?.resolveVMFromFolder) {
          if (existingResult) {
            existingResult.textContent = 'Folder V Os detection is not available in this build.';
            existingResult.style.color = '#f85149';
          }
          return;
        }

        const folder = (existingFolderInput?.value || '').trim();
        state.existingVmFolder = folder;

        if (!folder) {
          if (existingResult) {
            existingResult.textContent = 'Select a folder first.';
            existingResult.style.color = '#f85149';
          }
          return;
        }

        if (existingResult) {
          existingResult.textContent = 'Detecting V Os in selected folder...';
          existingResult.style.color = '#9da7b3';
        }

        const detected = await window.vmInstaller.resolveVMFromFolder(folder, { registerIfNeeded: false });
        if (!detected?.success) {
          if (existingResult) {
            existingResult.textContent = detected?.error || 'Could not find a V Os in this folder.';
            existingResult.style.color = '#f85149';
          }
          return;
        }

        state.existingVmName = detected.vmName || state.existingVmName;
        state.vmName = state.existingVmName || state.vmName;

        if (existingResult) {
          existingResult.textContent = detected.registered
            ? `Detected registered V Os: ${detected.vmName}`
            : `Detected V Os config: ${detected.vmName}. It will be imported during setup.`;
          existingResult.style.color = '#2ea043';
        }
      });

      syncExistingSection();

      document.getElementById('btnPreflight')?.addEventListener('click', async () => {
        const resultEl = document.getElementById('preflightResult');
        const button = document.getElementById('btnPreflight');
        if (button) {
          button.disabled = true;
          button.textContent = 'Checking...';
        }

        if (resultEl) {
          resultEl.textContent = 'Running preflight checks...';
          resultEl.style.color = '#9da7b3';
        }

        try {
          const report = await window.vmInstaller.checkSystem(state.installPath);
          let vbox = await window.vmInstaller.detectVBox();

          const missing = [];
          if (!state.vmName) missing.push('V Os name');
          if (state.isoSource === 'custom' && !state.customIsoPath) missing.push('ISO path');
          if (!state.osName) missing.push('OS version');

          const failedChecks = (report.checks || []).filter((c) => c.status === 'fail');

          if (failedChecks.length > 0 || missing.length > 0 || !vbox.installed) {
            const reasons = [
              ...failedChecks.map((c) => `${c.name}: ${c.message}`),
              ...(vbox.installed ? [] : ['VirtualBox: not installed/detected (install it from the dedicated VirtualBox panel first)']),
              ...(missing.length > 0 ? [`Missing fields: ${missing.join(', ')}`] : [])
            ];

            if (resultEl) {
              resultEl.textContent = `Preflight failed: ${reasons.join(' | ')}`;
              resultEl.style.color = '#f85149';
            }
          } else {
            if (resultEl) {
              resultEl.textContent = 'Preflight passed. System and configuration look ready for installation.';
              resultEl.style.color = '#2ea043';
            }
          }
        } catch (err) {
          if (resultEl) {
            resultEl.textContent = `Preflight error: ${err.message || 'Unknown error'}`;
            resultEl.style.color = '#f85149';
          }
        } finally {
          if (button) {
            button.disabled = false;
            button.textContent = 'Run Preflight';
          }
        }
      });

      document.getElementById('btnNext')?.addEventListener('click', () => {
        if (typeof app !== 'undefined' && typeof app.startSetup === 'function') {
          app.startSetup(); 
        } else if (typeof startSetup === 'function') {
          startSetup(); 
        } else {
           console.log('App startSetup missing');
           alert('V Os Creation Initiated!');
        }
      });
    },
    validate(state) {
      if (state.useExistingVm) {
        const hasName = !!String(state.existingVmName || '').trim();
        const hasFolder = !!String(state.existingVmFolder || '').trim();
        if (!hasName && !hasFolder) {
          return { valid: false, message: 'Select an existing V Os from list or choose a downloaded V Os folder.' };
        }
        return { valid: true };
      }

      return { valid: true };
    }
  }
};

if (typeof module !== 'undefined') module.exports = WizardSteps;
