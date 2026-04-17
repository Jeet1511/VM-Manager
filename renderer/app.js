/**
 * renderer/app.js — VM Manager Controller
 *
 * Multi-view desktop controller with real routes:
 * Dashboard, Machines, Create VM, OS Library, Settings.
 */

// ─── Application State ────────────────────────────────────────────────
const appState = {
  currentView: 'dashboard',
  currentStep: 0,
  totalSteps: 5,
  defaults: {},
  systemReport: null,

  // User selections (populated from wizard)
  vmName: '',
  installPath: '',
  ram: 4096,
  cpus: 2,
  disk: 25600,
  osName: '',
  ubuntuVersion: '',
  isoSource: 'official',
  customIsoPath: '',
  network: 'nat',
  clipboardMode: 'bidirectional',
  dragAndDrop: 'bidirectional',
  sharedFolderPath: '',
  username: 'user',
  password: 'password',

  // Setup state
  isRunning: false,
  cancelRequested: false,
  phases: [],

  // Catalog refresh telemetry
  catalogRefreshMeta: null,

  // Resume state
  resumeInfo: null
};

// Step definitions in order
const STEPS = [
  WizardSteps.chooseOs,
  WizardSteps.fetchIso,
  WizardSteps.setupConfig,
  WizardSteps.advanced,
  WizardSteps.review
];

function _setActiveNav(view) {
  const map = {
    dashboard: 'navDashboard',
    machines: 'navMachines',
    wizard: 'navCreate',
    library: 'navLibrary',
    settings: 'navSettings'
  };

  ['navDashboard', 'navMachines', 'navCreate', 'navLibrary', 'navSettings'].forEach((id) => {
    document.getElementById(id)?.classList.remove('active');
  });

  const activeId = map[view];
  if (activeId) {
    document.getElementById(activeId)?.classList.add('active');
  }
}

function _notify(message, type = 'info') {
  if (typeof Dashboard !== 'undefined' && Dashboard._notify) {
    Dashboard._notify(message, type);
    return;
  }
  window.alert(message);
}

