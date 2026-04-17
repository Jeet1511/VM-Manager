/**
 * renderer/components/wizard-steps.js — Wizard Step Templates
 * 
 * 5-Step VM Creation Flow Customization.
 */

const renderStepIndicator = (activeIdx) => {
  const steps = ['Choose OS', 'ISO Fetch', 'Hardware', 'Advanced', 'Review'];
  return `
    <div class="step-indicator" id="stepIndicator" style="display: flex; gap: 10px; margin-bottom: 24px; padding: 12px; background: #1e1e1e; border-radius: 6px; border: 1px solid #333;">
      ${steps.map((s, i) => `
        <div class="step-item ${i === activeIdx ? 'active' : ''} ${i < activeIdx ? 'completed' : ''}" style="color: ${i === activeIdx ? '#fff' : (i < activeIdx ? '#8a8a8a' : '#555')}; display: flex; align-items: center; gap: 8px; font-size: 13px;">
          <div class="step-circle" style="width: 20px; height: 20px; border-radius: 50%; background: ${i === activeIdx ? '#007acc' : (i < activeIdx ? '#2ea043' : '#333')}; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #fff;">
            ${i < activeIdx ? '✓' : i + 1}
          </div>
          ${s}
          ${i < steps.length - 1 ? '<div style="width: 20px; height: 1px; background: #333; margin-left: 8px;"></div>' : ''}
        </div>
      `).join('')}
    </div>
  `;
};

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
        <div class="glass-card" style="max-width: 800px; margin: 0 auto; color: #ccc;">
          ${renderStepIndicator(0)}
          <h2 class="step-title" style="margin-bottom: 8px; color: #fff;">Choose OS</h2>
          <p class="step-description" style="color: #888; margin-bottom: 24px;">Choose OS family and version from the official catalog.</p>

          <div style="margin-bottom: 16px; background:#161b22; border:1px solid #2d333b; border-radius:6px; padding:12px;">
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

          <div style="background: #1e1e1e; border: 1px solid #333; border-radius: 6px; padding: 16px; margin-bottom: 24px;">
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

          <div class="btn-row" style="display: flex; justify-content: space-between; margin-top: 32px;">
            <div></div> <!-- No back button on first step -->
            <button class="btn btn-primary" id="btnNext" style="background: #007acc; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Next →</button>
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
        const compactName = state.osName.replace(/\s*\(.+\)$/, '').replace(/\s+/g, '-');
        state.vmName = `My-${compactName}`;
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

      return `
        <div class="glass-card" style="max-width: 800px; margin: 0 auto; color: #ccc;">
          ${renderStepIndicator(1)}
          <h2 class="step-title" style="margin-bottom: 8px; color: #fff;">ISO Selection</h2>
          <p class="step-description" style="color: #888; margin-bottom: 24px;">Download an official ISO or provide a path to a local ISO file.</p>
          
          <div style="background: #1e1e1e; border: 1px solid #333; padding: 16px; border-radius: 6px; margin-bottom: 16px;">
            <label style="display: block; margin-bottom: 8px; color: #fff;">Download Official ISO</label>
            <p style="font-size: 13px; color: #888; margin-bottom: 12px;">
              ${hasOfficial ? `Use catalog download for ${state.osName}.` : `No official URL for ${state.osName}. Use Local ISO instead.`}
            </p>
            <div style="display:flex; align-items:center; gap:10px;">
              <input type="radio" id="isoOfficial" name="isoSource" value="official" ${source !== 'custom' ? 'checked' : ''} ${!hasOfficial ? 'disabled' : ''}>
              <label for="isoOfficial">Use official catalog download</label>
            </div>
          </div>

          <div style="background: #1e1e1e; border: 1px solid #333; padding: 16px; border-radius: 6px;">
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

          <div class="btn-row" style="display: flex; justify-content: space-between; margin-top: 32px;">
            <button class="btn btn-secondary" id="btnBack" style="background: #333; color: #ccc; border: 1px solid #444; padding: 8px 16px; border-radius: 4px; cursor: pointer;">← Back</button>
            <button class="btn btn-primary" id="btnNext" style="background: #007acc; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Next →</button>
          </div>
        </div>
      `;
    },
    init(state, app) {
      const isoInput = document.getElementById('isoPathInput');
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

      syncMode();
    },
    validate(state) {
      if (state.isoSource === 'custom' && (!state.customIsoPath || state.customIsoPath.trim() === '')) {
        return { valid: false, message: 'Please provide or download an ISO image.' };
      }

      if (state.isoSource !== 'custom' && !state.defaults?.osCatalog?.[state.osName]?.downloadUrl) {
        return { valid: false, message: 'Selected OS has no official download URL. Choose Local ISO.' };
      }

      return { valid: true };
    }
  },

  // ─── Step 3: Setup Configuration ─────────────────────────────────────
  setupConfig: {
    render(state) {
      return `
        <div class="glass-card" style="max-width: 800px; margin: 0 auto; color: #ccc;">
          ${renderStepIndicator(2)}
          <h2 class="step-title" style="margin-bottom: 8px; color: #fff;">Hardware Setup</h2>
          <p class="step-description" style="color: #888; margin-bottom: 24px;">Configure standard hardware for your virtual machine.</p>
          
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">
            <div class="config-group">
              <label style="display: block; margin-bottom: 8px; color: #fff;">VM Name</label>
              <input type="text" id="vmName" value="${state.vmName || ''}" placeholder="My-${state.osName || 'VM'}" style="width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #ccc; border-radius: 4px; box-sizing: border-box;" />
            </div>
            
            <div class="config-group">
              <label style="display: block; margin-bottom: 8px; color: #fff;">Network Type</label>
              <select id="networkType" style="width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #ccc; border-radius: 4px; box-sizing: border-box;">
                <option value="nat" ${state.network === 'nat' ? 'selected' : ''}>NAT (Default)</option>
                <option value="bridged" ${state.network === 'bridged' ? 'selected' : ''}>Bridged Adapter</option>
                <option value="hostonly" ${state.network === 'hostonly' ? 'selected' : ''}>Host-Only Adapter</option>
              </select>
            </div>

            <div class="config-group">
              <label style="display: block; margin-bottom: 8px; color: #fff;">RAM: <span id="ramLabel">${state.ram || 4096}</span> MB</label>
              <input type="range" id="ram" min="1024" max="16384" step="1024" value="${state.ram || 4096}" style="width: 100%;" />
            </div>

            <div class="config-group">
              <label style="display: block; margin-bottom: 8px; color: #fff;">CPU Cores: <span id="cpuLabel">${state.cpus || 2}</span></label>
              <input type="range" id="cpus" min="1" max="16" step="1" value="${state.cpus || 2}" style="width: 100%;" />
            </div>

            <div class="config-group" style="grid-column: 1 / -1;">
              <label style="display: block; margin-bottom: 8px; color: #fff;">Disk Size: <span id="diskLabel">${Math.floor((state.disk || 25600) / 1024)}</span> GB</label>
              <input type="range" id="disk" min="10240" max="256000" step="10240" value="${state.disk || 25600}" style="width: 100%;" />
            </div>
          </div>

          <div class="btn-row" style="display: flex; justify-content: space-between; margin-top: 32px;">
            <button class="btn btn-secondary" id="btnBack" style="background: #333; color: #ccc; border: 1px solid #444; padding: 8px 16px; border-radius: 4px; cursor: pointer;">← Back</button>
            <button class="btn btn-primary" id="btnNext" style="background: #007acc; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Next →</button>
          </div>
        </div>
      `;
    },
    init(state, app) {
      if(!state.vmName && state.osName) {
        state.vmName = 'My-' + state.osName;
        const n = document.getElementById('vmName');
        if(n) n.value = state.vmName;
      }
      document.getElementById('vmName')?.addEventListener('input', e => state.vmName = e.target.value);
      document.getElementById('networkType')?.addEventListener('change', e => state.network = e.target.value);
      
      const ram = document.getElementById('ram');
      ram?.addEventListener('input', e => { state.ram = parseInt(e.target.value, 10); document.getElementById('ramLabel').innerText = state.ram; });
      
      const cpus = document.getElementById('cpus');
      cpus?.addEventListener('input', e => { state.cpus = parseInt(e.target.value, 10); document.getElementById('cpuLabel').innerText = state.cpus; });
      
      const disk = document.getElementById('disk');
      disk?.addEventListener('input', e => { state.disk = parseInt(e.target.value, 10); document.getElementById('diskLabel').innerText = Math.floor(state.disk / 1024); });
    },
    validate(state) {
      if (!state.vmName) return { valid: false, message: 'Please provide a VM name.' };
      return { valid: true };
    }
  },

  // ─── Step 4: Advanced Options ────────────────────────────────────────
  advanced: {
    render(state) {
      return `
        <div class="glass-card" style="max-width: 800px; margin: 0 auto; color: #ccc;">
          ${renderStepIndicator(3)}
          <h2 class="step-title" style="margin-bottom: 8px; color: #fff;">Advanced Options</h2>
          <p class="step-description" style="color: #888; margin-bottom: 24px;">Configure guest features and integrations.</p>
          
          <div style="background: #1e1e1e; border: 1px solid #333; padding: 16px; border-radius: 6px; margin-bottom: 16px;">
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
                <span style="font-size: 12px; color: #888;">Drag files directly into the virtual machine.</span>
              </div>
            </div>

            <hr style="border: 0; border-top: 1px solid #333; margin: 16px 0;" />

            <div>
              <label style="display: block; margin-bottom: 8px; color: #fff;">Shared Folder (Optional)</label>
              <div style="display: flex; gap: 8px;">
                <input type="text" id="sharedFolder" value="${state.sharedFolderPath || ''}" placeholder="/path/to/host/folder" style="flex: 1; padding: 8px; background: #252526; border: 1px solid #444; color: #ccc; border-radius: 4px;" />
              </div>
              <p style="font-size: 12px; color: #888; margin-top: 8px;">Mount a directory from your host to the guest.</p>
            </div>
          </div>

          <div class="btn-row" style="display: flex; justify-content: space-between; margin-top: 32px;">
            <button class="btn btn-secondary" id="btnBack" style="background: #333; color: #ccc; border: 1px solid #444; padding: 8px 16px; border-radius: 4px; cursor: pointer;">← Back</button>
            <button class="btn btn-primary" id="btnNext" style="background: #007acc; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Next →</button>
          </div>
        </div>
      `;
    },
    init(state, app) {
      document.getElementById('sharedFolder')?.addEventListener('input', e => {
        state.sharedFolderPath = e.target.value;
      });
      document.getElementById('cbClipboard')?.addEventListener('change', (e) => {
        state.clipboardMode = e.target.checked ? 'bidirectional' : 'disabled';
      });
      document.getElementById('cbDnD')?.addEventListener('change', (e) => {
        state.dragAndDrop = e.target.checked ? 'bidirectional' : 'disabled';
      });
    },
    validate(state) {
      return { valid: true };
    }
  },

  // ─── Step 5: Review + Create ─────────────────────────────────────────
  review: {
    render(state) {
      return `
        <div class="glass-card" style="max-width: 800px; margin: 0 auto; color: #ccc;">
          ${renderStepIndicator(4)}
          <h2 class="step-title" style="margin-bottom: 8px; color: #fff;">Review & Create</h2>
          <p class="step-description" style="color: #888; margin-bottom: 24px;">Review your virtual machine configuration before creating it.</p>
          
          <div style="background: #1e1e1e; border: 1px solid #333; padding: 16px; border-radius: 6px; font-size: 14px;">
            <div style="display: grid; grid-template-columns: 150px 1fr; gap: 12px; margin-bottom: 8px;">
              <span style="color: #888;">Name:</span>
              <strong style="color: #fff;">${state.vmName}</strong>
              
              <span style="color: #888;">OS Image:</span>
              <strong style="color: #fff;">${state.osName}</strong>
              
              <span style="color: #888;">ISO Path:</span>
              <span style="color: #ccc; word-break: break-all;">${state.customIsoPath}</span>
              
              <span style="color: #888;">CPU:</span>
              <strong style="color: #fff;">${state.cpus} Cores</strong>
              
              <span style="color: #888;">Memory:</span>
              <strong style="color: #fff;">${Math.round(state.ram / 1024)} GB</strong>
              
              <span style="color: #888;">Storage:</span>
              <strong style="color: #fff;">${Math.floor(state.disk / 1024)} GB</strong>
              
              <span style="color: #888;">Network:</span>
              <span style="color: #ccc;">${state.network || 'nat'}</span>
            </div>
          </div>

          <div style="margin-top: 14px; background: #1a1f26; border: 1px solid #2a2f36; border-radius: 6px; padding: 12px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
              <div style="font-size: 12px; color: #9da7b3;">Preflight Simulation</div>
              <button class="btn btn-secondary" id="btnPreflight" type="button">Run Preflight</button>
            </div>
            <div id="preflightResult" style="margin-top:8px; font-size:12px; color:#9da7b3;">Run preflight to verify system, VirtualBox, and setup inputs before create.</div>
          </div>

          <div class="btn-row" style="display: flex; justify-content: space-between; margin-top: 32px;">
            <button class="btn btn-secondary" id="btnBack" style="background: #333; color: #ccc; border: 1px solid #444; padding: 8px 16px; border-radius: 4px; cursor: pointer;">← Back</button>
            <button class="btn btn-primary" id="btnNext" style="background: #2ea043; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: 600;">Create VM</button>
          </div>
        </div>
      `;
    },
    init(state, app) {
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
          const vbox = await window.vmInstaller.detectVBox();

          const missing = [];
          if (!state.vmName) missing.push('VM name');
          if (state.isoSource === 'custom' && !state.customIsoPath) missing.push('ISO path');
          if (!state.osName) missing.push('OS version');

          const failedChecks = (report.checks || []).filter((c) => c.status === 'fail');

          if (failedChecks.length > 0 || missing.length > 0 || !vbox.installed) {
            const reasons = [
              ...failedChecks.map((c) => `${c.name}: ${c.message}`),
              ...(vbox.installed ? [] : ['VirtualBox: not installed/detected']),
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
           alert('VM Creation Initiated!');
        }
      });
    },
    validate(state) {
      return { valid: true };
    }
  }
};

if (typeof module !== 'undefined') module.exports = WizardSteps;
