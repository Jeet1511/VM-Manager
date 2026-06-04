const fs = require('fs');

// ─── Fix 1: Redesign delete dialog with two clear action buttons ───
let dash = fs.readFileSync('renderer/components/dashboard.js', 'utf8');

// Find and replace the entire _openDeleteConfirm method body
const oldBody = dash.indexOf('async _openDeleteConfirm(vm, app) {');
const methodEnd = dash.indexOf('\n  },\n', oldBody + 100);
// Also check for \r\n
const methodEndCR = dash.indexOf('\r\n  },\r\n', oldBody + 100);
const actualEnd = methodEndCR >= 0 ? methodEndCR : methodEnd;

if (oldBody >= 0 && actualEnd >= 0) {
  const beforeMethod = dash.slice(0, oldBody);
  const afterMethod = dash.slice(actualEnd + (methodEndCR >= 0 ? 6 : 4)); // skip past "},\n"

  const newMethod = `async _openDeleteConfirm(vm, app) {
    // Try to find the ISO path associated with this VM
    let isoPath = '';
    let isoName = '';
    let isoSize = '';
    try {
      const details = await window.vmInstaller.getVMDetails(vm.name);
      if (details?.success && details.vm) {
        const info = details.vm;
        for (const key of Object.keys(info)) {
          const val = String(info[key] || '');
          if (val.toLowerCase().endsWith('.iso') && !val.includes('cloud-init') && !val.includes('preseed')) {
            isoPath = val;
            break;
          }
        }
        if (!isoPath && info.dvdImagePath) isoPath = info.dvdImagePath;
        if (!isoPath && info.isoPath) isoPath = info.isoPath;
      }
    } catch {}

    if (isoPath) {
      const parts = isoPath.replace(/\\\\/g, '/').split('/');
      isoName = parts[parts.length - 1] || isoPath;
      try {
        const sizeResult = await window.vmInstaller.getFileSize(isoPath);
        if (sizeResult?.size) {
          const gb = (sizeResult.size / (1024 * 1024 * 1024)).toFixed(1);
          isoSize = \` (\${gb} GB)\`;
        }
      } catch {}
    }

    // Build the two-option delete dialog
    const isoOptionHtml = isoPath ? \`
      <div style="margin-top: 16px; display: grid; gap: 10px;">
        <div style="padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(154, 164, 178, 0.18); background: rgba(255,255,255,0.03); cursor: pointer; transition: border-color 0.2s, background 0.2s;" id="deleteOptVosOnly" class="delete-option selected">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 18px; height: 18px; border-radius: 50%; border: 2px solid #4c8dff; display: flex; align-items: center; justify-content: center;" id="radioVosOnly">
              <div style="width: 10px; height: 10px; border-radius: 50%; background: #4c8dff;" id="radioDotVosOnly"></div>
            </div>
            <div>
              <strong style="color: #e2e8f0;">Delete V Os only</strong>
              <div style="font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 2px;">Removes the virtual machine and disk files. Keeps the ISO for future use.</div>
            </div>
          </div>
        </div>
        <div style="padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(239, 68, 68, 0.18); background: rgba(239, 68, 68, 0.04); cursor: pointer; transition: border-color 0.2s, background 0.2s;" id="deleteOptVosAndIso" class="delete-option">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(154,164,178,0.4); display: flex; align-items: center; justify-content: center;" id="radioVosAndIso">
              <div style="width: 10px; height: 10px; border-radius: 50%; background: transparent;" id="radioDotVosAndIso"></div>
            </div>
            <div>
              <strong style="color: #fca5a5;">Delete V Os + ISO file</strong>
              <div style="font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 2px;">\${Dashboard._escapeHtml(isoName)}\${isoSize}</div>
            </div>
          </div>
        </div>
      </div>
    \` : '';

    const { close, modal } = this._openModal({
      title: \`Delete V Os — \${vm.name}\`,
      body: \`
        <div class="vm-modal-note danger" style="margin-bottom: 4px;">This removes the V Os and all associated virtual disk files. This action cannot be undone.</div>
        \${isoOptionHtml}
        <div class="vm-inline-message" id="deleteVmMsg"></div>
      \`,
      footer: \`
        <button class="btn btn-secondary" id="deleteVmCancel" style="min-width: 100px;">Cancel</button>
        <button class="btn btn-danger" id="deleteVmConfirm" style="min-width: 160px;">Delete V Os</button>
      \`
    });

    let deleteIsoSelected = false;
    const confirmBtn = modal.querySelector('#deleteVmConfirm');
    const optVosOnly = modal.querySelector('#deleteOptVosOnly');
    const optVosAndIso = modal.querySelector('#deleteOptVosAndIso');

    const selectOption = (iso) => {
      deleteIsoSelected = iso;
      if (confirmBtn) confirmBtn.textContent = iso ? 'Delete V Os + ISO' : 'Delete V Os Only';
      // Update radio visuals
      const radioVosOnly = modal.querySelector('#radioVosOnly');
      const radioDotVosOnly = modal.querySelector('#radioDotVosOnly');
      const radioVosAndIso = modal.querySelector('#radioVosAndIso');
      const radioDotVosAndIso = modal.querySelector('#radioDotVosAndIso');
      if (radioVosOnly) radioVosOnly.style.borderColor = iso ? 'rgba(154,164,178,0.4)' : '#4c8dff';
      if (radioDotVosOnly) radioDotVosOnly.style.background = iso ? 'transparent' : '#4c8dff';
      if (radioVosAndIso) radioVosAndIso.style.borderColor = iso ? '#ef4444' : 'rgba(154,164,178,0.4)';
      if (radioDotVosAndIso) radioDotVosAndIso.style.background = iso ? '#ef4444' : 'transparent';
      // Update card borders
      if (optVosOnly) {
        optVosOnly.style.borderColor = iso ? 'rgba(154,164,178,0.18)' : 'rgba(76,141,255,0.35)';
        optVosOnly.style.background = iso ? 'rgba(255,255,255,0.03)' : 'rgba(76,141,255,0.06)';
      }
      if (optVosAndIso) {
        optVosAndIso.style.borderColor = iso ? 'rgba(239,68,68,0.35)' : 'rgba(239,68,68,0.18)';
        optVosAndIso.style.background = iso ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.04)';
      }
    };

    if (optVosOnly) optVosOnly.addEventListener('click', () => selectOption(false));
    if (optVosAndIso) optVosAndIso.addEventListener('click', () => selectOption(true));
    selectOption(false); // Default: V Os only

    modal.querySelector('#deleteVmCancel')?.addEventListener('click', close);
    modal.querySelector('#deleteVmConfirm')?.addEventListener('click', async () => {
      const adminReady = await Dashboard._ensureAdminForTask('delete V Os');
      if (!adminReady) return;

      const msg = modal.querySelector('#deleteVmMsg');
      const deleteIso = deleteIsoSelected && isoPath ? true : false;

      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Deleting...';
      }

      let result = await window.vmInstaller.deleteVM(vm.name, { deleteIso, isoPath });
      if (!result.success) {
        msg.textContent = result.error || 'Delete failed.';
        msg.className = 'vm-inline-message error';
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = deleteIso ? 'Delete V Os + ISO' : 'Delete V Os Only';
        }
        return;
      }

      const successMsg = deleteIso && result.isoDeleted
        ? 'V Os and ISO file deleted successfully'
        : 'V Os deleted successfully';
      this._notify(successMsg, 'success');
      close();
      await Dashboard._refreshAfterMutation(app);
    });
  },`;

  dash = beforeMethod + newMethod + afterMethod;
  console.log('REDESIGNED: Delete dialog with two radio-button options');
} else {
  console.log('ERROR: Could not find _openDeleteConfirm method boundaries');
  console.log('oldBody at:', oldBody, 'actualEnd at:', actualEnd);
}