function _loadUiPrefs() {
  try {
    const raw = localStorage.getItem('vmManager.uiPrefs');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function _saveUiPrefs(prefs) {
  localStorage.setItem('vmManager.uiPrefs', JSON.stringify(prefs));
}

function _loadCatalogRefreshMeta() {
  try {
    const raw = localStorage.getItem('vmManager.catalogRefreshMeta');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function _saveCatalogRefreshMeta(meta) {
  localStorage.setItem('vmManager.catalogRefreshMeta', JSON.stringify(meta));
}

function _renderOverview() {
  return `
    <div class="dashboard">
      <div class="dashboard-header">
        <div class="dashboard-title-group">
          <h2 class="dashboard-title">Overview</h2>
          <span class="dashboard-subtitle">Environment health and quick actions</span>
        </div>
      </div>

      <div class="vm-grid" id="overviewStats">
        <div class="vm-card"><div class="vm-card-name">Total VMs</div><div class="dashboard-title" id="ovTotal">-</div></div>
        <div class="vm-card"><div class="vm-card-name">Running</div><div class="dashboard-title" id="ovRunning">-</div></div>
        <div class="vm-card"><div class="vm-card-name">Powered Off</div><div class="dashboard-title" id="ovStopped">-</div></div>
      </div>

      <div class="vm-card" style="margin-top: 24px;">
        <div class="vm-card-header">
          <div class="vm-card-title-group">
            <div class="vm-card-name">Quick Actions</div>
            <div class="vm-card-os">Navigate directly to your workflows</div>
          </div>
        </div>
        <div class="vm-card-controls">
          <button class="btn btn-secondary" id="ovGoMachines">Open Machines</button>
          <button class="btn btn-primary" id="ovGoCreate">Create VM</button>
          <button class="btn" id="ovGoLibrary">Open OS Library</button>
        </div>
      </div>
    </div>
  `;
}

async function _initOverview() {
  const result = await window.vmInstaller.listVMs();
  if (!result.success) {
    document.getElementById('ovTotal').textContent = 'Error';
    document.getElementById('ovRunning').textContent = '-';
    document.getElementById('ovStopped').textContent = '-';
  } else {
    const list = result.vms || [];
    const running = list.filter((vm) => vm.state === 'running').length;
    const stopped = list.length - running;
    document.getElementById('ovTotal').textContent = String(list.length);
    document.getElementById('ovRunning').textContent = String(running);
    document.getElementById('ovStopped').textContent = String(stopped);
  }

  document.getElementById('ovGoMachines')?.addEventListener('click', () => app.showMachines());
  document.getElementById('ovGoCreate')?.addEventListener('click', () => app.showWizard());
  document.getElementById('ovGoLibrary')?.addEventListener('click', () => app.showLibrary());
}

function _renderLibrary(state) {
  const osCatalog = state.defaults?.osCatalog || {};
  const totalCount = Object.keys(osCatalog).length;

  const categoryCount = Object.values(osCatalog).reduce((acc, info) => {
    const key = info.category || 'Other';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const categorySummary = Object.entries(categoryCount)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}: ${count}`)
    .join(' · ');

  const refreshMeta = state.catalogRefreshMeta;
  const refreshPanel = refreshMeta
    ? `
      <div class="vm-card" style="margin-bottom: 16px;">
        <div class="vm-card-header">
          <div class="vm-card-title-group">
            <div class="vm-card-name">Official Refresh Status</div>
            <div class="vm-card-os">Last refresh: ${new Date(refreshMeta.timestamp).toLocaleString()} · Added: ${refreshMeta.totalAdded || 0}</div>
          </div>
        </div>
        <div class="vm-card-specs" style="grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));">
          ${Object.entries(refreshMeta.summary || {}).map(([source, stats]) => {
            const hasError = !!stats?.error;
            const color = hasError ? 'var(--danger)' : 'var(--text-secondary)';
            const title = source.charAt(0).toUpperCase() + source.slice(1);
            return `
              <div class="vm-spec" style="align-items:flex-start;">
                <span style="font-weight:600; color: var(--text);">${title}</span>
                <span style="color:${color}; font-size:12px; margin-top:4px; display:block;">
                  ${hasError
                    ? `Error: ${stats.error}`
                    : `Found ${stats?.found || 0} · Added ${stats?.added || 0}`}
                </span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `
    : '';

  const rows = Object.entries(osCatalog).map(([name, info], index) => {
    const hasDownload = !!info.downloadUrl;
    const active = state.osName === name;
    return `
      <div class="vm-card" style="border-left: 3px solid ${active ? 'var(--primary)' : 'var(--border)'};" data-os-index="${index}">
        <div class="vm-card-header">
          <div class="vm-card-title-group">
            <div class="vm-card-name">${name}</div>
            <div class="vm-card-os">${info.category} · ${info.osType}</div>
          </div>
          <div class="vm-card-state"><span class="state-text">${info.unattended ? 'Unattended Ready' : 'Manual Install'}</span></div>
        </div>
        <div class="vm-detail-row"><span class="vm-detail-label">Recommended</span><span class="vm-detail-value">RAM ${info.ram} MB · CPU ${info.cpus} · Disk ${Math.floor((info.disk || 0) / 1024)} GB</span></div>
        <div class="vm-detail-row"><span class="vm-detail-label">Notes</span><span class="vm-detail-value">${info.notes || 'No notes'}</span></div>
        <div class="vm-card-controls">
          <button class="btn btn-secondary" data-action="select-os" data-os-name="${name}">Use In Wizard</button>
          ${hasDownload ? `<button class="btn" data-action="open-download" data-download-url="${info.downloadUrl}">Open Download</button>` : `<button class="btn" disabled>No Direct Download</button>`}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="dashboard">
      <div class="dashboard-header">
        <div class="dashboard-title-group">
          <h2 class="dashboard-title">OS Library</h2>
          <span class="dashboard-subtitle">Official catalog and download sources · ${totalCount} versions</span>
          <span class="dashboard-subtitle" style="font-size:12px; margin-top:4px;">${categorySummary}</span>
        </div>
        <div class="dashboard-actions">
          <button class="btn btn-secondary" id="btnRefreshCatalog">Refresh Official Versions</button>
        </div>
      </div>
      ${refreshPanel}
      <div class="vm-grid" id="libraryGrid">${rows || '<div class="vm-empty">No OS catalog available.</div>'}</div>
    </div>
  `;
}

function _initLibrary() {
  document.getElementById('btnRefreshCatalog')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnRefreshCatalog');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Refreshing...';
    }

    const refreshed = await window.vmInstaller.refreshOfficialCatalog();

    if (!refreshed?.success) {
      _notify(`Catalog refresh failed: ${refreshed?.error || 'Unknown error'}`, 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Refresh Official Versions';
      }
      return;
    }

    appState.defaults.osCatalog = refreshed.osCatalog || appState.defaults.osCatalog;
    appState.defaults.osCategories = refreshed.osCategories || appState.defaults.osCategories;
    appState.catalogRefreshMeta = {
      timestamp: Date.now(),
      totalAdded: refreshed.totalAdded || 0,
      summary: refreshed.summary || {}
    };
    _saveCatalogRefreshMeta(appState.catalogRefreshMeta);
    _notify(`Official catalog updated. Added ${refreshed.totalAdded || 0} new versions.`, 'success');
    app.showLibrary();
  });

  document.querySelectorAll('[data-action="select-os"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-os-name');
      appState.osName = name;
      _notify(`Selected "${name}" for Create VM.`, 'success');
      app.showLibrary();
    });
  });

  document.querySelectorAll('[data-action="open-download"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const url = btn.getAttribute('data-download-url');
      if (!url) return;
      if (window.vmInstaller.openExternal) {
        await window.vmInstaller.openExternal(url);
      } else {
        window.open(url, '_blank');
      }
    });
  });
}

