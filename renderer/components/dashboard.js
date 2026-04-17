/**
 * dashboard.js — VM Dashboard Component
 * 
 * Professional VM management dashboard with:
 * - VM cards showing full specs & status
 * - Labeled control buttons (Start, Stop, Pause)
 * - Shared folder, clipboard, display info
 * - Edit settings, open folder, delete
 * - Permission alerts with auto-fix
 * 
 * All SVG icons, zero emojis.
 */

const Dashboard = {

  _liveSyncTimer: null,
  _liveSyncApp: null,
  _visibilityHandler: null,
  _focusHandler: null,

  render(state) {
    return `
      <div class="dashboard">
        <div class="dashboard-header">
          <div class="dashboard-title-group">
            <h2 class="dashboard-title">Virtual Machines</h2>
            <span class="dashboard-subtitle" id="vmCount">Loading...</span>
          </div>
          <div class="dashboard-actions">
            <button class="btn btn-ghost btn-icon-text" id="btnRefreshVMs">
              ${Icons.refresh} <span>Refresh</span>
            </button>
          </div>
        </div>

        <div id="dashPermAlert" style="display:none"></div>

        <div class="vm-grid" id="vmGrid">
          <div class="vm-loading">
            <div class="spinner-ring"></div>
            <span>Loading virtual machines...</span>
          </div>
        </div>
      </div>
    `;
  },

  async init(state, app) {
    document.getElementById('btnRefreshVMs')?.addEventListener('click', () => Dashboard.loadVMs(app));

    if (!this._searchBound) {
      this._searchBound = true;
      document.querySelector('.search-input')?.addEventListener('input', () => {
        if (document.getElementById('navMachines')?.classList.contains('active')) {
          Dashboard.loadVMs(app);
        }
      });
    }

    await Dashboard._checkPermissions();
    await Dashboard.loadVMs(app);
  },

  startLiveSync(app) {
    this.stopLiveSync();
    this._liveSyncApp = app;

    this._liveSyncTimer = setInterval(() => {
      if (document.getElementById('navMachines')?.classList.contains('active')) {
        Dashboard.loadVMs(this._liveSyncApp, { silent: true });
      }
    }, 4000);

    this._visibilityHandler = () => {
      if (!document.hidden && document.getElementById('navMachines')?.classList.contains('active')) {
        Dashboard.loadVMs(this._liveSyncApp, { silent: true });
      }
    };

    this._focusHandler = () => {
      if (document.getElementById('navMachines')?.classList.contains('active')) {
        Dashboard.loadVMs(this._liveSyncApp, { silent: true });
      }
    };

    document.addEventListener('visibilitychange', this._visibilityHandler);
    window.addEventListener('focus', this._focusHandler);
  },

  stopLiveSync() {
    if (this._liveSyncTimer) {
      clearInterval(this._liveSyncTimer);
      this._liveSyncTimer = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._focusHandler) {
      window.removeEventListener('focus', this._focusHandler);
      this._focusHandler = null;
    }
    this._liveSyncApp = null;
  },

  async _checkPermissions() {
    const alertEl = document.getElementById('dashPermAlert');
    if (!alertEl) return;
    try {
      const report = await window.vmInstaller.checkPermissions();
      const driverIssue = report.checks.find(c => c.name === 'VBox Kernel Driver' && c.status === 'required');
      const adminIssue = !report.isAdmin;

      if (!driverIssue && !adminIssue) return;

      let desc = [];
      if (adminIssue) desc.push('Not running as administrator');
      if (driverIssue) desc.push('VBoxSup kernel driver is stopped');

      const dismissed = localStorage.getItem('vmManager.dismissAdminWarning') === '1';
      if (dismissed && adminIssue && !driverIssue) return;

      alertEl.innerHTML = `
        <div class="dash-alert dash-alert-warn">
          <div class="dash-alert-icon">${Icons.warning}</div>
          <div class="dash-alert-content">
            <div class="dash-alert-title">Administrator Access Recommended</div>
            <div class="dash-alert-desc">${desc.join(' / ')}. Some VM operations may fail without elevated access.</div>
          </div>
          <div class="dash-alert-actions">
            ${driverIssue ? `<button class="btn btn-sm btn-primary btn-icon-text" id="btnFixDriver">${Icons.sized(Icons.settings, 14)} Fix Driver</button>` : ''}
            ${adminIssue ? `<button class="btn btn-sm btn-secondary btn-icon-text" id="btnElevateAdmin">${Icons.sized(Icons.shield, 14)} Run as Admin</button>` : ''}
            <button class="btn btn-sm btn-ghost" id="btnDismissAdminWarn">Dismiss</button>
          </div>
        </div>
      `;
      alertEl.style.display = 'block';

      document.getElementById('btnFixDriver')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnFixDriver');
        btn.innerHTML = `${Icons.sized(Icons.spinner, 14)} Fixing...`; btn.disabled = true;
        const r = await window.vmInstaller.fixDriver();
        if (r.success) {
          alertEl.innerHTML = `<div class="dash-alert dash-alert-ok"><div class="dash-alert-icon">${Icons.checkCircle}</div><div class="dash-alert-content"><div class="dash-alert-title">Driver Fixed</div><div class="dash-alert-desc">${r.message}</div></div></div>`;
          setTimeout(() => { alertEl.style.display = 'none'; }, 3000);
        } else { btn.innerHTML = `${Icons.sized(Icons.xCircle, 14)} Failed`; }
      });
      document.getElementById('btnElevateAdmin')?.addEventListener('click', () => window.vmInstaller.restartAsAdmin());
      document.getElementById('btnDismissAdminWarn')?.addEventListener('click', () => {
        localStorage.setItem('vmManager.dismissAdminWarning', '1');
        alertEl.style.display = 'none';
      });
    } catch (err) { console.warn('Perm check failed:', err); }
  },

  async loadVMs(app, options = {}) {
    const grid = document.getElementById('vmGrid');
    const countEl = document.getElementById('vmCount');
    if (!grid) return;

    const silent = !!options.silent;

    if (!silent) {
      grid.innerHTML = `<div class="vm-loading"><div class="spinner-ring"></div><span>Loading virtual machines...</span></div>`;
    }

    const result = await window.vmInstaller.listVMs();

    if (!result.success) {
      if (!silent) {
        grid.innerHTML = `<div class="vm-empty"><div class="vm-empty-icon">${Icons.sized(Icons.warning, 48)}</div><div class="vm-empty-title">Could not load VMs</div><div class="vm-empty-desc">${result.error || 'VirtualBox may not be installed'}</div></div>`;
      }
      if (countEl) countEl.textContent = 'Error';
      return;
    }

    const vms = result.vms;
    const searchValue = (document.querySelector('.search-input')?.value || '').trim().toLowerCase();
    const filtered = searchValue
      ? vms.filter((vm) => (`${vm.name} ${vm.os || ''}`).toLowerCase().includes(searchValue))
      : vms;

    countEl.textContent = `${filtered.length} machine${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      const emptyTitle = searchValue ? 'No matching machines' : 'No Virtual Machines';
      const emptyDesc = searchValue ? 'Try a different search term.' : 'Create your first VM from the top-right New Machine button.';
      grid.innerHTML = `<div class="vm-empty"><div class="vm-empty-icon">${Icons.sized(Icons.vm, 48)}</div><div class="vm-empty-title">${emptyTitle}</div><div class="vm-empty-desc">${emptyDesc}</div></div>`;
      return;
    }

    grid.innerHTML = filtered.map(vm => Dashboard._renderVMCard(vm)).join('');
    Dashboard._wireCardEvents(filtered, app);
  },

  _wireCardEvents(vms, app) {
    if (!this._outsideMenuClickBound) {
      this._outsideMenuClickBound = true;
      document.addEventListener('click', (event) => {
        if (!event.target.closest('.vm-advanced-wrap')) {
          document.querySelectorAll('.vm-action-menu.open').forEach((menu) => menu.classList.remove('open'));
        }
      });
    }

    vms.forEach(vm => {
      const id = vm.uuid.substring(0, 8);

      document.getElementById(`vm-power-${id}`)?.addEventListener('click', async function() {
        if (this.disabled) return;
        this.disabled = true;
        this.classList.add('is-loading');

        const powerLabel = this.querySelector('.vm-power-label');
        if (powerLabel) powerLabel.textContent = 'Switching...';

        const shouldStart = vm.state !== 'running' && vm.state !== 'paused';
        const result = shouldStart
          ? await window.vmInstaller.startVM(vm.name)
          : await window.vmInstaller.stopVM(vm.name);

        if (!result?.success) {
          Dashboard._notify(result?.error || `Failed to ${shouldStart ? 'start' : 'stop'} VM`, 'error');
          this.disabled = false;
          this.classList.remove('is-loading');
          if (powerLabel) powerLabel.textContent = shouldStart ? 'Stopped' : 'Running';
          return;
        }

        this.disabled = false;
        this.classList.remove('is-loading');
        if (powerLabel) powerLabel.textContent = shouldStart ? 'Running' : 'Stopped';
        Dashboard._notify(`${shouldStart ? 'Start' : 'Stop'} command sent. Click Refresh to update machine status.`, 'info');
      });

      document.getElementById(`vm-edit-${id}`)?.addEventListener('click', () => {
        Dashboard._openRenameModal(vm, app);
      });

      document.getElementById(`vm-settings-${id}`)?.addEventListener('click', async () => {
        const result = await window.vmInstaller.getVMDetails(vm.name);
        if (!result.success) {
          Dashboard._notify(result.error || 'Could not load VM settings', 'error');
          return;
        }
        Dashboard._openSettingsModal(result.vm, app);
      });

      document.getElementById(`vm-bootfix-${id}`)?.addEventListener('click', async function() {
        Dashboard._openBootFixModal(vm, app);
      });

      document.getElementById(`vm-menu-users-${id}`)?.addEventListener('click', async () => {
        document.getElementById(`vm-menu-${id}`)?.classList.remove('open');
        await Dashboard._openAccountsModal(vm);
      });

      document.getElementById(`vm-menu-integrate-${id}`)?.addEventListener('click', async () => {
        document.getElementById(`vm-menu-${id}`)?.classList.remove('open');
        await Dashboard._openGuestIntegrationModal(vm, app);
      });

      const menuBtn = document.getElementById(`vm-advanced-btn-${id}`);
      const menuEl = document.getElementById(`vm-menu-${id}`);

      menuBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        document.querySelectorAll('.vm-action-menu.open').forEach((menu) => {
          if (menu !== menuEl) menu.classList.remove('open');
        });
        menuEl?.classList.toggle('open');
      });

      document.getElementById(`vm-menu-rename-${id}`)?.addEventListener('click', () => {
        menuEl?.classList.remove('open');
        Dashboard._openRenameModal(vm, app);
      });

      document.getElementById(`vm-menu-clone-${id}`)?.addEventListener('click', () => {
        menuEl?.classList.remove('open');
        Dashboard._openCloneModal(vm, app);
      });

      document.getElementById(`vm-menu-delete-${id}`)?.addEventListener('click', () => {
        menuEl?.classList.remove('open');
        Dashboard._openDeleteConfirm(vm, app);
      });

      document.getElementById(`vm-menu-folder-${id}`)?.addEventListener('click', () => {
        menuEl?.classList.remove('open');
        window.vmInstaller.showVMInExplorer(vm.name);
      });
    });
  },

  _renderVMCard(vm) {
    const id = vm.uuid.substring(0, 8);
    const osLower = (vm.os || '').toLowerCase();

    let osClass = 'os-generic';
    let dsOsIcon = Icons.monitor;
    if (osLower.includes('ubuntu')) { osClass = 'os-ubuntu'; }
    else if (osLower.includes('windows')) { osClass = 'os-windows'; }
    else if (osLower.includes('debian')) { osClass = 'os-debian'; }
    else if (osLower.includes('kali')) { osClass = 'os-kali'; }
    else if (osLower.includes('arch')) { osClass = 'os-arch'; }
    else if (osLower.includes('mac') || osLower.includes('darwin')) { osClass = 'os-macos'; }
    else if (osLower.includes('linux')) { osClass = 'os-linux'; }

    const isRunning = vm.state === 'running';
    const isPaused = vm.state === 'paused';

    const stateLabel = isRunning ? 'Running' : isPaused ? 'Paused' : 'Powered Off';
    const stateClass = isRunning ? 'state-running' : isPaused ? 'state-paused' : 'state-stopped';
    const osLabel = (vm.os || 'Unknown').replace(/_/g, ' ');
    const powerClass = isRunning ? 'running' : isPaused ? 'paused' : 'stopped';
    const powerLabel = (isRunning || isPaused) ? 'Running' : 'Stopped';

    const featureBadges = [
      { label: 'Clipboard', on: (vm.clipboard || '').toLowerCase() !== 'disabled' },
      { label: 'Drag&Drop', on: (vm.draganddrop || '').toLowerCase() !== 'disabled' },
      { label: 'Audio', on: !!vm.audioEnabled },
      { label: 'USB', on: !!vm.usbEnabled },
      { label: '3D', on: !!vm.accelerate3d },
      { label: 'EFI', on: !!vm.efiEnabled },
      { label: 'Nested VT', on: !!vm.nestedVirtualization }
    ];

    const checks = vm.integrationChecks || {};
    const integrationRows = [
      { label: 'Guest Additions', ok: !!checks.guestAdditions },
      { label: 'Fullscreen Ready', ok: !!checks.fullscreenReady },
      { label: 'Clipboard Sync', ok: !!checks.clipboard },
      { label: 'Drag & Drop', ok: !!checks.dragDrop },
      { label: 'Shared Folder', ok: !!checks.sharedFolder }
    ];

    return `
      <div class="vm-card ${stateClass} ${osClass}">
        <div class="vm-card-header">
          <div class="vm-card-icon">${Icons.sized(dsOsIcon, 38)}</div>
          <div class="vm-card-title-group">
            <div class="vm-card-name">${vm.name}</div>
            <div class="vm-card-os">${osLabel}</div>
          </div>
          <div class="vm-card-state ${stateClass}">
            <span class="state-dot ${stateClass}"></span>
            <span class="state-text">${stateLabel}</span>
          </div>
        </div>

        <div class="vm-card-specs">
          <div class="vm-spec" title="Memory">${Icons.sized(Icons.memory, 14)} <span><strong>RAM</strong> ${vm.ram} MB</span></div>
          <div class="vm-spec" title="Processor">${Icons.sized(Icons.cpu, 14)} <span><strong>CPU</strong> ${vm.cpus} Core${vm.cpus > 1 ? 's' : ''}</span></div>
          <div class="vm-spec" title="Video Memory">${Icons.sized(Icons.monitor, 14)} <span><strong>VRAM</strong> ${vm.vram} MB</span></div>
          <div class="vm-spec" title="Network Mode">${Icons.sized(Icons.globe, 14)} <span><strong>NET</strong> ${vm.network}</span></div>
        </div>

          <div class="vm-feature-badges">
            ${featureBadges.map(f => `<span class="vm-feature-badge ${f.on ? 'on' : 'off'}">${f.label} ${f.on ? 'ON' : 'OFF'}</span>`).join('')}
        </div>

        <div class="vm-integration-report">
          <div class="vm-integration-title">Integration Status</div>
          <div class="vm-integration-grid">
            ${integrationRows.map(item => `
              <div class="vm-integration-item ${item.ok ? 'ok' : 'missing'}">
                ${item.ok ? Icons.sized(Icons.checkCircle, 14) : Icons.sized(Icons.xCircle, 14)}
                <span>${item.label}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="vm-card-controls">
          <div class="vm-actions-primary">
            <button class="vm-power-toggle ${powerClass}" id="vm-power-${id}" title="Toggle power state">
              <span class="vm-power-track">
                <span class="vm-power-thumb"></span>
              </span>
              <span class="vm-power-label">${powerLabel}</span>
              <span class="vm-power-spinner">${Icons.sized(Icons.spinner, 12)}</span>
            </button>
          </div>

          <div class="vm-actions-secondary">
            <button class="btn btn-sm btn-secondary btn-icon-text" id="vm-edit-${id}" title="Rename VM">
              ${Icons.sized(Icons.edit, 14)} Edit
            </button>
            <button class="btn btn-sm btn-secondary btn-icon-text" id="vm-settings-${id}" title="Edit VM settings">
              ${Icons.sized(Icons.settings, 14)} Settings
            </button>
            <button class="btn btn-sm btn-secondary btn-icon-text" id="vm-bootfix-${id}" title="Diagnose and fix boot issues">
              ${Icons.sized(Icons.wrench, 14)} Boot Fix
            </button>
          </div>

          <div class="vm-actions-tertiary vm-advanced-wrap">
            <button class="btn btn-sm btn-ghost btn-icon-text" id="vm-advanced-btn-${id}" title="Advanced actions">
              ${Icons.sized(Icons.moreVertical, 14)} Advanced
            </button>
            <div class="vm-action-menu" id="vm-menu-${id}">
              <button class="vm-menu-item" id="vm-menu-users-${id}">${Icons.sized(Icons.user, 14)} Accounts</button>
              <button class="vm-menu-item" id="vm-menu-integrate-${id}">${Icons.sized(Icons.settings, 14)} Guest Setup</button>
              <button class="vm-menu-item" id="vm-menu-rename-${id}">${Icons.sized(Icons.edit, 14)} Rename</button>
              <button class="vm-menu-item" id="vm-menu-clone-${id}">${Icons.sized(Icons.copy, 14)} Clone</button>
              <button class="vm-menu-item" id="vm-menu-folder-${id}">${Icons.sized(Icons.folder, 14)} Open Folder</button>
              <button class="vm-menu-item danger" id="vm-menu-delete-${id}">${Icons.sized(Icons.trash, 14)} Delete</button>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  async _openGuestIntegrationModal(vm, app) {
    const { close, modal } = this._openModal({
      title: `Guest Setup — ${vm.name}`,
      body: `
        <div class="vm-modal-note">Automatically configure fullscreen, clipboard, drag & drop, and shared folder inside the guest OS.</div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Guest Username</label>
            <input class="form-input" id="giUser" value="user" />
          </div>
          <div class="form-group">
            <label class="form-label">Guest Password</label>
            <input class="form-input" id="giPass" type="password" value="password" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Shared Folder Host Path (optional)</label>
          <div style="display:flex; gap:8px;">
            <input class="form-input" id="giSharedPath" placeholder="C:\\Users\\<you>\\Documents" />
            <button class="btn" id="giBrowsePath">Browse</button>
          </div>
        </div>
        <div class="form-row">
          <label><input type="checkbox" id="giEnableShare" checked> Configure shared folder integration</label>
          <label><input type="checkbox" id="giAutoStart" checked> Auto-start VM if needed</label>
        </div>
        <div class="vm-inline-message" id="giMsg">Ready to configure guest integration.</div>
      `,
      footer: `
        <button class="btn btn-secondary" id="giCancel">Cancel</button>
        <button class="btn btn-primary" id="giRun">Apply Guest Setup</button>
      `
    });

    modal.querySelector('#giCancel')?.addEventListener('click', close);

    modal.querySelector('#giBrowsePath')?.addEventListener('click', async () => {
      const selected = await window.vmInstaller.selectFolder('Select shared folder path', '');
      if (selected) {
        const input = modal.querySelector('#giSharedPath');
        if (input) input.value = selected;
      }
    });

    modal.querySelector('#giRun')?.addEventListener('click', async () => {
      const runBtn = modal.querySelector('#giRun');
      const msg = modal.querySelector('#giMsg');
      runBtn.disabled = true;
      runBtn.textContent = 'Applying...';
      msg.textContent = 'Applying integration. This can take a few minutes...';
      msg.className = 'vm-inline-message';

      const payload = {
        guestUser: modal.querySelector('#giUser')?.value?.trim() || 'user',
        guestPass: modal.querySelector('#giPass')?.value ?? 'password',
        sharedFolderPath: modal.querySelector('#giSharedPath')?.value?.trim() || '',
        sharedFolderName: 'shared',
        enableSharedFolder: !!modal.querySelector('#giEnableShare')?.checked,
        autoStartVm: !!modal.querySelector('#giAutoStart')?.checked
      };

      const result = await window.vmInstaller.configureGuestIntegration(vm.name, payload);
      if (!result?.success) {
        const extra = [];
        if (result?.checks) {
          const failed = Object.entries(result.checks).filter(([, ok]) => !ok).map(([k]) => k);
          if (failed.length > 0) {
            extra.push(`Failed checks: ${failed.join(', ')}`);
          }
        }
        if (Array.isArray(result?.notes) && result.notes.length > 0) {
          extra.push(result.notes.join(' | '));
        }
        msg.textContent = [result?.error || 'Guest setup failed.', ...extra].join(' ');
        msg.className = 'vm-inline-message error';
        runBtn.disabled = false;
        runBtn.textContent = 'Apply Guest Setup';
        return;
      }

      msg.textContent = 'Guest integration applied successfully.';
      msg.className = 'vm-inline-message success';
      this._notify('Guest setup completed successfully', 'success');
      close();
      this._notify('Click Refresh to reload machine status.', 'info');
    });
  },

  _openCloneModal(vm, app) {
    const suggestedName = `${vm.name} Clone`;
    const { close, modal } = this._openModal({
      title: `Clone VM — ${vm.name}`,
      body: `
        <div class="form-group">
          <label class="form-label">Clone Name</label>
          <input class="form-input" id="cloneVmInput" value="${suggestedName}" maxlength="80" />
        </div>
        <div class="vm-modal-note">Cloning duplicates all disks and settings. This can take a few minutes.</div>
        <div class="vm-inline-message" id="cloneVmMsg"></div>
      `,
      footer: `
        <button class="btn btn-secondary" id="cloneVmCancel">Cancel</button>
        <button class="btn btn-primary" id="cloneVmStart">Clone VM</button>
      `
    });

    const input = modal.querySelector('#cloneVmInput');
    input?.focus();

    modal.querySelector('#cloneVmCancel')?.addEventListener('click', close);
    modal.querySelector('#cloneVmStart')?.addEventListener('click', async () => {
      const msg = modal.querySelector('#cloneVmMsg');
      const cloneName = input?.value?.trim();
      if (!cloneName) {
        msg.textContent = 'Clone name is required.';
        msg.className = 'vm-inline-message error';
        return;
      }
      const result = await window.vmInstaller.cloneVM(vm.name, cloneName);
      if (!result.success) {
        msg.textContent = result.error || 'Clone failed.';
        msg.className = 'vm-inline-message error';
        return;
      }
      this._notify('VM cloned successfully', 'success');
      close();
      this._notify('Click Refresh to see the cloned VM in the list.', 'info');
    });
  },

  _openSettingsModal(vm, app) {
    const overlay = document.getElementById('vmModalOverlay');
    const modal = document.getElementById('vmSettingsModal');
    if (!overlay || !modal) return;

    const sharedRows = (vm.sharedFolders || []).map((sf, index) => `
      <div class="vm-share-row" data-index="${index}">
        <input class="form-input vm-share-name" value="${sf.name || ''}" placeholder="Share name" />
        <input class="form-input vm-share-path" value="${sf.hostPath || ''}" placeholder="Host path" />
      </div>
    `).join('');

    modal.innerHTML = `
      <div class="vm-modal-header">
        <h3>Edit Settings — ${vm.name}</h3>
        <button class="btn btn-sm btn-ghost" id="vmModalClose">Close</button>
      </div>
      <div class="vm-modal-body">
        <div class="form-row">
          <div class="form-group"><label class="form-label">RAM (MB)</label><input class="form-input" id="editRam" type="number" value="${vm.ram}"></div>
          <div class="form-group"><label class="form-label">CPUs</label><input class="form-input" id="editCpus" type="number" value="${vm.cpus}"></div>
          <div class="form-group"><label class="form-label">VRAM (MB)</label><input class="form-input" id="editVram" type="number" value="${vm.vram}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">Graphics</label>
            <select class="form-select" id="editGraphics">
              <option value="vmsvga" ${(vm.graphicsController || '').toLowerCase() === 'vmsvga' ? 'selected' : ''}>VMSVGA</option>
              <option value="vboxsvga" ${(vm.graphicsController || '').toLowerCase() === 'vboxsvga' ? 'selected' : ''}>VBoxSVGA</option>
              <option value="vboxvga" ${(vm.graphicsController || '').toLowerCase() === 'vboxvga' ? 'selected' : ''}>VBoxVGA</option>
            </select>
          </div>
          <div class="form-group"><label class="form-label">Audio Controller</label>
            <select class="form-select" id="editAudioController">
              <option value="hda" ${(vm.audioController || '').toLowerCase() === 'hda' ? 'selected' : ''}>HDA</option>
              <option value="ac97" ${(vm.audioController || '').toLowerCase() === 'ac97' ? 'selected' : ''}>AC97</option>
              <option value="sb16" ${(vm.audioController || '').toLowerCase() === 'sb16' ? 'selected' : ''}>SB16</option>
            </select>
          </div>
          <div class="form-group"><label class="form-label">Network</label>
            <select class="form-select" id="editNetwork">
              <option value="nat" ${(vm.network || '').toLowerCase() === 'nat' ? 'selected' : ''}>NAT</option>
              <option value="bridged" ${(vm.network || '').toLowerCase() === 'bridged' ? 'selected' : ''}>Bridged</option>
              <option value="internal" ${(vm.network || '').toLowerCase() === 'intnet' ? 'selected' : ''}>Internal</option>
              <option value="hostonly" ${(vm.network || '').toLowerCase() === 'hostonly' ? 'selected' : ''}>Host-Only</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Boot Order (comma separated)</label>
          <input class="form-input" id="editBootOrder" value="${(vm.bootOrder || ['disk', 'dvd', 'none', 'none']).join(',')}">
        </div>
        <div class="vm-toggle-grid">
          <label><input type="checkbox" id="tClipboard" ${(vm.clipboardMode || '').toLowerCase() !== 'disabled' ? 'checked' : ''}> Clipboard</label>
          <label><input type="checkbox" id="tDnD" ${(vm.dragAndDrop || '').toLowerCase() !== 'disabled' ? 'checked' : ''}> Drag & Drop</label>
          <label><input type="checkbox" id="tAudio" ${vm.audioEnabled ? 'checked' : ''}> Audio</label>
          <label><input type="checkbox" id="tUsb" ${vm.usbEnabled ? 'checked' : ''}> USB</label>
          <label><input type="checkbox" id="t3d" ${vm.accelerate3d ? 'checked' : ''}> 3D Acceleration</label>
          <label><input type="checkbox" id="tEfi" ${vm.efiEnabled ? 'checked' : ''}> EFI Boot</label>
          <label><input type="checkbox" id="tNested" ${vm.nestedVirtualization ? 'checked' : ''}> Nested Virtualization</label>
        </div>
        <div class="form-group">
          <label class="form-label">Shared Folders</label>
          <div id="vmShareList">${sharedRows}</div>
          <button class="btn btn-sm btn-ghost" id="addShareRow">Add Shared Folder</button>
        </div>
      </div>
      <div class="vm-modal-footer">
        <button class="btn btn-secondary" id="vmModalCancel">Cancel</button>
        <button class="btn btn-primary" id="vmModalSave">Save Settings</button>
      </div>
    `;

    overlay.style.display = 'block';
    modal.style.display = 'block';

    const escHandler = (e) => {
      if (e.key === 'Escape') close();
    };

    const close = () => {
      overlay.style.display = 'none';
      modal.style.display = 'none';
      modal.innerHTML = '';
      overlay.onclick = null;
      document.removeEventListener('keydown', escHandler);
    };

    document.getElementById('vmModalClose')?.addEventListener('click', close);
    document.getElementById('vmModalCancel')?.addEventListener('click', close);
    overlay.onclick = close;
    document.addEventListener('keydown', escHandler);

    document.getElementById('addShareRow')?.addEventListener('click', () => {
      const list = document.getElementById('vmShareList');
      if (!list) return;
      const row = document.createElement('div');
      row.className = 'vm-share-row';
      row.innerHTML = `<input class="form-input vm-share-name" placeholder="Share name" /><input class="form-input vm-share-path" placeholder="Host path" />`;
      list.appendChild(row);
    });

    document.getElementById('vmModalSave')?.addEventListener('click', async () => {
      const shares = Array.from(modal.querySelectorAll('.vm-share-row')).map((row) => {
        const name = row.querySelector('.vm-share-name')?.value?.trim();
        const hostPath = row.querySelector('.vm-share-path')?.value?.trim();
        return { name, hostPath, autoMount: true };
      }).filter((s) => s.name && s.hostPath);

      const payload = {
        ram: parseInt(document.getElementById('editRam')?.value || vm.ram),
        cpus: parseInt(document.getElementById('editCpus')?.value || vm.cpus),
        vram: parseInt(document.getElementById('editVram')?.value || vm.vram),
        graphicsController: document.getElementById('editGraphics')?.value || 'vmsvga',
        audioController: document.getElementById('editAudioController')?.value || 'hda',
        networkMode: document.getElementById('editNetwork')?.value || 'nat',
        bootOrder: (document.getElementById('editBootOrder')?.value || 'disk,dvd,none,none').split(',').map(v => v.trim()).filter(Boolean),
        clipboardMode: document.getElementById('tClipboard')?.checked ? 'bidirectional' : 'disabled',
        dragAndDrop: document.getElementById('tDnD')?.checked ? 'bidirectional' : 'disabled',
        audioEnabled: !!document.getElementById('tAudio')?.checked,
        usbEnabled: !!document.getElementById('tUsb')?.checked,
        accelerate3d: !!document.getElementById('t3d')?.checked,
        efiEnabled: !!document.getElementById('tEfi')?.checked,
        nestedVirtualization: !!document.getElementById('tNested')?.checked,
        sharedFolders: shares
      };

      const result = await window.vmInstaller.editVM(vm.name, payload);
      if (!result.success) {
        Dashboard._notify(`Failed to save settings: ${result.error || 'Unknown error'}`, 'error');
        return;
      }

      const refreshed = await window.vmInstaller.getVMDetails(vm.name);
      if (!refreshed.success) {
        Dashboard._notify('Settings saved, but failed to reload VM details.', 'info');
      } else {
        Dashboard._notify('VM settings saved and verified successfully', 'success');
      }

      close();
      Dashboard._notify('Settings saved. Click Refresh to reload machine details.', 'info');
    });
  },

  _openRenameModal(vm, app) {
    const { close, modal } = this._openModal({
      title: 'Rename VM',
      body: `
        <div class="vm-modal-note">Current name: <strong>${vm.name}</strong></div>
        <div class="form-group">
          <label class="form-label">New Name</label>
          <input class="form-input" id="renameVmInput" value="${vm.name}" maxlength="80" />
        </div>
        <div class="vm-modal-note">Renaming is available for powered off VMs.</div>
        <div class="vm-inline-message" id="renameVmMsg"></div>
      `,
      footer: `
        <button class="btn btn-secondary" id="renameVmCancel">Cancel</button>
        <button class="btn btn-primary" id="renameVmSave">Save</button>
      `
    });

    const input = modal.querySelector('#renameVmInput');
    input?.focus();

    modal.querySelector('#renameVmCancel')?.addEventListener('click', close);
    modal.querySelector('#renameVmSave')?.addEventListener('click', async () => {
      const msg = modal.querySelector('#renameVmMsg');
      const newName = input?.value?.trim() || '';
      if (!newName) {
        msg.textContent = 'VM name is required.';
        msg.className = 'vm-inline-message error';
        return;
      }
      if (newName === vm.name) {
        close();
        return;
      }

      const result = await window.vmInstaller.renameVM(vm.name, newName);
      if (!result.success) {
        msg.textContent = result.error || 'Rename failed.';
        msg.className = 'vm-inline-message error';
        return;
      }

      this._notify('VM renamed successfully', 'success');
      close();
      this._notify('Click Refresh to see the updated VM name.', 'info');
    });
  },

  _openDeleteConfirm(vm, app) {
    const { close, modal } = this._openModal({
      title: `Delete VM — ${vm.name}`,
      body: `
        <div class="vm-modal-note danger">This removes the VM and all associated files. This action cannot be undone.</div>
        <div class="vm-inline-message" id="deleteVmMsg"></div>
      `,
      footer: `
        <button class="btn btn-secondary" id="deleteVmCancel">Cancel</button>
        <button class="btn btn-danger" id="deleteVmConfirm">Delete</button>
      `
    });

    modal.querySelector('#deleteVmCancel')?.addEventListener('click', close);
    modal.querySelector('#deleteVmConfirm')?.addEventListener('click', async () => {
      const msg = modal.querySelector('#deleteVmMsg');
      const result = await window.vmInstaller.deleteVM(vm.name);
      if (!result.success) {
        msg.textContent = result.error || 'Delete failed.';
        msg.className = 'vm-inline-message error';
        return;
      }

      this._notify('VM deleted successfully', 'success');
      close();
      this._notify('Click Refresh to update the machine list.', 'info');
    });
  },

  _openBootFixModal(vm, app) {
    const { close, modal } = this._openModal({
      title: `Boot Fix — ${vm.name}`,
      body: `
        <div class="vm-modal-note">This runs diagnostics and applies safe automatic fixes before next boot.</div>
        <div class="vm-inline-message" id="bootFixMsg">Ready to run diagnostics.</div>
        <div class="vm-bootfix-result" id="bootFixResult"></div>
      `,
      footer: `
        <button class="btn btn-secondary" id="bootFixClose">Close</button>
        <button class="btn btn-primary" id="bootFixRun">Run Boot Fix</button>
      `
    });

    const runBtn = modal.querySelector('#bootFixRun');
    const msg = modal.querySelector('#bootFixMsg');
    const resultEl = modal.querySelector('#bootFixResult');

    modal.querySelector('#bootFixClose')?.addEventListener('click', close);
    runBtn?.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.innerHTML = `${Icons.sized(Icons.spinner, 14)} Running...`;
      msg.textContent = 'Running diagnostics...';
      msg.className = 'vm-inline-message';
      resultEl.innerHTML = '';

      const result = await window.vmInstaller.bootFixVM(vm.name);
      if (!result.success) {
        msg.textContent = result.error || 'Boot fix failed.';
        msg.className = 'vm-inline-message error';
        runBtn.disabled = false;
        runBtn.innerHTML = 'Run Boot Fix';
        return;
      }

      const fixes = result.fixesApplied || [];
      const diag = result.diagnostics || [];
      msg.textContent = fixes.length ? 'Diagnostics complete. Fixes applied.' : 'Diagnostics complete. No fixes were required.';
      msg.className = 'vm-inline-message success';
      resultEl.innerHTML = `
        <div class="vm-bootfix-block">
          <div class="vm-bootfix-title">Applied Fixes</div>
          <ul>${fixes.length ? fixes.map((f) => `<li>${f}</li>`).join('') : '<li>No changes required.</li>'}</ul>
        </div>
        <div class="vm-bootfix-block">
          <div class="vm-bootfix-title">Diagnostics</div>
          <ul>${diag.map((d) => `<li><strong>${d.key}</strong>: ${d.message}</li>`).join('')}</ul>
        </div>
      `;
      runBtn.remove();
      this._notify('Boot diagnostics complete', 'success');
      this._notify('Click Refresh to reload machine status.', 'info');
    });
  },

  async _openAccountsModal(vm) {
    const { close, modal } = this._openModal({
      title: `Guest Accounts — ${vm.name}`,
      body: `
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Guest Admin User</label>
            <input class="form-input" id="accGuestUser" value="user" />
          </div>
          <div class="form-group">
            <label class="form-label">Guest Admin Password</label>
            <input class="form-input" id="accGuestPass" type="password" value="password" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Action</label>
            <select class="form-select" id="accAction">
              <option value="list">List users</option>
              <option value="add">Create user</option>
              <option value="update">Update user</option>
              <option value="autologin">Set auto-login</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Target Username</label>
            <input class="form-input" id="accTargetUser" placeholder="Required for add/update/autologin" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">New Username (update)</label>
            <input class="form-input" id="accNewUser" placeholder="Optional" />
          </div>
          <div class="form-group">
            <label class="form-label">Password (new/update)</label>
            <input class="form-input" id="accPassword" type="password" placeholder="Optional" />
          </div>
        </div>
        <div class="vm-inline-message" id="accMsg">Select an action to continue.</div>
        <div class="vm-users-list" id="accUsersList"></div>
      `,
      footer: `
        <button class="btn btn-secondary" id="accClose">Close</button>
        <button class="btn btn-primary" id="accRun">Run Action</button>
      `
    });

    const getPayload = () => ({
      vmName: vm.name,
      guestUser: modal.querySelector('#accGuestUser')?.value?.trim(),
      guestPass: modal.querySelector('#accGuestPass')?.value ?? ''
    });

    const msg = modal.querySelector('#accMsg');
    const usersList = modal.querySelector('#accUsersList');

    modal.querySelector('#accClose')?.addEventListener('click', close);
    modal.querySelector('#accRun')?.addEventListener('click', async () => {
      const action = modal.querySelector('#accAction')?.value;
      const base = getPayload();

      msg.textContent = 'Running operation...';
      msg.className = 'vm-inline-message';

      let result;
      if (action === 'list') {
        result = await window.vmInstaller.listVMUsers(base);
        if (result.success) {
          usersList.innerHTML = `<div class="vm-users-title">Users (${result.users.length})</div><div>${result.users.join(', ')}</div>`;
          msg.textContent = 'User list loaded.';
          msg.className = 'vm-inline-message success';
        }
      } else if (action === 'add') {
        const username = modal.querySelector('#accTargetUser')?.value?.trim();
        const password = modal.querySelector('#accPassword')?.value ?? '';
        result = await window.vmInstaller.createVMUser({ ...base, username, password });
      } else if (action === 'update') {
        const oldUsername = modal.querySelector('#accTargetUser')?.value?.trim();
        const newUsername = modal.querySelector('#accNewUser')?.value?.trim() || oldUsername;
        const newPassword = modal.querySelector('#accPassword')?.value ?? '';
        result = await window.vmInstaller.updateVMUser({ ...base, oldUsername, newUsername, newPassword });
      } else if (action === 'autologin') {
        const username = modal.querySelector('#accTargetUser')?.value?.trim();
        result = await window.vmInstaller.setVMAutoLogin({ ...base, username });
      }

      if (!result?.success) {
        msg.textContent = result?.error || 'Operation failed.';
        msg.className = 'vm-inline-message error';
        return;
      }

      if (action !== 'list') {
        msg.textContent = 'Operation completed successfully.';
        msg.className = 'vm-inline-message success';
      }
      this._notify('Account operation completed', 'success');
    });
  },

  _openModal({ title, body, footer }) {
    const overlay = document.getElementById('vmModalOverlay');
    const modal = document.getElementById('vmSettingsModal');
    if (!overlay || !modal) return { close: () => {}, modal: null };

    modal.innerHTML = `
      <div class="vm-modal-header">
        <h3 class="vm-modal-title">${title}</h3>
        <button class="btn btn-sm btn-ghost" id="vmGenericClose">Close</button>
      </div>
      <div class="vm-modal-body">${body}</div>
      <div class="vm-modal-footer">${footer}</div>
    `;

    overlay.style.display = 'block';
    modal.style.display = 'block';

    const escHandler = (e) => {
      if (e.key === 'Escape') close();
    };

    const close = () => {
      overlay.style.display = 'none';
      modal.style.display = 'none';
      modal.innerHTML = '';
      overlay.onclick = null;
      document.removeEventListener('keydown', escHandler);
    };

    modal.querySelector('#vmGenericClose')?.addEventListener('click', close);
    overlay.onclick = close;
    document.addEventListener('keydown', escHandler);

    return { close, modal };
  },

  _notify(message, type = 'info') {
    const existing = document.getElementById('vmToast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'vmToast';
    toast.className = `vm-toast ${type}`;
    const icon = type === 'success'
      ? Icons.sized(Icons.checkCircle, 14)
      : type === 'error'
      ? Icons.sized(Icons.xCircle, 14)
      : Icons.sized(Icons.info, 14);
    toast.innerHTML = `${icon}<span>${message}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('show');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 250);
    }, 2600);
  }
};

function _truncPath(p) {
  if (!p || p.length < 35) return p;
  return '...' + p.slice(-32);
}