fs.writeFileSync('renderer/components/dashboard.js', dash, 'utf8');

// ─── Fix 2: Reduce overview panel padding in CSS ───
let css = fs.readFileSync('renderer/styles.css', 'utf8');

// Find .overview-panel and reduce padding
const panelIdx = css.indexOf('.overview-panel {');
if (panelIdx >= 0) {
  const padIdx = css.indexOf('padding: 14px;', panelIdx);
  if (padIdx >= 0 && padIdx < panelIdx + 400) {
    css = css.slice(0, padIdx) + 'padding: 10px;' + css.slice(padIdx + 'padding: 14px;'.length);
    console.log('FIXED: overview-panel padding 14px → 10px');
  }
  const gapIdx = css.indexOf('gap: 12px;', panelIdx);
  if (gapIdx >= 0 && gapIdx < panelIdx + 400) {
    css = css.slice(0, gapIdx) + 'gap: 8px;' + css.slice(gapIdx + 'gap: 12px;'.length);
    console.log('FIXED: overview-panel gap 12px → 8px');
  }
}

// Reduce overview-empty-state padding more
const emptyIdx = css.indexOf('.overview-empty-state {');
if (emptyIdx >= 0) {
  const padIdx2 = css.indexOf('padding: 14px 14px;', emptyIdx);
  if (padIdx2 >= 0 && padIdx2 < emptyIdx + 300) {
    css = css.slice(0, padIdx2) + 'padding: 10px 12px;' + css.slice(padIdx2 + 'padding: 14px 14px;'.length);
    console.log('FIXED: overview-empty-state padding reduced');
  }
}

// Reduce overview-main-grid gap
const gridIdx = css.indexOf('.overview-main-grid {');
if (gridIdx >= 0) {
  const gapIdx2 = css.indexOf('gap: 12px;', gridIdx);
  if (gapIdx2 >= 0 && gapIdx2 < gridIdx + 100) {
    css = css.slice(0, gapIdx2) + 'gap: 8px;' + css.slice(gapIdx2 + 'gap: 12px;'.length);
    console.log('FIXED: overview-main-grid gap 12px → 8px');
  }
}

fs.writeFileSync('renderer/styles.css', css, 'utf8');
console.log('DONE');