function _renderSettings() {
  const prefs = _loadUiPrefs();
  const installPath = prefs.installPath || appState.installPath || '';
  const sharedFolderPath = prefs.sharedFolderPath || appState.sharedFolderPath || '';
  const username = prefs.username || appState.username || 'user';
  const password = prefs.password || appState.password || 'password';

  return `
    <div class="dashboard">
      <div class="dashboard-header">
        <div class="dashboard-title-group">
          <h2 class="dashboard-title">Settings</h2>
          <span class="dashboard-subtitle">Default values used by Create VM</span>
        </div>
      </div>

      <div class="vm-card">
        <div class="vm-modal-body" style="padding: 0;">
          <div class="form-group">
            <label class="form-label">Default Install Path</label>
            <div style="display:flex; gap: 10px;">
              <input class="form-input" id="setInstallPath" value="${installPath}" />
              <button class="btn" id="setInstallBrowse">Browse</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Default Shared Folder</label>
            <div style="display:flex; gap: 10px;">
              <input class="form-input" id="setSharedPath" value="${sharedFolderPath}" />
              <button class="btn" id="setSharedBrowse">Browse</button>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Default Username</label>
              <input class="form-input" id="setUser" value="${username}" />
            </div>
            <div class="form-group">
              <label class="form-label">Default Password</label>
              <input class="form-input" id="setPass" value="${password}" />
            </div>
          </div>
        </div>
        <div class="vm-card-controls">
          <button class="btn btn-primary" id="setSave">Save Settings</button>
        </div>
      </div>
    </div>
  `;
}

