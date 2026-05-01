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
  _isLoadingVMs: false,
  _pendingLoad: null,
  _modalActive: false,

  render(state) {
    return `
      <div class="dashboard">
        <div class="dashboard-header">
          <div class="dashboard-title-group">
            <h2 class="dashboard-title">Virtual Os</h2>
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
            <span>Loading virtual OSes...</span>
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
      if (document.getElementById('navMachines')?.classList.contains('active') && !Dashboard._modalActive) {
        Dashboard.loadVMs(this._liveSyncApp, { silent: true });
      }
    }, 10000);

    this._visibilityHandler = () => {
      if (!document.hidden && document.getElementById('navMachines')?.classList.contains('active') && !Dashboard._modalActive) {
        Dashboard.loadVMs(this._liveSyncApp, { silent: true });
      }
    };

    this._focusHandler = () => {
      if (document.getElementById('navMachines')?.classList.contains('active') && !Dashboard._modalActive) {
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
      const checks = Array.isArray(report?.checks) ? report.checks : [];
      const hostBlockers = report?.hostBlockers || {};
      const hostSignals = report?.hostSignals || {};
      const driverIssue = checks.find(c => c.name === 'VBox Kernel Driver' && ['required', 'unavailable', 'warning'].includes(String(c.status || '').toLowerCase()));
      const adminIssue = !report?.isAdmin;
      const fallbackHypervisorConflict = String(report?.platform || '') === 'win32'
        && (
          String(hostSignals?.hyperV || '').toLowerCase() === 'enabled'
          || String(hostSignals?.hypervisorPlatform || '').toLowerCase() === 'enabled'
          || String(hostSignals?.virtualMachinePlatform || '').toLowerCase() === 'enabled'
        );
      const fallbackMemoryIntegrityConflict = String(report?.platform || '') === 'win32'
        && hostSignals?.memoryIntegrityEnabled === true;
      const hasDriverIssue = typeof hostBlockers?.hasDriverIssue === 'boolean'
        ? hostBlockers.hasDriverIssue
        : !!driverIssue;
      const hasRuntimeIssue = hostBlockers?.hasRuntimeIssue === true;
      const hasHypervisorConflict = typeof hostBlockers?.hasHypervisorConflict === 'boolean'
        ? hostBlockers.hasHypervisorConflict
        : fallbackHypervisorConflict;
      const hasMemoryIntegrityConflict = typeof hostBlockers?.hasMemoryIntegrityConflict === 'boolean'
        ? hostBlockers.hasMemoryIntegrityConflict
        : fallbackMemoryIntegrityConflict;
      const hasPendingReboot = hostBlockers?.hasPendingReboot === true;

      if (!hasDriverIssue && !hasRuntimeIssue && !hasHypervisorConflict && !hasMemoryIntegrityConflict && !hasPendingReboot && !adminIssue) return;

      let desc = [];
      if (adminIssue) desc.push('Not running as administrator');
      if (hasDriverIssue) desc.push(driverIssue?.description || hostBlockers?.primaryMessage || 'VBox kernel driver requires attention');
      if (hasRuntimeIssue && !hasDriverIssue) desc.push(hostBlockers?.primaryMessage || 'VirtualBox runtime needs attention');
      if (hasHypervisorConflict) desc.push('Hyper-V stack is enabled');
      if (hasMemoryIntegrityConflict) desc.push('Memory Integrity is enabled');
      if (hasPendingReboot) desc.push('Windows restart is pending');
      const safeDesc = Dashboard._escapeHtml(desc.join(' / '));
      const alertTitle = adminIssue ? 'Administrator Access Recommended' : 'Host Attention Needed';
      const guidance = adminIssue
        ? 'Some V Os operations may fail without elevated access. Use the floating <strong>Continue with Admin Privilege</strong> action for full access.'
        : 'Use the actions below to clear host blockers, then retry Start V Os.';

      alertEl.innerHTML = `
        <div class="dash-alert dash-alert-warn">
          <div class="dash-alert-icon">${Icons.warning}</div>
          <div class="dash-alert-content">
            <div class="dash-alert-title">${alertTitle}</div>
            <div class="dash-alert-desc">${safeDesc}. ${guidance}</div>
          </div>
          <div class="dash-alert-actions">
            ${(hasDriverIssue || hasRuntimeIssue) ? `<button class="btn btn-sm btn-primary btn-icon-text" id="btnFixDriver">${Icons.sized(Icons.settings, 14)} Fix Driver</button>` : ''}
            ${(hasDriverIssue || hasRuntimeIssue) ? `<button class="btn btn-sm btn-secondary btn-icon-text" id="btnPrepareHost">${Icons.sized(Icons.wrench, 14)} Prepare Host</button>` : ''}
            ${hasHypervisorConflict ? `<button class="btn btn-sm btn-secondary btn-icon-text" id="btnDisableHypervisorStack">${Icons.sized(Icons.shield, 14)} Disable Hyper-V Stack</button>` : ''}
            ${hasHypervisorConflict ? `<button class="btn btn-sm btn-ghost btn-icon-text" id="btnOpenWindowsFeatures">${Icons.sized(Icons.externalLink, 14)} Windows Features</button>` : ''}
            ${hasMemoryIntegrityConflict ? `<button class="btn btn-sm btn-ghost btn-icon-text" id="btnOpenCoreIsolation">${Icons.sized(Icons.externalLink, 14)} Core Isolation</button>` : ''}
            <button class="btn btn-sm btn-ghost" id="btnDismissAdminWarn">Dismiss</button>
          </div>
        </div>
      `;
      alertEl.style.display = 'block';

      if (adminIssue) {
        window.vmxAdminAccess?.refresh?.();
      }

      document.getElementById('btnFixDriver')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnFixDriver');
        btn.innerHTML = `${Icons.sized(Icons.spinner, 14)} Fixing...`; btn.disabled = true;
        const r = await window.vmInstaller.fixDriver();
        if (r?.requiresAdmin) {
          btn.innerHTML = `${Icons.sized(Icons.shieldCheck, 14)} Admin Needed`;
          btn.disabled = false;
          window.vmxAdminAccess?.focus?.('Driver repair needs administrator mode.');
          Dashboard._notify(r.message || 'Continue with Admin Privilege, then retry Fix Driver.', 'info');
          return;
        }
        if (r.success) {
          const safeMessage = Dashboard._escapeHtml(r.message);
          alertEl.innerHTML = `<div class="dash-alert dash-alert-ok"><div class="dash-alert-icon">${Icons.checkCircle}</div><div class="dash-alert-content"><div class="dash-alert-title">Driver Fixed</div><div class="dash-alert-desc">${safeMessage}</div></div></div>`;
          setTimeout(() => { alertEl.style.display = 'none'; }, 3000);
        } else { btn.innerHTML = `${Icons.sized(Icons.xCircle, 14)} Failed`; }
      });
      document.getElementById('btnPrepareHost')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnPrepareHost');
        btn.innerHTML = `${Icons.sized(Icons.spinner, 14)} Preparing...`;
        btn.disabled = true;
        const result = await window.vmInstaller.prepareHostRecovery();
        const primaryMessage = String(result?.message || 'Host recovery preparation completed.').trim();
        const planPreview = Array.isArray(result?.steps) ? result.steps.slice(0, 3) : [];

        if (result?.requiresAdmin) {
          btn.innerHTML = `${Icons.sized(Icons.shieldCheck, 14)} Admin Needed`;
          btn.disabled = false;
          window.vmxAdminAccess?.focus?.('Host recovery preparation needs administrator mode.');
          Dashboard._notify(primaryMessage || 'Continue with Admin Privilege, then retry Prepare Host.', 'info');
          return;
        }

        if (result?.success) {
          const safeMessage = Dashboard._escapeHtml(primaryMessage);
          const safeSteps = planPreview.map((item) => Dashboard._escapeHtml(item));
          const planHtml = safeSteps.length > 0 ? `<br>${safeSteps.join('<br>')}` : '';
          alertEl.innerHTML = `<div class="dash-alert dash-alert-ok"><div class="dash-alert-icon">${Icons.checkCircle}</div><div class="dash-alert-content"><div class="dash-alert-title">Host Prepared</div><div class="dash-alert-desc">${safeMessage}${planHtml}</div></div></div>`;
          setTimeout(() => { alertEl.style.display = 'none'; }, 3600);
          return;
        }

        btn.innerHTML = `${Icons.sized(Icons.wrench, 14)} Prepare Host`;
        btn.disabled = false;
        Dashboard._notify(primaryMessage || 'Host recovery preparation found unresolved issues.', 'error');
        if (planPreview.length > 0) {
          Dashboard._notify(`Recovery plan: ${planPreview.join(' | ')}`, 'info');
        }
      });
      document.getElementById('btnDisableHypervisorStack')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnDisableHypervisorStack');
        if (!btn) return;
        btn.innerHTML = `${Icons.sized(Icons.spinner, 14)} Disabling...`;
        btn.disabled = true;
        const result = await window.vmInstaller.runHostRecoveryAction('disable-hypervisor-stack');
        if (result?.requiresAdmin) {
          btn.innerHTML = `${Icons.sized(Icons.shieldCheck, 14)} Admin Needed`;
          btn.disabled = false;
          window.vmxAdminAccess?.focus?.('Disabling Hyper-V blockers needs administrator mode.');
          Dashboard._notify(result.message || 'Continue with Admin Privilege, then retry Disable Hyper-V Stack.', 'info');
          return;
        }
        if (result?.success) {
          btn.innerHTML = `${Icons.sized(Icons.check, 14)} Disabled`;
          const detail = result?.rebootRequired
            ? `${result.message} Reboot is required.`
            : (result?.message || 'Virtualization blockers updated.');
          Dashboard._notify(detail, 'success');
          return;
        }
        btn.innerHTML = `${Icons.sized(Icons.xCircle, 14)} Failed`;
        btn.disabled = false;
        Dashboard._notify(result?.message || 'Could not disable Hyper-V blockers automatically.', 'error');
      });
      document.getElementById('btnOpenWindowsFeatures')?.addEventListener('click', async () => {
        const result = await window.vmInstaller.runHostRecoveryAction('open-windows-features');
        if (!result?.success) {
          Dashboard._notify(result?.message || 'Could not open Windows Features.', 'error');
          return;
        }
        Dashboard._notify(result.message || 'Windows Features opened.', 'info');
      });
      document.getElementById('btnOpenCoreIsolation')?.addEventListener('click', async () => {
        const result = await window.vmInstaller.runHostRecoveryAction('open-core-isolation');
        if (!result?.success) {
          Dashboard._notify(result?.message || 'Could not open Device Security settings.', 'error');
          return;
        }
        Dashboard._notify(result.message || 'Device Security settings opened.', 'info');
      });
      document.getElementById('btnDismissAdminWarn')?.addEventListener('click', () => {
        alertEl.style.display = 'none';
      });
    } catch (err) { console.warn('Perm check failed:', err); }
  },

  async loadVMs(app, options = {}) {
    if (this._isLoadingVMs) {
      this._pendingLoad = { app, options };
      return;
    }

    this._isLoadingVMs = true;

    const grid = document.getElementById('vmGrid');
    const countEl = document.getElementById('vmCount');
    if (!grid) {
      this._isLoadingVMs = false;
      return;
    }

    const silent = !!options.silent;

    if (silent && this._modalActive) {
      this._isLoadingVMs = false;
      return;
    }

    if (!silent) {
      grid.innerHTML = `<div class="vm-loading"><div class="spinner-ring"></div><span>Loading virtual OSes...</span></div>`;
    }

    try {
      const result = await window.vmInstaller.listVMs();

      if (!result.success) {
        if (!silent) {
          const safeError = Dashboard._escapeHtml(result.error || 'VirtualBox may not be installed');
          grid.innerHTML = `<div class="vm-empty"><div class="vm-empty-icon">${Icons.sized(Icons.warning, 48)}</div><div class="vm-empty-title">Could not load V Os</div><div class="vm-empty-desc">${safeError}</div></div>`;
        }
        if (countEl) countEl.textContent = 'Error';
        return;
      }

      const vms = result.vms;
      const searchValue = (document.querySelector('.search-input')?.value || '').trim().toLowerCase();
      const filtered = searchValue
        ? vms.filter((vm) => (`${vm.name} ${vm.os || ''}`).toLowerCase().includes(searchValue))
        : vms;

      countEl.textContent = `${filtered.length} V Os`;

      if (filtered.length === 0) {
        if (!searchValue && typeof app?.showVmBootstrap === 'function') {
          app.showVmBootstrap('No V Os found. Set up or import one to continue.');
          return;
        }

        const emptyTitle = searchValue ? 'No matching V Os' : 'No V Os';
        const emptyDesc = searchValue ? 'Try a different search term.' : 'Create your first V Os from the top-right New V Os button.';
        grid.innerHTML = `<div class="vm-empty"><div class="vm-empty-icon">${Icons.sized(Icons.vm, 48)}</div><div class="vm-empty-title">${emptyTitle}</div><div class="vm-empty-desc">${emptyDesc}</div></div>`;
        return;
      }

      grid.innerHTML = filtered.map((vm, index) => Dashboard._renderVMCard(vm, index)).join('');
      Dashboard._wireCardEvents(filtered, app);
    } finally {
      this._isLoadingVMs = false;
      if (this._pendingLoad) {
        const next = this._pendingLoad;
        this._pendingLoad = null;
        setTimeout(() => {
          Dashboard.loadVMs(next.app, next.options);
        }, 0);
      }
    }
  },

  async _refreshAfterMutation(app) {
    await Dashboard.loadVMs(app, { silent: true });
  },

  _getPowerLabel(vmState) {
    const state = String(vmState || '').toLowerCase();
    return (state === 'running' || state === 'paused') ? 'Running...' : 'Start';
  },

  _escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  _readUiPrefs() {
    try {
      const raw = localStorage.getItem('vmManager.uiPrefs');
      const parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
      return {};
    }
  },

  _shouldNotify(type = 'info') {
    const prefs = Dashboard._readUiPrefs();
    const level = String(prefs.notificationLevel || 'important').toLowerCase();
    const normalizedType = String(type || 'info').toLowerCase();
    if (normalizedType === 'error') return true;
    if (level === 'all') return true;
    if (level === 'minimal') return false;
    return normalizedType !== 'info';
  },

  _getVmDomId(vm, index = 0) {
    const source = String(vm?.uuid || vm?.name || `vm-${index}`);
    const sanitized = source.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
    return sanitized || `vm-${index}`;
  },

  async _ensureAdminForTask(taskName = 'this work') {
    try {
      const isAdmin = (typeof window.vmxAdminAccess?.refresh === 'function')
        ? await window.vmxAdminAccess.refresh(true)
        : await window.vmInstaller.isAdmin();
      if (isAdmin) return true;

      window.vmxAdminAccess?.focus?.(`"${taskName}" requires administrator mode.`);
      Dashboard._notify(`"${taskName}" requires administrator mode. Use Continue with Admin Privilege.`, 'info');
      return false;
    } catch (err) {
      Dashboard._notify(err?.message || 'Could not verify administrator mode.', 'error');
      return false;
    }
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

    vms.forEach((vm, index) => {
      const id = Dashboard._getVmDomId(vm, index);

      document.getElementById(`vm-power-${id}`)?.addEventListener('click', async function() {
        if (this.disabled) return;
        const adminReady = await Dashboard._ensureAdminForTask('V Os power control');
        if (!adminReady) return;
        this.disabled = true;
        this.classList.add('is-loading');

        const powerLabel = this.querySelector('.vm-power-label');
        const shouldStart = vm.state !== 'running' && vm.state !== 'paused';
        if (powerLabel) powerLabel.textContent = shouldStart ? 'Starting...' : 'Stopping...';

        const result = shouldStart
          ? await window.vmInstaller.startVM(vm.name)
          : await window.vmInstaller.stopVM(vm.name);

        if (!result?.success) {
          Dashboard._notify(result?.error || `Failed to ${shouldStart ? 'start' : 'stop'} V Os`, 'error');
          await Dashboard._checkPermissions();
          this.disabled = false;
          this.classList.remove('is-loading');
          if (powerLabel) powerLabel.textContent = shouldStart ? 'Start' : 'Running...';
          return;
        }

        this.disabled = false;
        this.classList.remove('is-loading');
        if (powerLabel) powerLabel.textContent = shouldStart ? 'Running...' : 'Stopped';
        if (!shouldStart) {
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
        await Dashboard._refreshAfterMutation(app);
        Dashboard._notify(`${shouldStart ? 'Start' : 'Stop'} command completed.`, 'success');
      });

      document.getElementById(`vm-edit-${id}`)?.addEventListener('click', () => {
        Dashboard._openRenameModal(vm, app);
      });

      document.getElementById(`vm-settings-${id}`)?.addEventListener('click', async () => {
        if (app && typeof app.showSettings === 'function') {
          app.showSettings({
            scope: 'vos',
            section: vm.state === 'running' ? 'integration' : 'compute',
            vmName: vm.name,
            lockScope: true
          });
          return;
        }

        const result = await window.vmInstaller.getVMDetails(vm.name);
        if (!result.success) {
          Dashboard._notify(result.error || 'Could not load V Os settings', 'error');
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

      document.getElementById(`vm-repair-${id}`)?.addEventListener('click', async function () {
        if (this.disabled) return;
        this.disabled = true;
        const originalText = this.textContent;
        this.textContent = 'Repairing...';
        try {
          await Dashboard._runOneClickRepair(vm, app);
        } finally {
          this.disabled = false;
          this.textContent = originalText;
        }
      });

      document.getElementById(`vm-integrate-${id}`)?.addEventListener('click', async () => {
        await Dashboard._openGuestIntegrationModal(vm, app);
      });

      document.getElementById(`vm-toggle-fit-${id}`)?.addEventListener('click', async function () {
        if (this.disabled) return;
        const adminReady = await Dashboard._ensureAdminForTask('update display fit');
        if (!adminReady) return;

        this.disabled = true;
        const enableFit = vm.fullscreenEnabled === false;
        const result = await window.vmInstaller.editVM(vm.name, { fullscreenEnabled: enableFit });
        if (!result?.success) {
          Dashboard._notify(result?.error || 'Failed to update display fit.', 'error');
          this.disabled = false;
          return;
        }

        Dashboard._notify(`Guest display fit ${enableFit ? 'enabled' : 'disabled'}.`, 'success');
        await Dashboard._refreshAfterMutation(app);
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

      document.getElementById(`vm-menu-folder-${id}`)?.addEventListener('click', async () => {
        menuEl?.classList.remove('open');
        const result = await window.vmInstaller.showVMInExplorer({ vmName: vm.name, vmDir: vm.vmDir || '' });
        if (!result?.success) {
          Dashboard._notify(result?.error || 'Could not open V Os folder.', 'error');
        }
      });
    });
  },

  _renderVMCard(vm, index = 0) {
    const id = Dashboard._getVmDomId(vm, index);
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
    const safeVmName = Dashboard._escapeHtml(vm.name);
    const safeOsLabel = Dashboard._escapeHtml(osLabel);
    const safeNetwork = Dashboard._escapeHtml(vm.network);
    const ramNumeric = Number(vm.ram);
    const cpuNumeric = Number(vm.cpus);
    const vramNumeric = Number(vm.vram);
    const ramDisplay = Number.isFinite(ramNumeric) ? String(ramNumeric) : Dashboard._escapeHtml(vm.ram || '--');
    const cpuDisplay = Number.isFinite(cpuNumeric) ? String(cpuNumeric) : Dashboard._escapeHtml(vm.cpus || '--');
    const vramDisplay = Number.isFinite(vramNumeric) ? String(vramNumeric) : Dashboard._escapeHtml(vm.vram || '--');
    const cpuPlural = Number.isFinite(cpuNumeric) && cpuNumeric > 1 ? 's' : '';
    const powerClass = isRunning ? 'running' : isPaused ? 'paused' : 'stopped';
    const powerLabel = Dashboard._getPowerLabel(vm.state);

    const featureBadges = [
      { label: 'Clipboard', on: (vm.clipboardMode || vm.clipboard || '').toLowerCase() !== 'disabled' },
      { label: 'Drag&Drop', on: (vm.dragAndDrop || vm.draganddrop || '').toLowerCase() !== 'disabled' },
      { label: 'Guest Display', on: vm.fullscreenEnabled !== false },
      { label: 'Audio', on: !!vm.audioEnabled },
      { label: 'USB', on: !!vm.usbEnabled },
      { label: '3D', on: !!vm.accelerate3d },
      { label: 'EFI', on: !!vm.efiEnabled },
      { label: 'Nested VT', on: !!vm.nestedVirtualization }
    ];

    const checks = vm.integrationChecks || {};
    const sharedFolders = Array.isArray(vm.sharedFolders) ? vm.sharedFolders : [];
    const primarySharedFolderPath = String(vm.primarySharedFolderPath || sharedFolders[0]?.hostPath || '').trim();
    const safePrimarySharedPath = Dashboard._escapeHtml(primarySharedFolderPath || 'Not configured');
    const sharedFolderSummary = sharedFolders.length > 0
      ? sharedFolders.map((sf) => `${sf.name || 'shared'}: ${sf.hostPath || 'Unknown path'}`).join(' | ')
      : 'No shared folder mapped';
    const safeSharedFolderSummary = Dashboard._escapeHtml(sharedFolderSummary);

    const normalizeMode = (rawValue) => {
      const value = String(rawValue || 'disabled').toLowerCase();
      return ['disabled', 'hosttoguest', 'guesttohost', 'bidirectional'].includes(value) ? value : 'disabled';
    };
    const modeLabel = (mode) => {
      if (mode === 'hosttoguest') return 'Host->Guest';
      if (mode === 'guesttohost') return 'Guest->Host';
      if (mode === 'bidirectional') return 'Bidirectional';
      return 'Off';
    };
    const runtimeCheckAvailable = isRunning;
    const guestAdditionsReady = !!checks.guestAdditions;
    // buildStatus for guest-dependent features that truly need runtime verification
    const buildGuestDependentStatus = ({ configured, runtimeReady, onText, offText = 'Off', issueText = 'Needs setup' }) => {
      if (!configured) {
        return { state: 'off', value: offText, icon: Icons.sized(Icons.info, 14) };
      }
      if (runtimeReady) {
        return { state: 'ok', value: onText, icon: Icons.sized(Icons.checkCircle, 14) };
      }
      if (!runtimeCheckAvailable) {
        return { state: 'pending', value: `${onText} (verify after start)`, icon: Icons.sized(Icons.warning, 14) };
      }
      if (!guestAdditionsReady) {
        return { state: 'pending', value: `${onText} (waiting GA)`, icon: Icons.sized(Icons.warning, 14) };
      }
      return { state: 'missing', value: issueText, icon: Icons.sized(Icons.xCircle, 14) };
    };
    // buildStatus for host-side settings that are applied via VBoxManage and confirmed even when VM is off
    const buildHostSideStatus = ({ configured, onText, offText = 'Off' }) => {
      if (!configured) {
        return { state: 'off', value: offText, icon: Icons.sized(Icons.info, 14) };
      }
      return { state: 'ok', value: onText, icon: Icons.sized(Icons.checkCircle, 14) };
    };
    // buildModeStatus for host-side mode settings (clipboard, drag-and-drop)
    const buildHostModeStatus = (mode) => {
      const configured = mode !== 'disabled';
      const label = modeLabel(mode);
      if (!configured) {
        return { state: 'off', value: label, icon: Icons.sized(Icons.info, 14) };
      }
      return { state: 'ok', value: label, icon: Icons.sized(Icons.checkCircle, 14) };
    };

    const clipboardMode = normalizeMode(vm.clipboardMode || vm.clipboard);
    const dragDropMode = normalizeMode(vm.dragAndDrop || vm.draganddrop);
    const sharedConfigured = sharedFolders.length > 0 || primarySharedFolderPath.length > 0;

    const guestAdditionsStatus = guestAdditionsReady
      ? { state: 'ok', value: 'Ready', icon: Icons.sized(Icons.checkCircle, 14) }
      : runtimeCheckAvailable
      ? { state: 'missing', value: 'Install GA', icon: Icons.sized(Icons.xCircle, 14) }
      : { state: 'ok', value: 'Check after start', icon: Icons.sized(Icons.checkCircle, 14) };
    const integrationRows = [
      { label: 'Guest Additions', ...guestAdditionsStatus },
      { label: 'Guest Display Fit', ...buildHostSideStatus({ configured: vm.fullscreenEnabled !== false, onText: 'On' }) },
      { label: 'Display Integration', ...buildGuestDependentStatus({ configured: vm.fullscreenEnabled !== false, runtimeReady: !!checks.fullscreenReady, onText: 'Ready', issueText: 'Needs guest setup' }) },
      { label: 'Clipboard Sync', ...buildHostModeStatus(clipboardMode) },
      { label: 'Drag & Drop', ...buildHostModeStatus(dragDropMode) },
      { label: 'Shared Folder', ...buildGuestDependentStatus({ configured: sharedConfigured, runtimeReady: !!checks.sharedFolder, onText: 'Mapped', offText: 'Not mapped', issueText: 'Mount required' }) }
    ];

    return `
      <div class="vm-card ${stateClass} ${osClass}">
        <div class="vm-card-header">
          <div class="vm-card-icon">${Icons.sized(dsOsIcon, 38)}</div>
          <div class="vm-card-title-group">
            <div class="vm-card-name">${safeVmName}</div>
            <div class="vm-card-os">${safeOsLabel}</div>
          </div>
          <div class="vm-card-state ${stateClass}">
            <span class="state-dot ${stateClass}"></span>
            <span class="state-text">${stateLabel}</span>
          </div>
        </div>

        <div class="vm-card-specs">
          <div class="vm-spec" title="Memory">${Icons.sized(Icons.memory, 14)} <span><strong>RAM</strong> ${ramDisplay} MB</span></div>
          <div class="vm-spec" title="Processor">${Icons.sized(Icons.cpu, 14)} <span><strong>CPU</strong> ${cpuDisplay} Core${cpuPlural}</span></div>
          <div class="vm-spec" title="Video Memory">${Icons.sized(Icons.monitor, 14)} <span><strong>VRAM</strong> ${vramDisplay} MB</span></div>
          <div class="vm-spec" title="Network Mode">${Icons.sized(Icons.globe, 14)} <span><strong>NET</strong> ${safeNetwork}</span></div>
          <div class="vm-spec" title="Primary shared folder path">${Icons.sized(Icons.folder, 14)} <span><strong>SHARE</strong> ${safePrimarySharedPath}</span></div>
        </div>

          <div class="vm-feature-badges">
            ${featureBadges.map(f => `<span class="vm-feature-badge ${f.on ? 'on' : 'off'}">${f.label} ${f.on ? 'ON' : 'OFF'}</span>`).join('')}
        </div>

        <div class="vm-integration-report">
          <div class="vm-integration-head">
            <div class="vm-integration-title">Integration Status</div>
            <div class="vm-integration-controls">
              <button class="btn btn-sm btn-primary" id="vm-repair-${id}">Fix All</button>
              <button class="btn btn-sm btn-secondary" id="vm-integrate-${id}">Manage</button>
              <button class="btn btn-sm ${vm.fullscreenEnabled !== false ? 'btn-primary' : 'btn-secondary'}" id="vm-toggle-fit-${id}">
                Display Fit ${vm.fullscreenEnabled !== false ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
          <div class="vm-integration-grid">
            ${integrationRows.map(item => `
              <div class="vm-integration-item ${item.state}">
                ${item.icon}
                <span class="vm-integration-label">${item.label}</span>
                <span class="vm-integration-value">${item.value}</span>
              </div>
            `).join('')}
          </div>
          <div class="vm-shared-summary" title="${safeSharedFolderSummary}">
            <strong>Shared Folder:</strong> ${safeSharedFolderSummary}
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
            <button class="btn btn-sm btn-secondary btn-icon-text" id="vm-edit-${id}" title="Rename V Os">
              ${Icons.sized(Icons.edit, 14)} Edit
            </button>
            <button class="btn btn-sm btn-secondary btn-icon-text" id="vm-settings-${id}" title="Edit V Os settings">
              ${Icons.sized(Icons.settings, 14)} V Os Settings
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

  async _runOneClickRepair(vm, app) {
    const adminReady = await Dashboard._ensureAdminForTask('repair guest integration');
    if (!adminReady) return;

    let guestUser = 'guest';
    let guestPass = 'guest';
    try {
      const prefsResult = await window.vmInstaller.getUiPrefs();
      if (prefsResult?.success && prefsResult.prefs) {
        guestUser = String(prefsResult.prefs.guestUsername || prefsResult.prefs.username || guestUser).trim() || guestUser;
        guestPass = String(prefsResult.prefs.guestPassword ?? prefsResult.prefs.password ?? guestPass);
      }
    } catch {}

    const sharedFolderPath = String(vm?.primarySharedFolderPath || vm?.sharedFolders?.[0]?.hostPath || '').trim();
    const clipboardMode = String(vm?.clipboardMode || 'bidirectional').toLowerCase();
    const dragAndDrop = String(vm?.dragAndDrop || 'bidirectional').toLowerCase();

    Dashboard._notify(`Repair started for ${vm.name}.`, 'info');
    let result;
    try {
      result = await window.vmInstaller.configureGuestIntegration(vm.name, {
        guestUser,
        guestPass,
        sharedFolderPath,
        sharedFolderName: 'shared',
        enableSharedFolder: true,
        autoStartVm: true,
        startFullscreen: vm.fullscreenEnabled !== false,
        accelerate3d: !!vm.accelerate3d,
        quickRepair: true,
        clipboardMode,
        dragAndDrop
      });
    } catch (err) {
      Dashboard._notify(err?.message || 'Repair failed.', 'error');
      return;
    }

    if (!result?.success) {
      Dashboard._notify(result?.error || 'Repair failed.', 'error');
      if (result?.error && /admin|credential|login|auth|password|ready|running/i.test(result.error)) {
        await Dashboard._openGuestIntegrationModal(vm, app);
      }
      return;
    }

    if (result.pendingInGuest) {
      Dashboard._notify(result.message || 'Host-side repair applied. Start the V Os to finish in-guest setup.', 'info');
      await Dashboard._refreshAfterMutation(app);
      return;
    }

    const notes = Array.isArray(result.notes) ? result.notes : [];
    if (!sharedFolderPath) {
      notes.push('No shared folder host path is saved for this V Os.');
    }
    const hardFailures = notes.filter((n) => /failed|error|timeout|unable|not running|not installed/i.test(String(n || '')));
    if (hardFailures.length) {
      Dashboard._notify(`Repair completed with warnings: ${hardFailures[0]}`, 'info');
    } else if (!sharedFolderPath) {
      Dashboard._notify('Core integration repaired. Set a shared folder path in Manage to restore shared folders.', 'info');
    } else {
      Dashboard._notify('All guest integration settings were repaired successfully.', 'success');
    }

    await Dashboard._refreshAfterMutation(app);
  },

  async _openGuestIntegrationModal(vm, app) {
    let defaultAdminUser = 'guest';
    let defaultAdminPass = 'guest';
    try {
      const prefsResult = await window.vmInstaller.getUiPrefs();
      if (prefsResult?.success && prefsResult.prefs) {
        defaultAdminUser = String(prefsResult.prefs.guestUsername || prefsResult.prefs.username || defaultAdminUser);
        defaultAdminPass = String(prefsResult.prefs.guestPassword ?? prefsResult.prefs.password ?? defaultAdminPass);
      }
    } catch {}

    const safeDefaultUser = Dashboard._escapeHtml(defaultAdminUser);
    const safeDefaultPass = Dashboard._escapeHtml(defaultAdminPass);
    const defaultSharedPath = String(vm?.primarySharedFolderPath || vm?.sharedFolders?.[0]?.hostPath || '').trim();
    const safeDefaultSharedPath = Dashboard._escapeHtml(defaultSharedPath);

    const { close, modal } = this._openModal({
      title: `Guest Setup — ${vm.name}`,
      body: `
        <div class="vm-modal-note">Use this to configure Guest Additions, display integration, clipboard, drag & drop, and shared folders inside the guest OS.</div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">OS Admin Username</label>
            <input class="form-input" id="giUser" value="${safeDefaultUser}" />
          </div>
          <div class="form-group">
            <label class="form-label">OS Admin Password</label>
            <input class="form-input" id="giPass" type="password" value="${safeDefaultPass}" />
          </div>
        </div>
          <div class="form-group">
            <label class="form-label">Shared Folder Host Path (optional)</label>
            <div style="display:flex; gap:8px;">
              <input class="form-input" id="giSharedPath" value="${safeDefaultSharedPath}" placeholder="C:\\Users\\<you>\\Documents" />
              <button class="btn" id="giBrowsePath">Browse</button>
            </div>
          </div>
        <div class="form-row">
          <label><input type="checkbox" id="giEnableShare" checked> Configure shared folder integration</label>
          <label><input type="checkbox" id="giAutoStart"> Auto-start V Os if needed</label>
          <label><input type="checkbox" id="giFullscreen" ${vm.fullscreenEnabled !== false ? 'checked' : ''}> Enable Guest Display Fit</label>
          <label><input type="checkbox" id="gi3dAcceleration" ${vm.accelerate3d ? 'checked' : ''}> Enable 3D acceleration</label>
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
      const adminReady = await Dashboard._ensureAdminForTask('guest integration setup');
      if (!adminReady) return;

      const runBtn = modal.querySelector('#giRun');
      const msg = modal.querySelector('#giMsg');
      runBtn.disabled = true;
      runBtn.textContent = 'Applying...';
      msg.textContent = 'Applying integration. This can take a few minutes...';
      msg.className = 'vm-inline-message';

      const payload = {
        guestUser: modal.querySelector('#giUser')?.value?.trim() || 'guest',
        guestPass: modal.querySelector('#giPass')?.value ?? 'guest',
        sharedFolderPath: modal.querySelector('#giSharedPath')?.value?.trim() || '',
        sharedFolderName: 'shared',
        enableSharedFolder: !!modal.querySelector('#giEnableShare')?.checked,
        autoStartVm: !!modal.querySelector('#giAutoStart')?.checked,
        startFullscreen: !!modal.querySelector('#giFullscreen')?.checked,
        accelerate3d: !!modal.querySelector('#gi3dAcceleration')?.checked
      };

      const result = await window.vmInstaller.configureGuestIntegration(vm.name, payload);
      if (result?.pendingInGuest) {
        const extra = Array.isArray(result?.notes) && result.notes.length > 0
          ? ` ${result.notes.join(' | ')}`
          : '';
        msg.textContent = `${result.message || 'Host-side integration was applied. Finish guest setup after login.'}${extra}`;
        msg.className = 'vm-inline-message';
        runBtn.disabled = false;
        runBtn.textContent = 'Apply Guest Setup';
        Dashboard._notify('Host-side integration applied. Finish in-guest setup after V Os login.', 'info');
        return;
      }

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
      await Dashboard._refreshAfterMutation(app);
    });
  },

  _openCloneModal(vm, app) {
    const suggestedName = `${vm.name} Clone`;
    const safeSuggestedName = Dashboard._escapeHtml(suggestedName);
    const { close, modal } = this._openModal({
      title: `Clone V Os — ${vm.name}`,
      body: `
        <div class="form-group">
          <label class="form-label">Clone Name</label>
          <input class="form-input" id="cloneVmInput" value="${safeSuggestedName}" maxlength="80" />
        </div>
        <div class="vm-modal-note">Cloning duplicates all disks and settings. This can take a few minutes.</div>
        <div class="vm-inline-message" id="cloneVmMsg"></div>
      `,
      footer: `
        <button class="btn btn-secondary" id="cloneVmCancel">Cancel</button>
        <button class="btn btn-primary" id="cloneVmStart">Clone V Os</button>
      `
    });

    const input = modal.querySelector('#cloneVmInput');
    input?.focus();

    modal.querySelector('#cloneVmCancel')?.addEventListener('click', close);
    modal.querySelector('#cloneVmStart')?.addEventListener('click', async () => {
      const adminReady = await Dashboard._ensureAdminForTask('clone V Os');
      if (!adminReady) return;

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
      this._notify('V Os cloned successfully', 'success');
      close();
      await Dashboard._refreshAfterMutation(app);
    });
  },

  _openSettingsModal(vm, app) {
    const overlay = document.getElementById('vmModalOverlay');
    const modal = document.getElementById('vmSettingsModal');
    if (!overlay || !modal) return;

    const safeVmName = Dashboard._escapeHtml(vm.name);
    const ramValue = Number.isFinite(Number(vm.ram)) ? Number(vm.ram) : 2048;
    const cpuValue = Number.isFinite(Number(vm.cpus)) ? Number(vm.cpus) : 2;
    const vramValue = Number.isFinite(Number(vm.vram)) ? Number(vm.vram) : 32;
    const bootOrderValue = Dashboard._escapeHtml(
      Array.isArray(vm.bootOrder) && vm.bootOrder.length > 0
        ? vm.bootOrder.join(',')
        : 'disk,dvd,none,none'
    );

    const sharedRows = (vm.sharedFolders || []).map((sf, index) => `
      <div class="vm-share-row" data-index="${index}">
        <input class="form-input vm-share-name" value="${Dashboard._escapeHtml(sf.name || '')}" placeholder="Share name" />
        <input class="form-input vm-share-path" value="${Dashboard._escapeHtml(sf.hostPath || '')}" placeholder="Host path" />
        <button type="button" class="btn btn-sm btn-secondary vm-share-browse">Browse</button>
      </div>
    `).join('') || '<div class="vm-share-empty">No shared folders configured yet.</div>';

    modal.innerHTML = `
      <div class="vm-modal-header">
        <h3>Edit Settings — ${safeVmName}</h3>
        <button class="btn btn-sm btn-ghost" id="vmModalClose">Close</button>
      </div>
      <div class="vm-modal-body">
        <div class="form-row">
          <div class="form-group"><label class="form-label">RAM (MB)</label><input class="form-input" id="editRam" type="number" value="${ramValue}"></div>
          <div class="form-group"><label class="form-label">CPUs</label><input class="form-input" id="editCpus" type="number" value="${cpuValue}"></div>
          <div class="form-group"><label class="form-label">VRAM (MB)</label><input class="form-input" id="editVram" type="number" value="${vramValue}"></div>
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
              <option value="internal" ${['internal', 'intnet'].includes((vm.network || '').toLowerCase()) ? 'selected' : ''}>Internal</option>
              <option value="hostonly" ${(vm.network || '').toLowerCase() === 'hostonly' ? 'selected' : ''}>Host-Only</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Boot Order (comma separated)</label>
          <input class="form-input" id="editBootOrder" value="${bootOrderValue}">
        </div>
        <div class="vm-toggle-grid">
          <label><input type="checkbox" id="tClipboard" ${(vm.clipboardMode || '').toLowerCase() !== 'disabled' ? 'checked' : ''}> Clipboard</label>
          <label><input type="checkbox" id="tDnD" ${(vm.dragAndDrop || '').toLowerCase() !== 'disabled' ? 'checked' : ''}> Drag & Drop</label>
          <label><input type="checkbox" id="tFullscreen" ${vm.fullscreenEnabled !== false ? 'checked' : ''}> Guest Display Fullscreen</label>
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
    Dashboard._modalActive = true;

    const escHandler = (e) => {
      if (e.key === 'Escape') close();
    };

    const close = () => {
      overlay.style.display = 'none';
      modal.style.display = 'none';
      modal.innerHTML = '';
      overlay.onclick = null;
      document.removeEventListener('keydown', escHandler);
      Dashboard._modalActive = false;

      if (document.getElementById('navMachines')?.classList.contains('active') && Dashboard._liveSyncApp) {
        Dashboard.loadVMs(Dashboard._liveSyncApp, { silent: true });
      }
    };

    document.getElementById('vmModalClose')?.addEventListener('click', close);
    document.getElementById('vmModalCancel')?.addEventListener('click', close);
    overlay.onclick = close;
    document.addEventListener('keydown', escHandler);

    document.getElementById('addShareRow')?.addEventListener('click', () => {
      const list = document.getElementById('vmShareList');
      if (!list) return;
      const empty = list.querySelector('.vm-share-empty');
      if (empty) empty.remove();
      const row = document.createElement('div');
      row.className = 'vm-share-row';
      row.innerHTML = `<input class="form-input vm-share-name" placeholder="Share name" /><input class="form-input vm-share-path" placeholder="Host path" /><button type="button" class="btn btn-sm btn-secondary vm-share-browse">Browse</button>`;
      list.appendChild(row);
    });

    modal.querySelector('#vmShareList')?.addEventListener('click', async (event) => {
      const button = event.target.closest('.vm-share-browse');
      if (!button) return;

      const row = button.closest('.vm-share-row');
      const pathInput = row?.querySelector('.vm-share-path');
      const currentPath = pathInput?.value?.trim() || '';

      const selected = await window.vmInstaller.selectFolder('Select shared folder path', currentPath);
      if (!selected) return;
      if (pathInput) pathInput.value = selected;
    });

    document.getElementById('vmModalSave')?.addEventListener('click', async () => {
      const saveBtn = document.getElementById('vmModalSave');
      if (saveBtn?.disabled) return;

      const adminReady = await Dashboard._ensureAdminForTask('save V Os settings');
      if (!adminReady) return;

      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
      }

      const shares = Array.from(modal.querySelectorAll('.vm-share-row')).map((row) => {
        const name = row.querySelector('.vm-share-name')?.value?.trim();
        const hostPath = row.querySelector('.vm-share-path')?.value?.trim();
        return { name, hostPath, autoMount: true };
      }).filter((s) => s.name && s.hostPath);
      const selectedNetwork = (document.getElementById('editNetwork')?.value || 'nat').toLowerCase();
      const originalNetwork = (vm.network || '').toLowerCase();
      const normalizedOriginalNetwork = originalNetwork === 'intnet' ? 'internal' : originalNetwork;

      const payload = {
        ram: parseInt(document.getElementById('editRam')?.value || vm.ram),
        cpus: parseInt(document.getElementById('editCpus')?.value || vm.cpus),
        vram: parseInt(document.getElementById('editVram')?.value || vm.vram),
        graphicsController: document.getElementById('editGraphics')?.value || 'vmsvga',
        audioController: document.getElementById('editAudioController')?.value || 'hda',
        bootOrder: (document.getElementById('editBootOrder')?.value || 'disk,dvd,none,none').split(',').map(v => v.trim()).filter(Boolean),
        clipboardMode: document.getElementById('tClipboard')?.checked ? 'bidirectional' : 'disabled',
        dragAndDrop: document.getElementById('tDnD')?.checked ? 'bidirectional' : 'disabled',
        fullscreenEnabled: !!document.getElementById('tFullscreen')?.checked,
        audioEnabled: !!document.getElementById('tAudio')?.checked,
        usbEnabled: !!document.getElementById('tUsb')?.checked,
        accelerate3d: !!document.getElementById('t3d')?.checked,
        efiEnabled: !!document.getElementById('tEfi')?.checked,
        nestedVirtualization: !!document.getElementById('tNested')?.checked,
        sharedFolders: shares
      };
      if (selectedNetwork !== normalizedOriginalNetwork) {
        payload.networkMode = selectedNetwork;
      }

      const result = await window.vmInstaller.editVM(vm.name, payload);
      if (!result.success) {
        Dashboard._notify(`Failed to save settings: ${result.error || 'Unknown error'}`, 'error');
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
        }
        return;
      }

      const refreshed = await window.vmInstaller.getVMDetails(vm.name);
      if (!refreshed.success) {
        Dashboard._notify('Settings saved, but failed to reload V Os details.', 'info');
      } else {
        if (Array.isArray(result.warnings) && result.warnings.length > 0) {
          Dashboard._notify(`V Os settings saved with warnings: ${result.warnings.join(' | ')}`, 'info');
        } else {
          Dashboard._notify('V Os settings saved and verified successfully', 'success');
        }
      }

      close();
      await Dashboard._refreshAfterMutation(app);
    });
  },

  _openRenameModal(vm, app) {
    const safeVmName = Dashboard._escapeHtml(vm.name);
    const { close, modal } = this._openModal({
      title: 'Rename V Os',
      body: `
        <div class="vm-modal-note">Current name: <strong>${safeVmName}</strong></div>
        <div class="form-group">
          <label class="form-label">New Name</label>
          <input class="form-input" id="renameVmInput" value="${safeVmName}" maxlength="80" />
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
      const adminReady = await Dashboard._ensureAdminForTask('rename V Os');
      if (!adminReady) return;

      const msg = modal.querySelector('#renameVmMsg');
      const newName = input?.value?.trim() || '';
      if (!newName) {
        msg.textContent = 'V Os name is required.';
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

      this._notify('V Os renamed successfully', 'success');
      close();
      await Dashboard._refreshAfterMutation(app);
    });
  },

  _openDeleteConfirm(vm, app) {
    const { close, modal } = this._openModal({
      title: `Delete V Os — ${vm.name}`,
      body: `
        <div class="vm-modal-note danger">This removes the V Os and all associated files. This action cannot be undone.</div>
        <div class="vm-inline-message" id="deleteVmMsg"></div>
      `,
      footer: `
        <button class="btn btn-secondary" id="deleteVmCancel">Cancel</button>
        <button class="btn btn-danger" id="deleteVmConfirm">Delete</button>
      `
    });

    modal.querySelector('#deleteVmCancel')?.addEventListener('click', close);
    modal.querySelector('#deleteVmConfirm')?.addEventListener('click', async () => {
      const adminReady = await Dashboard._ensureAdminForTask('delete V Os');
      if (!adminReady) return;

      const msg = modal.querySelector('#deleteVmMsg');
      const result = await window.vmInstaller.deleteVM(vm.name);
      if (!result.success) {
        msg.textContent = result.error || 'Delete failed.';
        msg.className = 'vm-inline-message error';
        return;
      }

      this._notify('V Os deleted successfully', 'success');
      close();
      await Dashboard._refreshAfterMutation(app);
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
      const adminReady = await Dashboard._ensureAdminForTask('boot fix');
      if (!adminReady) return;

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
      const fixesMarkup = fixes.length
        ? fixes.map((f) => `<li>${Dashboard._escapeHtml(f)}</li>`).join('')
        : '<li>No changes required.</li>';
      const diagMarkup = diag.map((d) => `<li><strong>${Dashboard._escapeHtml(d.key)}</strong>: ${Dashboard._escapeHtml(d.message)}</li>`).join('');
      resultEl.innerHTML = `
        <div class="vm-bootfix-block">
          <div class="vm-bootfix-title">Applied Fixes</div>
          <ul>${fixesMarkup}</ul>
        </div>
        <div class="vm-bootfix-block">
          <div class="vm-bootfix-title">Diagnostics</div>
          <ul>${diagMarkup}</ul>
        </div>
      `;
      runBtn.remove();
      this._notify('Boot diagnostics complete', 'success');
      await Dashboard._refreshAfterMutation(app);
    });
  },

  async _openAccountsModal(vm) {
    let defaultAdminUser = 'guest';
    let defaultAdminPass = 'guest';
    try {
      const prefsResult = await window.vmInstaller.getUiPrefs();
      if (prefsResult?.success && prefsResult.prefs) {
        defaultAdminUser = String(prefsResult.prefs.guestUsername || prefsResult.prefs.username || defaultAdminUser);
        defaultAdminPass = String(prefsResult.prefs.guestPassword ?? prefsResult.prefs.password ?? defaultAdminPass);
      }
    } catch {}

    const escapedDefaultUser = Dashboard._escapeHtml(defaultAdminUser);
    const escapedDefaultPass = Dashboard._escapeHtml(defaultAdminPass);

    const { close, modal } = this._openModal({
      title: `Account Management Center — ${vm.name}`,
      body: `
        <div class="vm-users-panel">
          <div class="vm-users-panel-title">Access Credentials</div>
          <div class="vm-users-panel-note">Use your OS login (the user you created). VirtualBox runs account commands inside the running V Os using these credentials.</div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">OS Admin Username</label>
              <input class="form-input" id="accGuestUser" value="${escapedDefaultUser}" />
            </div>
            <div class="form-group">
              <label class="form-label">OS Admin Password</label>
              <input class="form-input" id="accGuestPass" type="password" value="${escapedDefaultPass}" />
            </div>
          </div>
        </div>
        <div class="vm-users-panel">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Action</label>
              <select class="form-select" id="accAction">
                <option value="list">Show All Users</option>
                <option value="create">Create User</option>
                <option value="update">Update User</option>
                <option value="delete">Delete User</option>
                <option value="autologin">Set Auto-login</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Action Details</label>
              <div class="vm-inline-message" id="accActionHint">Load all OS accounts from /etc/passwd.</div>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group" data-actions="create,update,delete,autologin">
              <label class="form-label">Target Username</label>
              <input class="form-input" id="accTargetUser" placeholder="Example: ubuntu" />
            </div>
            <div class="form-group" data-actions="update">
              <label class="form-label">New Username (Optional)</label>
              <input class="form-input" id="accNewUser" placeholder="Leave empty to keep existing name" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group" data-actions="create,update">
              <label class="form-label">Password</label>
              <input class="form-input" id="accPassword" type="password" placeholder="Required for create; optional for update" />
            </div>
          </div>
        </div>
        <div class="vm-inline-message" id="accMsg">Account center ready.</div>
        <div class="vm-users-list" id="accUsersList"></div>
      `,
      footer: `
        <button class="btn btn-secondary" id="accClose">Close</button>
        <button class="btn btn-ghost" id="accRefresh">Refresh Users</button>
        <button class="btn btn-primary" id="accRun">Run Action</button>
      `
    });

    const getPayload = () => ({
      vmName: vm.name,
      guestUser: modal.querySelector('#accGuestUser')?.value?.trim(),
      guestPass: modal.querySelector('#accGuestPass')?.value ?? ''
    });

    const msg = modal.querySelector('#accMsg');
    const actionHint = modal.querySelector('#accActionHint');
    const actionSelect = modal.querySelector('#accAction');
    const runBtn = modal.querySelector('#accRun');
    const refreshBtn = modal.querySelector('#accRefresh');
    const usersList = modal.querySelector('#accUsersList');
    const vmStateLabel = String(vm?.state || 'unknown').toLowerCase();
    const actionConfig = {
      list: { button: 'Show Users', hint: 'Load all OS accounts from /etc/passwd.' },
      create: { button: 'Create User', hint: 'Creates a user, assigns password, and adds sudo group.' },
      update: { button: 'Update User', hint: 'Rename user and/or update password for an existing account.' },
      delete: { button: 'Delete User', hint: 'Deletes selected user and removes its home directory. Root/admin user is protected.' },
      autologin: { button: 'Set Auto-login', hint: 'Configures GDM to auto-login with the selected user.' }
    };

    const setMessage = (text, type = 'default') => {
      if (!msg) return;
      msg.textContent = text;
      msg.className = `vm-inline-message${type === 'default' ? '' : ` ${type}`}`;
    };

    const getAdminUsername = () => String(modal.querySelector('#accGuestUser')?.value || '').trim().toLowerCase();
    const isProtectedDeleteTarget = (username) => {
      const candidate = String(username || '').trim().toLowerCase();
      if (!candidate) return true;
      const adminUser = getAdminUsername();
      return candidate === 'root' || (adminUser && candidate === adminUser);
    };

    const renderUsers = (users = [], details = []) => {
      if (!usersList) return;
      usersList.innerHTML = '';

      const titleRow = document.createElement('div');
      titleRow.className = 'vm-users-title';
      titleRow.textContent = `Users (${users.length})`;

      const table = document.createElement('div');
      table.className = 'vm-users-table';

      const header = document.createElement('div');
      header.className = 'vm-users-row vm-users-row--header';
      ['Username', 'Type', 'UID', 'Home', 'Actions'].forEach((label) => {
        const cell = document.createElement('div');
        cell.className = 'vm-users-cell';
        cell.textContent = label;
        header.appendChild(cell);
      });
      table.appendChild(header);

      const detailedMap = new Map((details || []).map((item) => [item.username, item]));
      users.forEach((username) => {
        const row = document.createElement('div');
        row.className = 'vm-users-row';
        const detail = detailedMap.get(username) || {};

        const usernameCell = document.createElement('div');
        usernameCell.className = 'vm-users-cell';
        usernameCell.textContent = username;

        const typeCell = document.createElement('div');
        typeCell.className = 'vm-users-cell';
        const typeBadge = document.createElement('span');
        typeBadge.className = `vm-users-badge ${detail.type === 'human' ? 'human' : 'system'}`;
        typeBadge.textContent = detail.type === 'human' ? 'Human' : 'System';
        typeCell.appendChild(typeBadge);

        const uidCell = document.createElement('div');
        uidCell.className = 'vm-users-cell';
        uidCell.textContent = detail.uid ?? '-';

        const homeCell = document.createElement('div');
        homeCell.className = 'vm-users-cell';
        homeCell.textContent = detail.home || '-';

        const actionsCell = document.createElement('div');
        actionsCell.className = 'vm-users-cell vm-users-cell--actions';
        const deleteBtn = document.createElement('button');
        const protectedAccount = isProtectedDeleteTarget(username);
        deleteBtn.className = `btn btn-sm ${protectedAccount ? 'btn-secondary' : 'btn-danger'} vm-users-delete`;
        deleteBtn.dataset.username = username;
        deleteBtn.textContent = protectedAccount ? 'Protected' : 'Delete';
        deleteBtn.disabled = protectedAccount;
        if (protectedAccount) {
          deleteBtn.title = 'Root and current admin user cannot be deleted from this panel.';
        }
        actionsCell.appendChild(deleteBtn);

        row.appendChild(usernameCell);
        row.appendChild(typeCell);
        row.appendChild(uidCell);
        row.appendChild(homeCell);
        row.appendChild(actionsCell);
        table.appendChild(row);
      });

      usersList.appendChild(titleRow);
      usersList.appendChild(table);
    };

    const updateActionForm = () => {
      const action = actionSelect?.value || 'list';
      const config = actionConfig[action] || actionConfig.list;

      if (actionHint) actionHint.textContent = config.hint;
      if (runBtn) runBtn.textContent = config.button;

      const actionFields = modal.querySelectorAll('[data-actions]');
      actionFields.forEach((field) => {
        const allowed = (field.getAttribute('data-actions') || '').split(',').map((s) => s.trim());
        field.style.display = allowed.includes(action) ? '' : 'none';
      });
    };

    const loadUsers = async () => {
      const result = await window.vmInstaller.listVMUsers(getPayload());
      if (!result?.success) {
        setMessage(result?.error || 'Could not load users.', 'error');
        return;
      }
      renderUsers(result.users || [], result.usersDetailed || []);
      setMessage('OS users loaded.', 'success');
    };

    modal.querySelector('#accClose')?.addEventListener('click', close);
    usersList?.addEventListener('click', async (event) => {
      const button = event.target?.closest?.('.vm-users-delete');
      if (!button || button.disabled) return;
      const username = button.dataset.username;
      const adminReady = await Dashboard._ensureAdminForTask('guest user account management');
      if (!adminReady) return;

      const confirmed = window.confirm(`Delete user "${username}" from ${vm.name}? This also removes the home directory.`);
      if (!confirmed) {
        setMessage('Delete action cancelled.');
        return;
      }

      setMessage(`Deleting "${username}"...`);
      const result = await window.vmInstaller.deleteVMUser({ ...getPayload(), username });
      if (!result?.success) {
        setMessage(result?.error || 'Delete failed.', 'error');
        return;
      }

      setMessage(`User "${username}" deleted successfully.`, 'success');
      await loadUsers();
      this._notify('Account operation completed', 'success');
    });
    actionSelect?.addEventListener('change', updateActionForm);
    refreshBtn?.addEventListener('click', async () => {
      const adminReady = await Dashboard._ensureAdminForTask('guest user account management');
      if (!adminReady) return;
      setMessage('Refreshing users...');
      await loadUsers();
    });

    runBtn?.addEventListener('click', async () => {
      const adminReady = await Dashboard._ensureAdminForTask('guest user account management');
      if (!adminReady) return;

      const action = actionSelect?.value || 'list';
      const base = getPayload();
      const username = modal.querySelector('#accTargetUser')?.value?.trim();
      const password = modal.querySelector('#accPassword')?.value ?? '';
      const requiresUser = action === 'create' || action === 'update' || action === 'delete' || action === 'autologin';
      if (requiresUser && !username) {
        setMessage('Target username is required for this action.', 'error');
        return;
      }
      if (action === 'delete' && isProtectedDeleteTarget(username)) {
        setMessage('Root and current admin user cannot be deleted from this panel.', 'error');
        return;
      }
      if (action === 'create' && !password) {
        setMessage('Password is required when creating a user.', 'error');
        return;
      }

      setMessage('Running operation...');

      let result;
      if (action === 'list') {
        result = await window.vmInstaller.listVMUsers(base);
        if (result?.success) {
          renderUsers(result.users || [], result.usersDetailed || []);
          setMessage('OS users loaded.', 'success');
        }
      } else if (action === 'create') {
        result = await window.vmInstaller.createVMUser({ ...base, username, password });
      } else if (action === 'update') {
        const oldUsername = username;
        const newUsername = modal.querySelector('#accNewUser')?.value?.trim() || oldUsername;
        result = await window.vmInstaller.updateVMUser({ ...base, oldUsername, newUsername, newPassword: password });
      } else if (action === 'delete') {
        result = await window.vmInstaller.deleteVMUser({ ...base, username });
      } else if (action === 'autologin') {
        result = await window.vmInstaller.setVMAutoLogin({ ...base, username });
      }

      if (!result?.success) {
        setMessage(result?.error || 'Operation failed.', 'error');
        return;
      }

      if (action !== 'list') {
        setMessage('Operation completed successfully.', 'success');
        await loadUsers();
      }
      this._notify('Account operation completed', 'success');
    });

    updateActionForm();
    const canPrefetch = await window.vmInstaller.isAdmin().catch(() => false);
    const vmIsRunning = vmStateLabel === 'running';
    if (canPrefetch && vmIsRunning) {
      setMessage('Loading users...');
      await loadUsers();
    } else if (!vmIsRunning) {
      setMessage(`Start this V Os first to manage accounts (current state: ${vmStateLabel}).`, 'error');
    } else {
      setMessage('Ready. Use Continue with Admin Privilege to load or manage accounts.');
    }
  },

  _openModal({ title, body, footer }) {
    const overlay = document.getElementById('vmModalOverlay');
    const modal = document.getElementById('vmSettingsModal');
    if (!overlay || !modal) return { close: () => {}, modal: null };
    const safeTitle = Dashboard._escapeHtml(title);

    modal.innerHTML = `
      <div class="vm-modal-header">
        <h3 class="vm-modal-title">${safeTitle}</h3>
        <button class="btn btn-sm btn-ghost" id="vmGenericClose">Close</button>
      </div>
      <div class="vm-modal-body">${body}</div>
      <div class="vm-modal-footer">${footer}</div>
    `;

    overlay.style.display = 'block';
    modal.style.display = 'block';
    this._modalActive = true;

    const escHandler = (e) => {
      if (e.key === 'Escape') close();
    };

    const close = () => {
      overlay.style.display = 'none';
      modal.style.display = 'none';
      modal.innerHTML = '';
      overlay.onclick = null;
      document.removeEventListener('keydown', escHandler);
      this._modalActive = false;

      if (document.getElementById('navMachines')?.classList.contains('active') && this._liveSyncApp) {
        Dashboard.loadVMs(this._liveSyncApp, { silent: true });
      }
    };

    modal.querySelector('#vmGenericClose')?.addEventListener('click', close);
    overlay.onclick = close;
    document.addEventListener('keydown', escHandler);

    return { close, modal };
  },

  _notify(message, type = 'info') {
    if (!Dashboard._shouldNotify(type)) return;
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
    const iconEl = document.createElement('span');
    iconEl.innerHTML = icon;
    const textEl = document.createElement('span');
    textEl.textContent = message;
    toast.appendChild(iconEl);
    toast.appendChild(textEl);
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