function _initSettings() {
  document.getElementById('setInstallBrowse')?.addEventListener('click', async () => {
    const selected = await window.vmInstaller.selectFolder('Select default install path', appState.installPath || '');
    if (selected) document.getElementById('setInstallPath').value = selected;
  });

  document.getElementById('setSharedBrowse')?.addEventListener('click', async () => {
    const selected = await window.vmInstaller.selectFolder('Select default shared folder', appState.sharedFolderPath || '');
    if (selected) document.getElementById('setSharedPath').value = selected;
  });

  document.getElementById('setSave')?.addEventListener('click', () => {
    const prefs = {
      installPath: document.getElementById('setInstallPath')?.value?.trim(),
      sharedFolderPath: document.getElementById('setSharedPath')?.value?.trim(),
      username: document.getElementById('setUser')?.value?.trim() || 'user',
      password: document.getElementById('setPass')?.value ?? 'password'
    };

    _saveUiPrefs(prefs);
    appState.installPath = prefs.installPath || appState.installPath;
    appState.sharedFolderPath = prefs.sharedFolderPath || appState.sharedFolderPath;
    appState.username = prefs.username;
    appState.password = prefs.password;

    _notify('Default settings saved.', 'success');
  });
}

// ─── View Routing ──────────────────────────────────────────────────────

const app = {
  showDashboard() {
    appState.currentView = 'dashboard';
    appState.isRunning = false;

    _setActiveNav('dashboard');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = _renderOverview();
    _initOverview();
  },

  showMachines() {
    appState.currentView = 'machines';
    appState.isRunning = false;

    _setActiveNav('machines');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = Dashboard.render(appState);
    Dashboard.init(appState, app);
  },

  showWizard() {
    appState.currentView = 'wizard';
    appState.currentStep = 0;

    _setActiveNav('wizard');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'flex';

    renderStep(0);
  },

  showLibrary() {
    appState.currentView = 'library';
    appState.isRunning = false;

    _setActiveNav('library');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = _renderLibrary(appState);
    _initLibrary();
  },

  showSettings() {
    appState.currentView = 'settings';
    appState.isRunning = false;

    _setActiveNav('settings');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = _renderSettings();
    _initSettings();
  },

  backToDashboard() {
    window.vmInstaller.removeAllListeners();
    app.showDashboard();
  },

  resumeSetup() {
    if (!appState.resumeInfo) return;
    const resumeFrom = appState.resumeInfo.resumeFrom;

    // Use saved config from the previous session
    const savedConfig = appState.resumeInfo.config || {};
    Object.assign(appState, {
      vmName: savedConfig.vmName || appState.vmName,
      installPath: savedConfig.installPath || appState.installPath,
      ram: savedConfig.ram || appState.ram,
      cpus: savedConfig.cpus || appState.cpus,
      disk: savedConfig.disk || appState.disk,
      osName: savedConfig.osName || appState.osName,
      ubuntuVersion: savedConfig.ubuntuVersion || appState.ubuntuVersion,
      network: savedConfig.network || appState.network,
      sharedFolderPath: savedConfig.sharedFolderPath || appState.sharedFolderPath,
      username: savedConfig.username || appState.username,
      password: savedConfig.password || appState.password
    });

    appState.currentStep = 2; // Jump to install step
    startSetupWithResume(resumeFrom);
  },

  async startFresh() {
    await window.vmInstaller.clearSavedState();
    appState.resumeInfo = null;
    renderStep(0);
  },

  startSetup() {
    startSetup();
  }
};

// ─── Wizard Navigation ────────────────────────────────────────────────

function renderStep(stepIndex) {
  if (stepIndex < 0 || stepIndex >= STEPS.length) return;

  appState.currentStep = stepIndex;
  const step = STEPS[stepIndex];
  const container = document.getElementById('wizardContainer');

  // Render the step
  container.innerHTML = step.render(appState);

  // Update step indicators
  updateStepIndicator(stepIndex);

  // Initialize step behavior
  if (step.init) {
    step.init(appState, app);
  }

  const btnNext = document.getElementById('btnNext');
  const btnBack = document.getElementById('btnBack');

  btnNext?.addEventListener('click', () => {
    const activeStep = STEPS[appState.currentStep];
    if (activeStep?.validate) {
      const result = activeStep.validate(appState);
      if (!result.valid) {
        alert(result.message || 'Please complete required fields.');
        return;
      }
    }
    goToStep(appState.currentStep + 1);
  });

  btnBack?.addEventListener('click', () => {
    goToStep(appState.currentStep - 1);
  });
}

function updateStepIndicator(activeIndex) {
  const indicator = document.getElementById('stepIndicator');
  if (!indicator) return;

  const items = indicator.querySelectorAll('.step-item');
  items.forEach((item, i) => {
    item.classList.remove('active', 'completed');
    if (i < activeIndex) item.classList.add('completed');
    if (i === activeIndex) item.classList.add('active');
  });
}

function goToStep(stepIndex) {
  if (appState.isRunning) return; // Can't navigate during setup
  renderStep(stepIndex);
}

// ─── Setup Execution ──────────────────────────────────────────────────

function startSetup() {
  _runSetup(null);
}

function startSetupWithResume(resumeFrom) {
  _runSetup(resumeFrom);
}

async function _runSetup(resumeFrom) {
  appState.isRunning = true;
  appState.cancelRequested = false;
  appState.currentStep = 2;

  // Hide step indicator and nav during setup
  const stepIndicator = document.getElementById('stepIndicator');
  if (stepIndicator) stepIndicator.style.display = 'none';

  // Show progress panel
  const container = document.getElementById('wizardContainer');
  container.innerHTML = ProgressPanel.render({
    vmName: appState.vmName || 'My VM',
    osName: appState.osName,
    ubuntuVersion: appState.ubuntuVersion
  });

  document.getElementById('btnBackToDash')?.addEventListener('click', () => {
    if (!appState.isRunning) app.backToDashboard();
  });

  document.getElementById('btnCancelSetup')?.addEventListener('click', async () => {
    if (!appState.isRunning) return;
    const confirmed = window.confirm('Cancel setup? Current progress will be saved for resume.');
    if (!confirmed) return;

    appState.cancelRequested = true;
    const cancelBtn = document.getElementById('btnCancelSetup');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling...';
    }

    ProgressPanel.updateInstallPhase({ id: 'cancel', label: 'Cancelling', status: 'active', message: 'Cancellation requested. Waiting for current step to stop...' });
    await window.vmInstaller.cancelSetup();
  });

  // Wire event listeners
  window.vmInstaller.onPhase((data) => {
    ProgressPanel.updateInstallPhase(data);
    ProgressPanel.updatePhase(data);
  });

  window.vmInstaller.onProgress((data) => {
    ProgressPanel.updateInstallProgress(data);
    ProgressPanel.updateProgress({ ...data, id: data.id || data.phase });
  });

  window.vmInstaller.onLog((entry) => {
    ProgressPanel.addLog(entry);
  });

  window.vmInstaller.onComplete((data) => {
    showComplete(data);
  });

  window.vmInstaller.onError((data) => {
    showError(data.message || data);
  });

  // Build config
  const config = {
    vmName: appState.vmName || 'My VM',
    installPath: appState.installPath,
    ram: appState.ram,
    cpus: appState.cpus,
    disk: appState.disk,
    osName: appState.osName,
    ubuntuVersion: appState.ubuntuVersion,
    customIsoPath: appState.customIsoPath,
    isoSource: appState.isoSource,
    network: appState.network,
    clipboardMode: appState.clipboardMode,
    dragAndDrop: appState.dragAndDrop,
    sharedFolderPath: appState.sharedFolderPath,
    username: appState.username,
    password: appState.password,
  };

  if (resumeFrom) {
    config._resumeFrom = resumeFrom;
  }

  if (config.isoSource !== 'custom') {
    config.customIsoPath = '';
  }

  const result = await window.vmInstaller.startSetup(config);

  if (result && !result.success && result.error) {
    showError(result.error);
  }
}

// ─── Completion & Error Views ──────────────────────────────────────────

function showComplete(data) {
  ProgressPanel.updateInstallProgress({ percent: 100, message: 'Installation complete.' });
  ProgressPanel.updateInstallPhase({ id: 'complete', label: 'Complete', status: 'complete', message: 'VM ready' });

  const container = document.getElementById('wizardContainer');
  container.innerHTML = ProgressPanel.renderComplete(data);

  document.getElementById('btnBackToDash')?.addEventListener('click', () => {
    app.backToDashboard();
  });

  appState.isRunning = false;
  appState.cancelRequested = false;
  window.vmInstaller.removeAllListeners();
}

function showError(error) {
  const message = typeof error === 'string' ? error : (error?.message || 'Setup failed');
  const cancelled = appState.cancelRequested || /cancel/i.test(message);

  ProgressPanel.updateInstallPhase({ id: 'error', label: 'Installation Failed', status: 'error', message: typeof error === 'string' ? error : 'Setup failed' });

  const container = document.getElementById('wizardContainer');
  container.innerHTML = cancelled
    ? ProgressPanel.renderCancelled(message)
    : ProgressPanel.renderError(error);

  document.getElementById('btnRetry')?.addEventListener('click', () => {
    appState.isRunning = false;
    window.vmInstaller.removeAllListeners();
    app.showWizard();
  });

  document.getElementById('btnBackToDash')?.addEventListener('click', () => {
    app.backToDashboard();
  });

  appState.isRunning = false;
  appState.cancelRequested = false;
  window.vmInstaller.removeAllListeners();
}

// ─── Initialization ────────────────────────────────────────────────────

async function initApp() {
  try {
    // Load defaults from main process
    appState.defaults = await window.vmInstaller.getDefaults();
    appState.installPath = appState.defaults.defaultInstallPath;
    appState.sharedFolderPath = appState.defaults.defaultSharedFolder;
    appState.osName = Object.keys(appState.defaults.osCatalog || {})[0] || '';
    appState.ubuntuVersion = appState.defaults.ubuntuVersions?.[0] || '';

    // Check for resumable previous setup
    try {
      appState.resumeInfo = await window.vmInstaller.checkForResume();
    } catch (err) {
      console.warn('Resume check failed:', err);
      appState.resumeInfo = null;
    }

    const savedPrefs = _loadUiPrefs();
    const savedCatalogMeta = _loadCatalogRefreshMeta();
    appState.installPath = savedPrefs.installPath || appState.installPath;
    appState.sharedFolderPath = savedPrefs.sharedFolderPath || appState.sharedFolderPath;
    appState.username = savedPrefs.username || appState.username;
    appState.password = savedPrefs.password || appState.password;
    appState.catalogRefreshMeta = savedCatalogMeta;

    // Wire nav tabs
    document.getElementById('navDashboard')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showDashboard();
    });

    document.getElementById('navMachines')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showMachines();
    });

    document.getElementById('navCreate')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showWizard();
    });

    document.getElementById('navLibrary')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showLibrary();
    });

    document.getElementById('navSettings')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showSettings();
    });

    document.getElementById('btnTopNewVM')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showWizard();
    });

    // Start at dashboard
    app.showDashboard();
  } catch (err) {
    console.error('Failed to initialize app:', err);
    document.getElementById('wizardContainer').innerHTML = `
      <div class="glass-card">
        <h2 class="step-title" style="color: var(--error)">Initialization Failed</h2>
        <p class="step-description">${err.message}</p>
      </div>
    `;
  }
}

// Start the app when DOM is ready
document.addEventListener('DOMContentLoaded', initApp);
