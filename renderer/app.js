/**
 * renderer/app.js — VM Xposed Controller
 *
 * Multi-view desktop controller with real routes:
 * Dashboard, V Os, Create V Os, OS Library, Settings.
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
  downloadPath: '',
  startupView: 'dashboard',
  network: 'nat',
  clipboardMode: 'bidirectional',
  dragAndDrop: 'bidirectional',
  startFullscreen: true,
  accelerate3d: false,
  enableSharedFolder: false,
  accountType: 'guest',
  sharedFolderPath: '',
  language: 'en',
  notificationLevel: 'important',
  adminModePolicy: 'manual',
  autoRepairLevel: 'safe',
  maxHostRamPercent: 75,
  maxHostCpuPercent: 75,
  vmDefaultPreset: 'balanced',
  credentialStorage: 'keychain',
  telemetryEnabled: false,
  trustedPaths: '',
  logLevel: 'info',
  logRetentionDays: 14,
  defaultUserUsername: 'user',
  defaultUserPassword: 'user',
  guestUsername: 'guest',
  guestPassword: 'guest',
  username: 'guest',
  password: 'guest',

  // Setup state
  isRunning: false,
  cancelRequested: false,
  pauseRequested: false,
  phases: [],
  settingsReturnView: 'dashboard',

  // Catalog refresh telemetry
  catalogRefreshMeta: null,
  updateInfo: null,
  patchHistoryCache: {},

  // Resume state
  resumeInfo: null,

  // Existing VM reuse
  existingVMs: [],
  useExistingVm: false,
  existingVmName: '',
  existingVmFolder: '',
  downloadedVmCandidates: [],
  vboxInstall: {
    downloadFolder: '',
    installerPath: '',
    isInstalling: false,
    isPaused: false,
    canPause: false,
    canCancel: false
  },

  // Premium bootstrap onboarding state
  vmBootstrapFlow: {
    panel: 'empty',
    panelEnter: '',
    launchedFromBootstrap: false,
    selectedOption: 'download',
    selectedVmType: '',
    downloadFolder: '',
    importFolder: '',
    validating: false,
    validationProgress: 0,
    validated: false,
    detectedVmName: '',
    validationError: '',
    invalidField: '',
    inlineError: '',
    statusMessage: ''
  }
};

// Step definitions in order
const STEPS = [
  WizardSteps.chooseOs,
  WizardSteps.fetchIso,
  WizardSteps.setupConfig,
  WizardSteps.advanced,
  WizardSteps.review
];

let startupCatalogRefreshPromise = null;
const RELEASES_PAGE_URL = 'https://github.com/Jeet1511/VM-Manager/tree/main/Installer';
const UPDATE_CHECK_CACHE_TTL_MS = 5 * 60 * 1000;
const UI_PREFS_KEY = 'vmManager.uiPrefs';
const SESSION_CREDENTIALS_KEY = 'vmManager.sessionCredentials';
const TELEMETRY_QUEUE_KEY = 'vmManager.telemetryQueue';
const VM_BOOTSTRAP_PREFS_KEY = 'vmManager.vmBootstrapPrefs';
const VM_BOOTSTRAP_TRANSITION_MS = 240;
const ADMIN_STATUS_TTL_MS = 3000;

let adminStatusCheckPromise = null;
let adminLastStatusAt = 0;
let adminLastIsAdmin = null;
let adminFloatingDismissed = false;
let realtimePanelTimer = null;
let visualEffectsMode = 'lite';

function _clearRealtimePanelTimer() {
  if (realtimePanelTimer) {
    clearInterval(realtimePanelTimer);
    realtimePanelTimer = null;
  }
}

function _setRealtimePanelTimer(callback, intervalMs = 4200) {
  _clearRealtimePanelTimer();
  realtimePanelTimer = setInterval(() => {
    callback();
  }, intervalMs);
}

function _resolveVisualEffectsMode() {
  try {
    const prefs = _loadUiPrefs();
    const configured = String(prefs?.visualEffectsMode || '').trim().toLowerCase();
    if (configured === 'full' || configured === 'lite') {
      return configured;
    }
  } catch {}

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) return 'lite';

  const threadCount = Number(navigator.hardwareConcurrency || 0);
  if (Number.isFinite(threadCount) && threadCount > 0 && threadCount <= 12) {
    return 'lite';
  }

  return 'lite';
}

function _applyVisualEffectsMode(mode = 'lite') {
  visualEffectsMode = mode === 'full' ? 'full' : 'lite';
  document.body.classList.toggle('perf-lite', visualEffectsMode === 'lite');
  document.body.classList.toggle('perf-full', visualEffectsMode === 'full');
}

function _isLiteVisualMode() {
  return visualEffectsMode !== 'full';
}

function _ensureMotionSystemMounted() {
  const requiredLayers = _isLiteVisualMode()
    ? ['bg-gradient']
    : [
      'bg-gradient',
      'bg-grid',
      'bg-flow bg-flow--primary',
      'bg-flow bg-flow--secondary',
      'bg-pulse',
      'bg-scanline',
      'bg-glow'
    ];

  let appBg = document.querySelector('.app-bg');
  if (!appBg) {
    appBg = document.createElement('div');
    appBg.className = 'app-bg';
    document.body.insertBefore(appBg, document.body.firstChild || null);
  }

  appBg.innerHTML = '';
  requiredLayers.forEach((className) => {
    const layer = document.createElement('div');
    layer.className = className;
    appBg.appendChild(layer);
  });

  if (_isLiteVisualMode()) {
    const cursorLight = document.querySelector('.cursor-light');
    if (cursorLight) cursorLight.remove();
    return;
  }

  let cursorLight = document.querySelector('.cursor-light');
  if (!cursorLight) {
    cursorLight = document.createElement('div');
    cursorLight.className = 'cursor-light';
    document.body.insertBefore(cursorLight, appBg.nextSibling);
  }
}

function _validateMotionVisibility() {
  if (_isLiteVisualMode()) {
    document.body.classList.remove('motion-prime', 'motion-debug');
    return;
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const layers = [
    document.querySelector('.bg-gradient'),
    document.querySelector('.bg-grid'),
    document.querySelector('.bg-flow--primary'),
    document.querySelector('.bg-flow--secondary'),
    document.querySelector('.bg-pulse'),
    document.querySelector('.bg-glow')
  ].filter(Boolean);

  if (layers.length < 6) {
    console.warn('Motion system is incomplete. Re-mounting background layers.');
    _ensureMotionSystemMounted();
  }

  const hasAnimatedLayer = layers.some((layer) => {
    const computed = window.getComputedStyle(layer);
    return computed.animationName && computed.animationName !== 'none';
  });

  document.body.classList.remove('motion-prime', 'motion-debug');

  if (reduceMotion) {
    return;
  }

  document.body.classList.add('motion-prime');
  window.setTimeout(() => {
    document.body.classList.remove('motion-prime');
  }, 1800);

  if (!hasAnimatedLayer) {
    console.warn('Motion animations not detected on computed styles.');
  }
}

function _setSystemFlowActivity({ cpuUsage = 0, netMbps = 0, diskMBps = 0 } = {}) {
  if (_isLiteVisualMode()) return;
  const root = document.documentElement;
  if (!root) return;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));

  const cpuLevel = clamp(cpuUsage, 0, 100) / 100;
  const netLevel = clamp(netMbps, 0, 240) / 240;
  const diskLevel = clamp(diskMBps, 0, 320) / 320;

  const primaryOpacity = 0.02 + (cpuLevel * 0.03);
  const secondaryOpacity = 0.015 + (diskLevel * 0.03);
  const gridOpacity = 0.02 + (cpuLevel * 0.012);
  const scanOpacity = 0.015 + (cpuLevel * 0.015);
  const pulseOpacity = netLevel < 0.01 ? 0.004 : Math.min(0.05, 0.008 + (netLevel * 0.04));
  const diskBurstOpacity = 0.008 + (diskLevel * 0.038);

  const primaryDuration = 30 - (cpuLevel * 14);
  const secondaryDuration = 36 - (cpuLevel * 16);
  const scanDuration = 30 - (cpuLevel * 10);
  const diskBurstDuration = 7 - (diskLevel * 3.4);
  const pulseDuration = 16 - (netLevel * 7);

  root.style.setProperty('--motion-grid-opacity', gridOpacity.toFixed(3));
  root.style.setProperty('--motion-flow-primary-opacity', primaryOpacity.toFixed(3));
  root.style.setProperty('--motion-flow-secondary-opacity', secondaryOpacity.toFixed(3));
  root.style.setProperty('--motion-scanline-opacity', scanOpacity.toFixed(3));
  root.style.setProperty('--motion-pulse-opacity', pulseOpacity.toFixed(3));
  root.style.setProperty('--motion-disk-burst-opacity', diskBurstOpacity.toFixed(3));
  root.style.setProperty('--motion-flow-duration-primary', `${Math.max(14, primaryDuration).toFixed(1)}s`);
  root.style.setProperty('--motion-flow-duration-secondary', `${Math.max(16, secondaryDuration).toFixed(1)}s`);
  root.style.setProperty('--motion-scanline-duration', `${Math.max(12, scanDuration).toFixed(1)}s`);
  root.style.setProperty('--motion-disk-burst-duration', `${Math.max(2.4, diskBurstDuration).toFixed(1)}s`);
  root.style.setProperty('--motion-pulse-duration', `${Math.max(6, pulseDuration).toFixed(1)}s`);
}

function _initBrandingAssets() {
  const logoImage = document.querySelector('.sidebar-logo-image');
  const logoFallback = document.querySelector('.sidebar-logo');
  if (!logoImage || !logoFallback) return;

  const candidateSources = [
    '../logos/inside app logo.png',
    '../logos/inside app logo.webp',
    '../logos/inside app logo.jpg',
    '../logos/inside app logo.jpeg',
    '../logos/inside-app-logo.png',
    '../logos/inside-app-logo.webp',
    '../logos/inside-app-logo.jpg',
    '../logos/inside-app-logo.jpeg',
    'assets/vm-xposed-mark.png',
    'assets/vm-xposed-mark.webp',
    'assets/vm-xposed-mark.jpg',
    'assets/vm-xposed-mark.jpeg',
    'assets/vm-xposed-mark.svg',
    'assets/vm-xposed-logo.png',
    'assets/vm-xposed-logo.webp',
    'assets/vm-xposed-logo.jpg',
    'assets/vm-xposed-logo.jpeg',
    'assets/vm-xposed-logo.svg',
    'assets/logo.png',
    'assets/logo.webp',
    'assets/logo.jpg',
    'assets/logo.jpeg',
    'assets/icon.png',
    'assets/icon.webp',
    'assets/icon.jpg',
    'assets/icon.jpeg'
  ];

  const showImage = () => {
    logoImage.style.display = 'inline-flex';
    logoFallback.style.display = 'none';
  };

  const showFallback = () => {
    logoImage.style.display = 'none';
    logoFallback.style.display = 'inline-flex';
  };

  const tryNextSource = (index = 0) => {
    if (index >= candidateSources.length) {
      showFallback();
      return;
    }
    logoImage.src = candidateSources[index];
  };

  logoImage.addEventListener('load', () => {
    showImage();
  });

  logoImage.addEventListener('error', () => {
    const currentIndex = candidateSources.indexOf(logoImage.getAttribute('src') || '');
    tryNextSource(currentIndex + 1);
  });

  if (logoImage.complete) {
    if (logoImage.naturalWidth > 0) {
      showImage();
    } else {
      showFallback();
    }
  }

  tryNextSource(0);
}

function _setActiveNav(view) {
  const map = {
    dashboard: 'navDashboard',
    machines: 'navMachines',
    wizard: 'navCreate',
    library: 'navLibrary',
    snapshots: 'navSnapshots',
    storage: 'navStorage',
    network: 'navNetwork',
    download: 'navDownload',
    settings: 'navSettings',
    credits: 'navCredits'
  };

  ['navDashboard', 'navMachines', 'navCreate', 'navLibrary', 'navSnapshots', 'navStorage', 'navNetwork', 'navDownload', 'navSettings', 'navCredits'].forEach((id) => {
    document.getElementById(id)?.classList.remove('active');
  });

  const activeId = map[view];
  if (activeId) {
    document.getElementById(activeId)?.classList.add('active');
  }
  _refreshAdminFloatingCta();
}

function _setPrimaryCta(view) {
  const btnNew = document.getElementById('btnTopNewVM');
  const btnImport = document.getElementById('btnTopImportVM');
  if (!btnNew && !btnImport) return;

  const hideOn = view === 'wizard' || view === 'settings' || view === 'download' || view === 'credits' || view === 'vbox-install' || view === 'vm-bootstrap';
  if (btnNew) {
    btnNew.style.display = hideOn ? 'none' : 'inline-flex';
    btnNew.innerHTML = `${Icons.plus} New V Os`;
  }
  if (btnImport) {
    btnImport.style.display = hideOn ? 'none' : 'inline-flex';
  }
}

function _openImportWizard() {
  appState.useExistingVm = true;
  appState.vmBootstrapFlow.selectedOption = 'import';
  app.showWizard({ startStep: 4 });
}

function _ensureAdminFloatingCtaMounted() {
  let host = document.getElementById('adminFloatingCta');
  if (host) return host;

  host = document.createElement('aside');
  host.id = 'adminFloatingCta';
  host.className = 'admin-floating-cta';
  host.style.display = 'none';
  host.innerHTML = `
    <div class="admin-floating-head">
      <div class="admin-floating-kicker">Admin Access</div>
      <button class="admin-floating-close" id="btnAdminFloatingClose" type="button" aria-label="Close admin popup">${Icons.sized(Icons.xCircle, 14)}</button>
    </div>
    <div class="admin-floating-title">Continue with Admin Privilege</div>
    <div class="admin-floating-desc" id="adminFloatingDesc">Use VM Xposed on full power with elevated permissions.</div>
    <button class="admin-floating-btn" id="btnAdminFloatingContinue" type="button">${Icons.sized(Icons.shieldCheck, 14)} Continue</button>
  `;
  document.body.appendChild(host);

  host.querySelector('#btnAdminFloatingClose')?.addEventListener('click', () => {
    adminFloatingDismissed = true;
    host.style.display = 'none';
  });

  host.querySelector('#btnAdminFloatingContinue')?.addEventListener('click', async () => {
    const btn = host.querySelector('#btnAdminFloatingContinue');
    const desc = host.querySelector('#adminFloatingDesc');
    if (!btn) return;

    btn.disabled = true;
    btn.innerHTML = `${Icons.sized(Icons.spinner, 14)} Continuing...`;
    try {
      const result = await window.vmInstaller.restartAsAdmin();
      if (!result?.success) {
        btn.disabled = false;
        btn.innerHTML = `${Icons.sized(Icons.shieldCheck, 14)} Continue`;
        _notify(result?.error || 'Could not restart in administrator mode.', 'error');
        return;
      }
      if (result?.restarting !== true) {
        host.style.display = 'none';
        await _refreshAdminFloatingCta({ force: true });
        _notify(result?.message || 'Already running with administrator privileges.', 'success');
        return;
      }
      host.classList.add('is-restarting');
      if (desc) desc.textContent = 'Relaunch request sent. Approve the UAC prompt to continue.';
      window.setTimeout(async () => {
        try {
          const elevated = await window.vmInstaller.isAdmin();
          if (!elevated) {
            host.classList.remove('is-restarting');
            btn.disabled = false;
            btn.innerHTML = `${Icons.sized(Icons.shieldCheck, 14)} Continue`;
            if (desc) desc.textContent = 'Admin relaunch did not complete. Approve UAC and try again.';
            _notify('Could not restart in administrator mode. Please approve the UAC prompt and try again.', 'error');
          }
        } catch {}
      }, 14000);
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = `${Icons.sized(Icons.shieldCheck, 14)} Continue`;
      _notify(err?.message || 'Could not restart in administrator mode.', 'error');
    }
  });

  return host;
}

function _setAdminFloatingCtaVisible(visible, options = {}) {
  const host = _ensureAdminFloatingCtaMounted();
  const force = !!options.force;
  if (visible && adminFloatingDismissed && !force) {
    host.style.display = 'none';
    return;
  }
  if (visible && force) {
    adminFloatingDismissed = false;
  }
  host.style.display = visible ? 'flex' : 'none';
}

function _focusAdminFloatingCta(reason = '') {
  const host = _ensureAdminFloatingCtaMounted();
  const desc = host.querySelector('#adminFloatingDesc');
  if (desc) {
    desc.textContent = reason
      ? `${reason} Continue with Admin Privilege to unlock full app power.`
      : 'Use VM Xposed on full power with elevated permissions.';
  }
  host.classList.remove('is-highlight');
  void host.offsetWidth;
  host.classList.add('is-highlight');
  _setAdminFloatingCtaVisible(true, { force: true });
}

async function _refreshAdminFloatingCta(options = {}) {
  const force = !!options.force;
  const fallback = true;

  if (!window.vmInstaller?.isAdmin) {
    _setAdminFloatingCtaVisible(false);
    return fallback;
  }

  const now = Date.now();
  if (!force && adminLastIsAdmin !== null && now - adminLastStatusAt < ADMIN_STATUS_TTL_MS) {
    _setAdminFloatingCtaVisible(!adminLastIsAdmin, { force });
    return adminLastIsAdmin;
  }

  if (adminStatusCheckPromise) return adminStatusCheckPromise;

  adminStatusCheckPromise = Promise.resolve(window.vmInstaller.isAdmin())
    .then((isAdmin) => {
      adminLastIsAdmin = !!isAdmin;
      adminLastStatusAt = Date.now();
      _setAdminFloatingCtaVisible(!adminLastIsAdmin, { force });
      return adminLastIsAdmin;
    })
    .catch(() => {
      _setAdminFloatingCtaVisible(false);
      return fallback;
    })
    .finally(() => {
      adminStatusCheckPromise = null;
    });

  return adminStatusCheckPromise;
}

function _notify(message, type = 'info') {
  if (!_shouldShowNotification(type)) return;
  if (typeof Dashboard !== 'undefined' && Dashboard._notify) {
    Dashboard._notify(message, type);
    return;
  }
  window.alert(message);
}

function _escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _readSessionCredentials() {
  try {
    const raw = sessionStorage.getItem(SESSION_CREDENTIALS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

function _writeSessionCredentials(credentials = {}) {
  try {
    sessionStorage.setItem(SESSION_CREDENTIALS_KEY, JSON.stringify({
      defaultUserPassword: String(credentials.defaultUserPassword ?? ''),
      guestPassword: String(credentials.guestPassword ?? '')
    }));
  } catch {}
}

function _clearSessionCredentials() {
  try {
    sessionStorage.removeItem(SESSION_CREDENTIALS_KEY);
  } catch {}
}

function _normalizeUiPrefs(rawPrefs = {}, options = {}) {
  const source = (rawPrefs && typeof rawPrefs === 'object') ? rawPrefs : {};
  const forPersistence = options.forPersistence === true;
  const normalizeEnum = (value, allowed, fallback) => {
    const normalized = String(value ?? '').trim().toLowerCase();
    return allowed.includes(normalized) ? normalized : fallback;
  };
  const clampInt = (value, min, max, fallback) => {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  };
  const sanitizeText = (value, fallback = '') => {
    if (value === undefined || value === null) return fallback;
    return String(value).trim();
  };

  const normalized = { ...source, theme: 'dark' };
  normalized.visualEffectsMode = normalizeEnum(normalized.visualEffectsMode, ['lite', 'full'], 'lite');
  normalized.language = normalizeEnum(normalized.language, ['en', 'hi'], 'en');
  normalized.startupView = normalizeEnum(
    normalized.startupView,
    ['dashboard', 'machines', 'wizard', 'library', 'snapshots', 'storage', 'network', 'settings', 'download', 'credits'],
    'dashboard'
  );
  normalized.notificationLevel = normalizeEnum(normalized.notificationLevel, ['all', 'important', 'minimal'], 'important');
  normalized.adminModePolicy = normalizeEnum(normalized.adminModePolicy, ['auto', 'manual'], 'manual');
  normalized.autoRepairLevel = normalizeEnum(normalized.autoRepairLevel, ['none', 'safe', 'full'], 'safe');
  normalized.maxHostRamPercent = clampInt(normalized.maxHostRamPercent, 40, 95, 75);
  normalized.maxHostCpuPercent = clampInt(normalized.maxHostCpuPercent, 40, 95, 75);
  normalized.vmDefaultPreset = normalizeEnum(normalized.vmDefaultPreset, ['beginner', 'balanced', 'advanced'], 'balanced');
  normalized.credentialStorage = normalizeEnum(normalized.credentialStorage, ['keychain', 'session'], 'keychain');
  normalized.telemetryEnabled = normalized.telemetryEnabled === true;
  normalized.logLevel = normalizeEnum(normalized.logLevel, ['error', 'warning', 'info', 'debug'], 'info');
  normalized.logRetentionDays = clampInt(normalized.logRetentionDays, 1, 365, 14);
  normalized.trustedPaths = String(normalized.trustedPaths || '').trim();
  normalized.defaultUserUsername = sanitizeText(normalized.defaultUserUsername, 'user') || 'user';
  normalized.guestUsername = sanitizeText(normalized.guestUsername || normalized.username, 'guest') || 'guest';

  let defaultUserPassword = String(normalized.defaultUserPassword ?? 'user');
  let guestPassword = String(normalized.guestPassword ?? normalized.password ?? 'guest');
  if (normalized.credentialStorage === 'session') {
    const sessionCredentials = _readSessionCredentials();
    defaultUserPassword = String(sessionCredentials.defaultUserPassword ?? defaultUserPassword ?? '');
    guestPassword = String(sessionCredentials.guestPassword ?? guestPassword ?? '');
  }
  if (forPersistence && normalized.credentialStorage === 'session') {
    defaultUserPassword = '';
    guestPassword = '';
  }

  normalized.defaultUserPassword = defaultUserPassword;
  normalized.guestPassword = guestPassword;
  normalized.username = normalized.guestUsername;
  normalized.password = normalized.guestPassword;
  return normalized;
}

function _loadUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return _normalizeUiPrefs(parsed);
  } catch {
    return _normalizeUiPrefs({});
  }
}

function _saveUiPrefs(prefs) {
  const normalizedRuntime = _normalizeUiPrefs(prefs || {});
  if (normalizedRuntime.credentialStorage === 'session') {
    _writeSessionCredentials({
      defaultUserPassword: normalizedRuntime.defaultUserPassword,
      guestPassword: normalizedRuntime.guestPassword
    });
  } else {
    _clearSessionCredentials();
  }
  const normalizedPersisted = _normalizeUiPrefs(normalizedRuntime, { forPersistence: true });
  localStorage.setItem(UI_PREFS_KEY, JSON.stringify(normalizedPersisted));
  return normalizedRuntime;
}

function _normalizeVersionText(version) {
  return String(version || '').trim().replace(/^v/i, '');
}

function _getCurrentLocale() {
  const language = String(appState.language || _loadUiPrefs().language || 'en').toLowerCase();
  return language === 'hi' ? 'hi-IN' : 'en-US';
}

function _formatLocalizedTime(value) {
  const stamp = new Date(value || Date.now());
  if (Number.isNaN(stamp.getTime())) return String(value || '');
  return stamp.toLocaleTimeString(_getCurrentLocale());
}

function _formatLocalizedDateTime(value) {
  const stamp = new Date(value || Date.now());
  if (Number.isNaN(stamp.getTime())) return String(value || '');
  return stamp.toLocaleString(_getCurrentLocale());
}

function _applyLanguagePreference(language = 'en') {
  const normalized = String(language || 'en').toLowerCase() === 'hi' ? 'hi' : 'en';
  appState.language = normalized;
  document.documentElement.lang = normalized;
  document.documentElement.setAttribute('data-ui-language', normalized);
}

function _shouldShowNotification(type = 'info') {
  const level = String(appState.notificationLevel || _loadUiPrefs().notificationLevel || 'important').toLowerCase();
  const normalizedType = String(type || 'info').toLowerCase();
  if (normalizedType === 'error') return true;
  if (level === 'all') return true;
  if (level === 'minimal') return false;
  return normalizedType !== 'info';
}

function _parseTrustedPaths(rawValue = '') {
  return String(rawValue || '')
    .split(/[;\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function _mergeTrustedPaths(existingRaw = '', additions = []) {
  const merged = [];
  const seen = new Set();
  const pushUnique = (value) => {
    const item = String(value || '').trim();
    if (!item) return;
    const key = _normalizePathForTrust(item);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  };
  _parseTrustedPaths(existingRaw).forEach(pushUnique);
  (Array.isArray(additions) ? additions : []).forEach(pushUnique);
  return merged.join('; ');
}

function _normalizePathForTrust(pathValue = '') {
  const raw = String(pathValue || '').trim().replace(/\//g, '\\');
  const isUnc = raw.startsWith('\\\\');
  const collapsed = raw.replace(/[\\]+/g, '\\');
  const normalized = isUnc ? `\\\\${collapsed.replace(/^\\+/, '')}` : collapsed;
  if (!normalized) return '';
  const dequoted = normalized.replace(/^"+|"+$/g, '');
  const withoutTrailing = /^[a-z]:\\$/i.test(dequoted) ? dequoted : dequoted.replace(/[\\]+$/, '');
  return withoutTrailing.toLowerCase();
}

function _isPathTrustedByPolicy(pathValue = '', trustedPathsRaw = '') {
  const candidate = _normalizePathForTrust(pathValue);
  if (!candidate) return true;
  const trusted = _parseTrustedPaths(trustedPathsRaw)
    .map(_normalizePathForTrust)
    .filter(Boolean);
  if (trusted.length === 0) return true;
  return trusted.some((root) => candidate === root || candidate.startsWith(`${root}\\`));
}

function _deriveResourcePolicyCaps(state = appState) {
  const ramCapPercent = Math.max(40, Math.min(95, parseInt(state.maxHostRamPercent, 10) || 75));
  const cpuCapPercent = Math.max(40, Math.min(95, parseInt(state.maxHostCpuPercent, 10) || 75));
  const hostRamGb = Number(state.systemReport?.systemInfo?.totalRAM || 0);
  const hostCpuCount = Number(state.systemReport?.systemInfo?.cpuCount || navigator.hardwareConcurrency || 0);
  const maxRamMb = hostRamGb > 0
    ? Math.max(1024, Math.floor((hostRamGb * 1024 * ramCapPercent) / 100))
    : 16384;
  const maxCpus = hostCpuCount > 0
    ? Math.max(1, Math.floor((hostCpuCount * cpuCapPercent) / 100))
    : 16;
  return { maxRamMb, maxCpus, ramCapPercent, cpuCapPercent };
}

function _clampSetupResourcesToPolicy(state = appState) {
  const caps = _deriveResourcePolicyCaps(state);
  state.ram = Math.max(1024, Math.min(parseInt(state.ram, 10) || 4096, caps.maxRamMb));
  state.cpus = Math.max(1, Math.min(parseInt(state.cpus, 10) || 2, caps.maxCpus));
  state._resourcePolicyCaps = caps;
  return caps;
}

function _applyVmPresetDefaults(state = appState) {
  const preset = String(state.vmDefaultPreset || 'balanced').toLowerCase();
  const presets = {
    beginner: { ram: 3072, cpus: 1, disk: 30720 },
    balanced: { ram: 4096, cpus: 2, disk: 51200 },
    advanced: { ram: 8192, cpus: 4, disk: 102400 }
  };
  const selected = presets[preset] || presets.balanced;
  state.ram = selected.ram;
  state.cpus = selected.cpus;
  state.disk = selected.disk;
  _clampSetupResourcesToPolicy(state);
}

function _trackTelemetry(eventName, payload = {}) {
  if (!appState.telemetryEnabled) return;
  try {
    const raw = localStorage.getItem(TELEMETRY_QUEUE_KEY);
    const queue = raw ? JSON.parse(raw) : [];
    const events = Array.isArray(queue) ? queue : [];
    events.push({
      event: String(eventName || 'unknown'),
      payload: payload && typeof payload === 'object' ? payload : {},
      at: new Date().toISOString()
    });
    localStorage.setItem(TELEMETRY_QUEUE_KEY, JSON.stringify(events.slice(-120)));
  } catch {}
}

async function _persistUiPrefsPatch(patch = {}) {
  const merged = { ..._loadUiPrefs(), ...patch };
  const normalized = _saveUiPrefs(merged);
  const result = await window.vmInstaller.saveUiPrefs(normalized);
  if (!result?.success) {
    throw new Error(result?.error || 'Could not save preferences.');
  }
  return normalized;
}

async function _checkForAppUpdates({
  force = false,
  notifyOnUpdate = false,
  notifyOnNoUpdate = false,
  notifyOnError = false
} = {}) {
  const cached = appState.updateInfo;
  if (!force && cached?.checkedAt) {
    const checkedAtMs = Date.parse(cached.checkedAt);
    if (Number.isFinite(checkedAtMs) && (Date.now() - checkedAtMs) < UPDATE_CHECK_CACHE_TTL_MS) {
      _updateNavBadge(cached);
      return cached;
    }
  }

  try {
    const result = await window.vmInstaller.checkForUpdates();
    if (!result?.success) {
      if (notifyOnError) _notify(result?.error || 'Update check failed.', 'error');
      return result;
    }

    const prefs = _loadUiPrefs();
    const ignoredVersion = _normalizeVersionText(prefs.ignoredUpdateVersion || '');
    const latestVersion = _normalizeVersionText(result.latestVersion || '');
    const isIgnored = !!latestVersion && ignoredVersion === latestVersion;
    const updateInfo = {
      ...result,
      currentVersion: _normalizeVersionText(result.currentVersion || ''),
      latestVersion,
      ignoredVersion,
      isIgnored,
      checkedAt: new Date().toISOString()
    };
    appState.updateInfo = updateInfo;
    _trackTelemetry('update_checked', {
      hasUpdate: !!updateInfo.hasUpdate,
      latestVersion: updateInfo.latestVersion || ''
    });

    // Show/hide the red dot badge on Updates nav button
    _updateNavBadge(updateInfo);

    if (notifyOnUpdate && result.hasUpdate && !isIgnored) {
      _notify(`Update available: v${updateInfo.latestVersion}. Open Updates section to install.`, 'info');
    } else if (notifyOnNoUpdate && !result.hasUpdate) {
      _notify('VM Xposed is up to date.', 'success');
    }

    return updateInfo;
  } catch (err) {
    if (notifyOnError) _notify(`Update check failed: ${err?.message || 'Unknown error'}`, 'error');
    return { success: false, error: err?.message || 'Update check failed.' };
  }
}

function _updateNavBadge(updateInfo) {
  const dot = document.getElementById('navUpdateDot');
  if (!dot) return;
  const showDot = updateInfo?.hasUpdate && !updateInfo?.isIgnored;
  dot.style.display = showDot ? 'inline-block' : 'none';
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

function _loadVmBootstrapPrefs() {
  try {
    const raw = localStorage.getItem(VM_BOOTSTRAP_PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function _saveVmBootstrapPrefs(prefs) {
  localStorage.setItem(VM_BOOTSTRAP_PREFS_KEY, JSON.stringify(prefs || {}));
}

function _withTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function _loadSessionState() {
  try {
    const raw = localStorage.getItem('vmManager.sessionState');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function _saveSessionState(state) {
  try {
    localStorage.setItem('vmManager.sessionState', JSON.stringify(state || {}));
  } catch {}
}

function _captureSessionState(state) {
  return {
    lastView: state.currentView || 'dashboard',
    currentStep: Number.isFinite(Number(state.currentStep)) ? Number(state.currentStep) : 0,
    vmName: state.vmName || '',
    installPath: state.installPath || '',
    ram: state.ram,
    cpus: state.cpus,
    disk: state.disk,
    osName: state.osName || '',
    ubuntuVersion: state.ubuntuVersion || '',
    isoSource: state.isoSource || 'official',
    customIsoPath: state.customIsoPath || '',
    downloadPath: state.downloadPath || '',
    network: state.network || 'nat',
    clipboardMode: state.clipboardMode || 'bidirectional',
    dragAndDrop: state.dragAndDrop || 'bidirectional',
    startFullscreen: state.startFullscreen !== false,
    accelerate3d: state.accelerate3d === true,
    enableSharedFolder: !!state.enableSharedFolder,
    accountType: state.accountType || 'guest',
    sharedFolderPath: state.sharedFolderPath || '',
    username: state.username || 'guest',
    password: state.password || 'guest',
    useExistingVm: !!state.useExistingVm,
    existingVmName: state.existingVmName || '',
    existingVmFolder: state.existingVmFolder || ''
  };
}

function _applySessionState(targetState, sessionState) {
  if (!sessionState || typeof sessionState !== 'object') return;

  const keys = [
    'currentStep',
    'vmName',
    'installPath',
    'ram',
    'cpus',
    'disk',
    'osName',
    'ubuntuVersion',
    'isoSource',
    'customIsoPath',
    'downloadPath',
    'network',
    'clipboardMode',
    'dragAndDrop',
    'startFullscreen',
    'accelerate3d',
    'enableSharedFolder',
    'accountType',
    'sharedFolderPath',
    'username',
    'password',
    'useExistingVm',
    'existingVmName',
    'existingVmFolder'
  ];

  keys.forEach((key) => {
    if (sessionState[key] !== undefined) {
      targetState[key] = sessionState[key];
    }
  });

  if (sessionState.lastView) {
    targetState.currentView = sessionState.lastView;
  }
}

function _setSidebarNavigationDisabled(disabled) {
  [
    'navDashboard',
    'navMachines',
    'navCreate',
    'navLibrary',
    'navSnapshots',
    'navStorage',
    'navNetwork',
    'navDownload',
    'navSettings',
    'navCredits'
  ].forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.disabled = !!disabled;
    button.style.opacity = disabled ? '0.55' : '';
    button.style.pointerEvents = disabled ? 'none' : '';
  });
}

function _ensureVBoxInstallDefaults() {
  if (!appState.vboxInstall.downloadFolder) {
    appState.vboxInstall.downloadFolder = appState.downloadPath || appState.defaults?.defaultDownloadDir || appState.installPath || '';
  }
}

function _renderVBoxInstallPanel(status = 'Preparing installation checks...') {
  const vbox = appState.vboxInstall;
  const installerPath = vbox.installerPath || '';
  const downloadFolder = vbox.downloadFolder || '';
  const startLabel = vbox.isInstalling
    ? 'Installing VirtualBox...'
    : vbox.isPaused
      ? 'Resume Download'
      : 'Install VirtualBox';

  return `
    <div class="dashboard">
      <div class="dashboard-header">
        <div class="dashboard-title-group">
          <h2 class="dashboard-title">VirtualBox Setup Required</h2>
          <span class="dashboard-subtitle">VM Xposed needs VirtualBox before V Os setup can continue.</span>
        </div>
      </div>

      <div class="vm-card" style="max-width: 900px;">
        <div class="vm-card-header">
          <div class="vm-card-title-group">
            <div class="vm-card-name">No VirtualBox installed on this system</div>
            <div class="vm-card-os">Do you want to install it now? Choose a local installer or let VM Xposed download it to your selected folder.</div>
          </div>
        </div>

        <div class="onboard-soft-note" style="margin: 2px 0 10px;">
          ${Icons.info} Automatic download is disabled. Installation starts only when you press Install VirtualBox.
        </div>

        <div class="vm-loading" style="justify-content:flex-start; margin: 4px 0 8px;">
          <div class="spinner-ring"></div>
          <span id="vboxInstallStatus">${status}</span>
        </div>

        <div style="margin: 10px 0 10px;">
          <div class="installing-progress-track">
            <div id="vboxInstallProgressFill" class="installing-progress-fill" style="width: 0%;"></div>
          </div>
          <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:12px; color: var(--text-secondary); gap: 10px;">
            <span id="vboxInstallPhaseText">Ready</span>
            <span id="vboxInstallProgressText">0%</span>
          </div>
        </div>

        <div class="form-group" style="margin-bottom: 10px;">
          <label class="form-label">Local Installer (Optional)</label>
          <div class="onboard-folder-row">
            <input class="form-input onboard-folder-input" id="vboxInstallerPath" value="${installerPath}" placeholder="Pick VirtualBox installer (.exe/.msi) from your computer" readonly />
            <button class="btn onboard-folder-btn" id="btnBrowseVBoxInstaller" type="button">${Icons.folder}</button>
            <button class="btn" id="btnClearVBoxInstaller" type="button">Clear</button>
          </div>
        </div>

        <div class="form-group" style="margin-bottom: 10px;">
          <label class="form-label">Download Folder (Used when installer is not selected)</label>
          <div class="onboard-folder-row">
            <input class="form-input onboard-folder-input" id="vboxDownloadFolder" value="${downloadFolder}" placeholder="Choose folder for VirtualBox download" />
            <button class="btn onboard-folder-btn" id="btnBrowseVBoxDownloadFolder" type="button">${Icons.folder}</button>
          </div>
        </div>

        <div class="vm-card-controls" style="margin-top: 8px;">
          <button class="btn btn-primary" id="btnStartVBoxInstall">${startLabel}</button>
          <button class="btn" id="btnPauseVBoxDownload">Pause Download</button>
          <button class="btn btn-danger" id="btnCancelVBoxDownload">Cancel Download</button>
        </div>
      </div>
    </div>
  `;
}

function _syncVBoxInstallPanelControls(allowStart = false) {
  const vbox = appState.vboxInstall;
  const isInstalling = !!vbox.isInstalling;
  const startBtn = document.getElementById('btnStartVBoxInstall');
  if (startBtn) {
    startBtn.textContent = isInstalling
      ? 'Installing VirtualBox...'
      : vbox.isPaused
        ? 'Resume Download'
        : 'Install VirtualBox';
    startBtn.disabled = isInstalling || !allowStart;
  }

  const pauseBtn = document.getElementById('btnPauseVBoxDownload');
  if (pauseBtn) {
    pauseBtn.disabled = !(isInstalling && vbox.canPause);
  }

  const cancelBtn = document.getElementById('btnCancelVBoxDownload');
  if (cancelBtn) {
    cancelBtn.disabled = !(isInstalling && vbox.canCancel);
  }

  const installerInput = document.getElementById('vboxInstallerPath');
  const downloadInput = document.getElementById('vboxDownloadFolder');
  const browseInstallerBtn = document.getElementById('btnBrowseVBoxInstaller');
  const clearInstallerBtn = document.getElementById('btnClearVBoxInstaller');
  const browseDownloadBtn = document.getElementById('btnBrowseVBoxDownloadFolder');

  if (installerInput) installerInput.value = vbox.installerPath || '';
  if (downloadInput) downloadInput.value = vbox.downloadFolder || '';

  const disablePathInputs = isInstalling;
  if (downloadInput) downloadInput.disabled = disablePathInputs;
  if (browseInstallerBtn) browseInstallerBtn.disabled = disablePathInputs;
  if (clearInstallerBtn) clearInstallerBtn.disabled = disablePathInputs || !vbox.installerPath;
  if (browseDownloadBtn) browseDownloadBtn.disabled = disablePathInputs;
}

function _updateVBoxInstallPanelStatus(message, allowStart = false, percent = null, phaseLabel = '') {
  const statusEl = document.getElementById('vboxInstallStatus');
  if (statusEl) {
    statusEl.textContent = message || 'Working...';
  }

  if (phaseLabel) {
    const phaseEl = document.getElementById('vboxInstallPhaseText');
    if (phaseEl) phaseEl.textContent = phaseLabel;
  }

  const pct = Number.isFinite(Number(percent))
    ? Math.max(0, Math.min(100, Math.round(Number(percent))))
    : null;

  if (pct !== null) {
    const fillEl = document.getElementById('vboxInstallProgressFill');
    if (fillEl) fillEl.style.width = `${pct}%`;

    const textEl = document.getElementById('vboxInstallProgressText');
    if (textEl) textEl.textContent = `${pct}%`;
  }

  _syncVBoxInstallPanelControls(allowStart);
}

function _formatVBoxEnsureProgress(data = {}) {
  const phase = String(data.phase || '').toLowerCase();
  const pct = Number.isFinite(Number(data.percent)) ? Math.max(0, Math.min(100, Math.round(Number(data.percent)))) : null;
  const phaseLabelMap = {
    system_check: 'Checking',
    download_vbox: 'Downloading',
    install_vbox: 'Installing'
  };
  const phaseLabel = phaseLabelMap[phase] || 'Working';

  if (phase === 'download_vbox') {
    const base = data.message || 'Downloading VirtualBox...';
    return {
      message: pct !== null ? `${base} (${pct}%)` : base,
      percent: pct,
      phaseLabel
    };
  }
  if (phase === 'install_vbox') {
    const base = data.message || 'Installing VirtualBox...';
    return {
      message: pct !== null ? `${base} (${pct}%)` : base,
      percent: pct,
      phaseLabel
    };
  }

  return {
    message: data.message || 'Working...',
    percent: pct,
    phaseLabel
  };
}

function _bindVBoxEnsureProgressListener() {
  if (appState._vboxProgressListenerBound) return;
  if (!window.vmInstaller?.onVBoxEnsureProgress) return;

  appState._vboxProgressListenerBound = true;
  window.vmInstaller.onVBoxEnsureProgress((data) => {
    if (!appState._vboxInstallPanelActive) return;
    const phase = String(data?.phase || '').toLowerCase();
    if (phase === 'download_vbox') {
      appState.vboxInstall.isInstalling = true;
      appState.vboxInstall.isPaused = false;
      appState.vboxInstall.canPause = true;
      appState.vboxInstall.canCancel = true;
    } else if (phase === 'install_vbox') {
      appState.vboxInstall.isInstalling = true;
      appState.vboxInstall.canPause = false;
      appState.vboxInstall.canCancel = false;
    }
    const formatted = _formatVBoxEnsureProgress(data || {});
    _updateVBoxInstallPanelStatus(formatted.message, false, formatted.percent, formatted.phaseLabel);
  });
}

function _showVBoxInstallPanel(status = 'Checking VirtualBox installation...') {
  _ensureVBoxInstallDefaults();
  appState.currentView = 'vbox-install';
  appState.isRunning = true;
  appState._vboxInstallPanelActive = true;

  _setPrimaryCta('vbox-install');
  _setSidebarNavigationDisabled(true);

  const stepIndicator = document.getElementById('stepIndicator');
  if (stepIndicator) stepIndicator.style.display = 'none';

  const container = document.getElementById('wizardContainer');
  if (!container) return;
  container.innerHTML = _renderVBoxInstallPanel(status);

  _syncVBoxInstallPanelControls(true);

  document.getElementById('btnStartVBoxInstall')?.addEventListener('click', () => {
    _ensureVirtualBoxOnStartup({ force: true, installNow: true });
  });

  document.getElementById('vboxDownloadFolder')?.addEventListener('input', (event) => {
    const selectedFolder = String(event.target.value || '').trim();
    appState.vboxInstall.downloadFolder = selectedFolder;
    appState.downloadPath = selectedFolder || appState.downloadPath;
  });

  document.getElementById('btnBrowseVBoxDownloadFolder')?.addEventListener('click', async () => {
    const selected = await window.vmInstaller.selectFolder(
      'Select VirtualBox download folder',
      appState.vboxInstall.downloadFolder || appState.downloadPath || appState.defaults?.defaultDownloadDir || ''
    );
    if (!selected) return;
    appState.vboxInstall.downloadFolder = selected;
    appState.downloadPath = selected;
    _updateVBoxInstallPanelStatus('Download folder selected. Click "Install VirtualBox" to continue.', true, 0, 'Ready');
  });

  document.getElementById('btnBrowseVBoxInstaller')?.addEventListener('click', async () => {
    const selected = await window.vmInstaller.selectFile(
      'Select VirtualBox installer',
      [
        { name: 'VirtualBox Installer', extensions: ['exe', 'msi'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    );
    if (!selected) return;
    appState.vboxInstall.installerPath = selected;
    appState.vboxInstall.isPaused = false;
    _updateVBoxInstallPanelStatus('Local installer selected. Click "Install VirtualBox" to continue.', true, 0, 'Ready');
  });

  document.getElementById('btnClearVBoxInstaller')?.addEventListener('click', () => {
    appState.vboxInstall.installerPath = '';
    appState.vboxInstall.isPaused = false;
    _updateVBoxInstallPanelStatus('Installer selection cleared. Download mode is ready.', true, 0, 'Ready');
  });

  document.getElementById('btnPauseVBoxDownload')?.addEventListener('click', async () => {
    if (!window.vmInstaller?.pauseVBoxDownload) return;
    const paused = await window.vmInstaller.pauseVBoxDownload();
    if (!paused?.success) {
      _updateVBoxInstallPanelStatus('Pause is only available while download is active.', false, null, 'Downloading');
      return;
    }
    appState.vboxInstall.isInstalling = false;
    appState.vboxInstall.isPaused = true;
    appState.vboxInstall.canPause = false;
    appState.vboxInstall.canCancel = false;
    _updateVBoxInstallPanelStatus('Download paused. Click "Resume Download" to continue.', true, null, 'Paused');
  });

  document.getElementById('btnCancelVBoxDownload')?.addEventListener('click', async () => {
    if (!window.vmInstaller?.cancelVBoxDownload) return;
    const cancelled = await window.vmInstaller.cancelVBoxDownload();
    if (!cancelled?.success) {
      _updateVBoxInstallPanelStatus('Cancel is only available while download is active.', false, null, 'Downloading');
      return;
    }
    appState.vboxInstall.isInstalling = false;
    appState.vboxInstall.isPaused = false;
    appState.vboxInstall.canPause = false;
    appState.vboxInstall.canCancel = false;
    _updateVBoxInstallPanelStatus('Download canceled. You can start again anytime.', true, 0, 'Cancelled');
  });
}

async function _ensureVirtualBoxOnStartup(options = {}) {
  const force = !!options.force;
  const installNow = !!options.installNow;
  if (!window.vmInstaller?.detectVBox || !window.vmInstaller?.ensureVBoxInstalled) return;
  if (appState._vboxStartupChecked && !force) return;
  if (appState._vboxEnsureInProgress) return;

  appState._vboxEnsureInProgress = true;

  try {
    const detected = await window.vmInstaller.detectVBox();
    if (detected?.installed) {
      appState._vboxStartupChecked = true;
      appState._vboxInstallPanelActive = false;
      appState.isRunning = false;
      appState.vboxInstall.isInstalling = false;
      appState.vboxInstall.isPaused = false;
      appState.vboxInstall.canPause = false;
      appState.vboxInstall.canCancel = false;
      _setSidebarNavigationDisabled(false);
      await _checkAndHandleVmBootstrapOnStartup();
      return;
    }

    _showVBoxInstallPanel('VirtualBox is not installed on this system.');
    if (!installNow) {
      appState.vboxInstall.isInstalling = false;
      appState.vboxInstall.isPaused = false;
      appState.vboxInstall.canPause = false;
      appState.vboxInstall.canCancel = false;
      _updateVBoxInstallPanelStatus('No automatic download will start. Click "Install VirtualBox" to continue.', true, 0, 'Ready');
      return;
    }

    const selectedInstallerPath = String(appState.vboxInstall.installerPath || '').trim();
    const selectedDownloadFolder = String(appState.vboxInstall.downloadFolder || appState.downloadPath || appState.defaults?.defaultDownloadDir || '').trim();

    if (!selectedInstallerPath && !selectedDownloadFolder) {
      _updateVBoxInstallPanelStatus('Please select a download folder before starting installation.', true, null, 'Ready');
      return;
    }

    appState.vboxInstall.downloadFolder = selectedDownloadFolder;
    appState.downloadPath = selectedDownloadFolder || appState.downloadPath;
    appState.vboxInstall.isInstalling = true;
    appState.vboxInstall.isPaused = false;
    appState.vboxInstall.canPause = !selectedInstallerPath;
    appState.vboxInstall.canCancel = !selectedInstallerPath;

    _updateVBoxInstallPanelStatus(
      selectedInstallerPath
        ? 'Installing VirtualBox from selected installer. Please approve admin prompt if asked...'
        : 'Downloading and installing VirtualBox. Please approve admin prompt if asked...',
      false,
      selectedInstallerPath ? 20 : 5,
      selectedInstallerPath ? 'Installing' : 'Starting'
    );

    const ensured = await window.vmInstaller.ensureVBoxInstalled({
      downloadDir: selectedDownloadFolder,
      installerPath: selectedInstallerPath
    });
    if (!ensured?.success) {
      appState.vboxInstall.isInstalling = false;
      appState.vboxInstall.canPause = false;
      appState.vboxInstall.canCancel = false;
      if (ensured?.code === 'PAUSED') {
        appState.vboxInstall.isPaused = true;
        _updateVBoxInstallPanelStatus('Download paused. Click "Resume Download" to continue.', true, null, 'Paused');
        return;
      }
      if (ensured?.code === 'CANCELLED') {
        appState.vboxInstall.isPaused = false;
        _updateVBoxInstallPanelStatus('Download canceled. Click "Install VirtualBox" to start again.', true, 0, 'Cancelled');
        return;
      }
      appState.vboxInstall.isPaused = false;
      _updateVBoxInstallPanelStatus(`Install failed: ${ensured?.error || 'Unknown error'}`, true, null, 'Failed');
      return;
    }

    const postCheck = await window.vmInstaller.detectVBox();
    if (!postCheck?.installed) {
      appState.vboxInstall.isInstalling = false;
      appState.vboxInstall.isPaused = false;
      appState.vboxInstall.canPause = false;
      appState.vboxInstall.canCancel = false;
      _updateVBoxInstallPanelStatus('Install finished but VirtualBox was not detected. Click Install VirtualBox to retry.', true, null, 'Failed');
      return;
    }

    appState._vboxStartupChecked = true;
    appState._vboxInstallPanelActive = false;
    appState.isRunning = false;
    appState.vboxInstall.isInstalling = false;
    appState.vboxInstall.isPaused = false;
    appState.vboxInstall.canPause = false;
    appState.vboxInstall.canCancel = false;
    _setSidebarNavigationDisabled(false);
    _updateVBoxInstallPanelStatus(`VirtualBox ${ensured?.version || postCheck.version || ''} installed successfully. Opening dashboard...`, false, 100, 'Complete');

    _notify(`VirtualBox ${ensured?.version || ''} installed and ready.`, 'success');
    const shownBootstrap = await _checkAndHandleVmBootstrapOnStartup();
    if (!shownBootstrap) {
      app.showDashboard();
    }
  } catch (err) {
    _showVBoxInstallPanel('VirtualBox installation encountered an error.');
    appState.vboxInstall.isInstalling = false;
    appState.vboxInstall.isPaused = false;
    appState.vboxInstall.canPause = false;
    appState.vboxInstall.canCancel = false;
    _updateVBoxInstallPanelStatus(`Install error: ${err?.message || 'Unknown error'}`, true, null, 'Failed');
  } finally {
    appState._vboxEnsureInProgress = false;
  }
}

async function _scanDownloadedVmsForBootstrap() {
  if (!window.vmInstaller?.scanDownloadedVMs) {
    return [];
  }

  const scan = await window.vmInstaller.scanDownloadedVMs(appState.installPath || appState.defaults?.defaultInstallPath || '');
  if (!scan?.success) {
    return [];
  }

  const candidates = Array.isArray(scan.candidates) ? scan.candidates : [];
  appState.downloadedVmCandidates = candidates;
  return candidates;
}

function _estimateVmBootstrapIsoGb(typeName, info = {}) {
  const name = String(typeName || '').toLowerCase();
  const category = String(info.category || '').toLowerCase();
  const filename = String(info.filename || '').toLowerCase();
  const versionMatch = name.match(/(\d{2})\.(\d{2})/);

  if (!info.downloadUrl || info.requireCustomIso) return 0;
  if (filename.includes('netinst')) return 1;
  if (filename.includes('minimal')) return 3;
  if (name.includes('windows server')) return 6;
  if (name.includes('windows 11')) return 6;
  if (name.includes('windows 10')) return 5.5;
  if (name.includes('ubuntu') && filename.includes('desktop')) {
    if (versionMatch) {
      const major = Number(versionMatch[1]);
      if (major >= 24) return 6;
      if (major >= 22) return 5.5;
      if (major >= 20) return 5;
      return 4;
    }
    return 5.5;
  }
  if (name.includes('ubuntu') && filename.includes('server')) return 2.5;
  if (category.includes('fedora')) return 4;
  if (category.includes('kali')) return 5;
  if (category.includes('linux mint')) return 3.2;
  if (category.includes('bsd')) return 2.5;
  if (category.includes('rhel')) return 4;
  if (category.includes('debian')) return 1;
  if (category.includes('arch')) return 2;
  return 3;
}

function _getVmBootstrapEstimate(typeName) {
  const info = appState.defaults?.osCatalog?.[typeName] || {};
  const diskMb = Number(info.disk || 25600);
  const diskGb = Math.max(8, Math.round(diskMb / 1024));
  const isoGb = _estimateVmBootstrapIsoGb(typeName, info);
  const totalGb = Math.max(isoGb, diskGb + isoGb);
  const preview = Math.max(18, Math.min(92, Math.round((totalGb / 90) * 100)));
  return { info, diskGb, isoGb, totalGb, preview };
}

function _syncVmBootstrapProgress(progress = 0) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  const fill = document.getElementById('onboardValidationFill');
  const label = document.getElementById('onboardValidationPct');
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = `${pct}%`;
}

function _setVmBootstrapInlineError(field, message) {
  appState.vmBootstrapFlow.invalidField = field || '';
  appState.vmBootstrapFlow.inlineError = message || '';
}

function _clearVmBootstrapInlineError() {
  appState.vmBootstrapFlow.invalidField = '';
  appState.vmBootstrapFlow.inlineError = '';
}

function _renderVmBootstrapEmptyPanel(data = {}) {
  const candidateCount = Number(data.candidateCount || 0);
  return `
    <div class="onboard-panel-head">
      <div class="onboard-kicker">Auto Detection</div>
      <h2 class="onboard-title">No V Os Detected</h2>
      <p class="onboard-desc">No V Os are installed on this system. Do you want to set one up now?</p>
      ${candidateCount > 0 ? `<div class="onboard-soft-note">${Icons.info} Found ${candidateCount} downloaded V Os from earlier sessions.</div>` : ''}
    </div>

    <div class="onboard-illustration-wrap">
      <div class="onboard-illustration" id="onboardVmArt">
        <div class="onboard-illustration-core">${Icons.sized(Icons.server, 42)}</div>
        <div class="onboard-illustration-layer onboard-illustration-layer--one"></div>
        <div class="onboard-illustration-layer onboard-illustration-layer--two"></div>
        <div class="onboard-illustration-grid"></div>
      </div>
    </div>

    <div class="onboard-actions">
      <button class="btn btn-primary onboard-cta" id="btnVmOnboardStart">Confirm and Continue</button>
      <div class="onboard-status" id="vmBootstrapStatusInline">${data.message || 'Ready when you are.'}</div>
    </div>
  `;
}

function _renderVmBootstrapOptionsPanel(data = {}) {
  const flow = appState.vmBootstrapFlow;
  const osCatalog = appState.defaults?.osCatalog || {};
  const osNames = Object.keys(osCatalog);
  const selectedType = flow.selectedVmType || osNames[0] || appState.osName || '';
  const selectedOption = flow.selectedOption || 'download';
  const downloadFolder = flow.downloadFolder || appState.installPath || appState.defaults?.defaultInstallPath || '';
  const importFolder = flow.importFolder || appState.existingVmFolder || '';
  const estimate = _getVmBootstrapEstimate(selectedType);
  const invalid = flow.invalidField || '';
  const inlineError = flow.inlineError || '';
  const validationError = flow.validationError || '';
  const status = flow.statusMessage || data.message || 'Choose how you want to set up your V Os.';

  return `
    <div class="onboard-panel-head">
      <div class="onboard-kicker">Setup Options</div>
      <h2 class="onboard-title">Set Up V Os</h2>
      <p class="onboard-desc">Pick a setup mode and continue with the full customization wizard.</p>
      <div class="onboard-soft-note">${Icons.info} All legacy customization layers are available in the modern flow.</div>
    </div>

    <div class="onboard-options-grid">
      <article class="onboard-option-card ${selectedOption === 'download' ? 'is-active' : ''}" id="cardVmOnboardDownload">
        <div class="onboard-option-head">
          <div class="onboard-option-icon onboard-option-icon--download">${Icons.sized(Icons.download, 20)}</div>
          <div class="onboard-option-meta">
            <h3>Download V Os</h3>
            <p>Use official source, then tune hardware, advanced options, and review before creation.</p>
          </div>
        </div>

        <div class="onboard-option-body ${selectedOption === 'download' ? 'is-open' : ''}">
          <div class="form-group">
            <label class="form-label">VM Type</label>
            <select class="form-select onboard-select" id="onboardVmType">
              ${osNames.map((name) => `<option value="${name}" ${name === selectedType ? 'selected' : ''}>${name}</option>`).join('')}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">Install Folder</label>
            <div class="onboard-folder-row ${invalid === 'download-folder' ? 'is-invalid' : ''}">
              <input class="form-input onboard-folder-input" id="onboardDownloadFolder" value="${downloadFolder}" placeholder="Select folder for setup artifacts" />
              <button class="btn onboard-folder-btn" id="btnOnboardDownloadBrowse" type="button">${Icons.folder}</button>
            </div>
          </div>

          <div class="onboard-size-preview">
            <div class="onboard-size-head">
              <span>Estimated size</span>
              <strong>~${estimate.totalGb.toFixed(1).replace('.0', '')} GB</strong>
            </div>
            <div class="onboard-size-track">
              <div class="onboard-size-fill" style="width:${estimate.preview}%"></div>
            </div>
            <div class="onboard-size-caption">${estimate.info?.downloadUrl ? `ISO ~${estimate.isoGb.toFixed(1).replace('.0', '')} GB + V Os disk ${estimate.diskGb} GB` : 'Manual ISO source required'} · RAM ${estimate.info?.ram || 2048} MB · CPU ${estimate.info?.cpus || 2}</div>
          </div>

          <button class="btn btn-primary onboard-start-btn" id="btnOnboardContinueDownload">Continue to Customization</button>
        </div>
      </article>

      <article class="onboard-option-card ${selectedOption === 'import' ? 'is-active' : ''}" id="cardVmOnboardImport">
        <div class="onboard-option-head">
          <div class="onboard-option-icon onboard-option-icon--folder">${Icons.sized(Icons.folder, 20)}</div>
          <div class="onboard-option-meta">
            <h3>Pick From Folder</h3>
            <p>Use an already downloaded V Os from your disk, then apply customization layers.</p>
          </div>
        </div>

        <div class="onboard-option-body ${selectedOption === 'import' ? 'is-open' : ''}">
          <div class="form-group">
            <label class="form-label">Folder</label>
            <div class="onboard-folder-row ${invalid === 'import-folder' || validationError ? 'is-invalid' : ''}">
              <input class="form-input onboard-folder-input" id="onboardImportFolder" value="${importFolder}" placeholder="Pick a folder containing a .vbox file" readonly />
              <button class="btn onboard-folder-btn" id="btnOnboardImportBrowse" type="button">${Icons.folder}</button>
            </div>
          </div>

          <div class="onboard-validation ${flow.validating ? 'is-running' : ''} ${flow.validated ? 'is-complete' : ''}">
            <div class="onboard-validation-track">
              <div class="onboard-validation-fill" id="onboardValidationFill" style="width:${flow.validationProgress || 0}%"></div>
            </div>
            <div class="onboard-validation-meta">
              <span id="onboardValidationText">${flow.validating ? 'Validating selected folder...' : (flow.validated ? `Validated: ${flow.detectedVmName}` : 'Select a folder to validate.')}</span>
              <strong id="onboardValidationPct">${Math.max(0, Math.min(100, Math.round(flow.validationProgress || 0)))}%</strong>
            </div>
          </div>

          ${validationError ? `<div class="onboard-error">${Icons.warning}<span>${validationError}</span></div>` : ''}

          <button class="btn btn-primary onboard-start-btn" id="btnOnboardContinueImport" ${flow.validating ? 'disabled' : ''}>Import & Customize</button>
        </div>
      </article>
    </div>

    ${inlineError ? `<div class="onboard-inline-error">${Icons.warning}<span>${inlineError}</span></div>` : ''}

    <div class="onboard-actions onboard-actions--split">
      <button class="btn btn-secondary" id="btnVmOnboardBack">Back</button>
      <div class="onboard-status" id="vmBootstrapStatusInline">${status}</div>
    </div>
  `;
}

function _renderVmBootstrapPanel(data = {}) {
  const flow = appState.vmBootstrapFlow;
  const panel = flow.panel || 'empty';
  const enterClass = flow.panelEnter === 'from-right'
    ? 'onboard-panel-enter-right'
    : flow.panelEnter === 'from-left'
      ? 'onboard-panel-enter-left'
      : flow.panelEnter === 'initial'
        ? 'onboard-panel-enter'
        : '';
  const panelContent = panel === 'options'
    ? _renderVmBootstrapOptionsPanel(data)
    : _renderVmBootstrapEmptyPanel(data);

  return `
    <div class="onboard-shell ${panel === 'options' ? 'is-options' : 'is-empty'}" id="vmOnboardShell">
      <div class="onboard-dim"></div>
      <div class="onboard-noise"></div>
      <div class="onboard-particles"></div>
      <section class="onboard-panel ${enterClass}" id="vmOnboardPanel">
        ${panelContent}
      </section>
    </div>
  `;
}

function _transitionVmBootstrapPanel(nextPanel, direction = 'forward') {
  const panelEl = document.getElementById('vmOnboardPanel');
  if (!panelEl) {
    appState.vmBootstrapFlow.panel = nextPanel;
    appState.vmBootstrapFlow.panelEnter = direction === 'forward' ? 'from-right' : 'from-left';
    _showVmBootstrapPanel();
    return;
  }

  panelEl.classList.add(direction === 'forward' ? 'onboard-panel-leave-left' : 'onboard-panel-leave-right');
  window.setTimeout(() => {
    appState.vmBootstrapFlow.panel = nextPanel;
    appState.vmBootstrapFlow.panelEnter = direction === 'forward' ? 'from-right' : 'from-left';
    _showVmBootstrapPanel();
  }, VM_BOOTSTRAP_TRANSITION_MS);
}

async function _validateVmBootstrapImportFolder(folderPath) {
  const flow = appState.vmBootstrapFlow;
  flow.validationError = '';
  flow.validated = false;
  flow.detectedVmName = '';
  flow.validating = true;
  flow.validationProgress = 4;
  flow.statusMessage = 'Validating selected folder...';
  _clearVmBootstrapInlineError();
  _showVmBootstrapPanel();

  let progress = 4;
  const progressTimer = window.setInterval(() => {
    progress = Math.min(92, progress + Math.random() * 16);
    flow.validationProgress = progress;
    _syncVmBootstrapProgress(progress);
  }, 80);

  try {
    const detected = await window.vmInstaller.resolveVMFromFolder(folderPath, { registerIfNeeded: false });
    window.clearInterval(progressTimer);
    flow.validating = false;
    flow.validationProgress = 100;
    _syncVmBootstrapProgress(100);

    if (!detected?.success) {
      flow.validated = false;
      flow.validationError = detected?.error || 'Could not validate this folder.';
      flow.statusMessage = 'Validation failed.';
      _setVmBootstrapInlineError('import-folder', flow.validationError);
      _showVmBootstrapPanel();
      return false;
    }

    flow.validated = true;
    flow.detectedVmName = detected.vmName || '';
    flow.validationError = '';
    flow.statusMessage = `Validation complete: ${flow.detectedVmName || 'Machine detected'}.`;
    _showVmBootstrapPanel();
    return true;
  } catch (err) {
    window.clearInterval(progressTimer);
    flow.validating = false;
    flow.validated = false;
    flow.validationProgress = 0;
    flow.validationError = err?.message || 'Folder validation failed.';
    flow.statusMessage = 'Validation failed.';
    _setVmBootstrapInlineError('import-folder', flow.validationError);
    _showVmBootstrapPanel();
    return false;
  }
}

async function _pickVmBootstrapFolder(mode = 'import') {
  const flow = appState.vmBootstrapFlow;
  const defaultPath = mode === 'download'
    ? (flow.downloadFolder || appState.installPath || appState.defaults?.defaultInstallPath || '')
    : (flow.importFolder || appState.existingVmFolder || appState.installPath || '');
  const title = mode === 'download'
    ? 'Select setup folder'
    : 'Select downloaded V Os folder';
  const selected = await window.vmInstaller.selectFolder(title, defaultPath);
  if (!selected) return false;

  if (mode === 'download') {
    flow.downloadFolder = selected;
  } else {
    flow.importFolder = selected;
    flow.validated = false;
    flow.detectedVmName = '';
    flow.validationError = '';
    flow.validationProgress = 0;
  }

  _saveVmBootstrapPrefs({
    lastOption: flow.selectedOption,
    selectedVmType: flow.selectedVmType,
    downloadFolder: flow.downloadFolder,
    importFolder: flow.importFolder
  });
  _clearVmBootstrapInlineError();
  _showVmBootstrapPanel();
  return true;
}

function _launchVmBootstrapSetup(mode = 'download') {
  const flow = appState.vmBootstrapFlow;
  _clearVmBootstrapInlineError();
  let wizardStartStep = 0;

  if (mode === 'download') {
    if (!flow.selectedVmType) {
      _setVmBootstrapInlineError('download-type', 'Please select a VM type.');
      _showVmBootstrapPanel();
      return;
    }
    if (!flow.downloadFolder || !String(flow.downloadFolder).trim()) {
      _setVmBootstrapInlineError('download-folder', 'Please choose a folder for setup files.');
      _showVmBootstrapPanel();
      return;
    }

    appState.useExistingVm = false;
    appState.existingVmName = '';
    appState.existingVmFolder = '';
    appState.isoSource = 'official';
    appState.customIsoPath = '';
    appState.osName = flow.selectedVmType;
    appState.installPath = flow.downloadFolder.trim();
    appState.downloadPath = flow.downloadFolder.trim();
    if (!appState.vmName) {
      const compactName = (appState.osName || 'Virtual-OS').replace(/\s*\(.+\)$/, '').replace(/\s+/g, '-');
      appState.vmName = `My-${compactName}`;
      appState._autoVmName = appState.vmName;
    }
    wizardStartStep = 0;
  } else {
    if (!flow.importFolder || !String(flow.importFolder).trim()) {
      _setVmBootstrapInlineError('import-folder', 'Please pick a folder to import.');
      _showVmBootstrapPanel();
      return;
    }
    if (!flow.validated) {
      _setVmBootstrapInlineError('import-folder', 'Please validate the selected folder before continuing.');
      _showVmBootstrapPanel();
      return;
    }

    appState.useExistingVm = true;
    appState.existingVmFolder = flow.importFolder.trim();
    appState.existingVmName = flow.detectedVmName || '';
    if (flow.detectedVmName) {
      appState.vmName = flow.detectedVmName;
      appState._autoVmName = '';
    }
    wizardStartStep = 4;
  }

  const shell = document.getElementById('vmOnboardShell');
  flow.launchedFromBootstrap = false;
  if (shell) shell.classList.add('is-launching');
  window.setTimeout(() => app.showWizard({ startStep: wizardStartStep }), VM_BOOTSTRAP_TRANSITION_MS + 60);
}

function _bindVmBootstrapEvents() {
  const flow = appState.vmBootstrapFlow;

  document.getElementById('btnVmOnboardStart')?.addEventListener('click', () => {
    const btn = document.getElementById('btnVmOnboardStart');
    btn?.classList.add('is-rippling');
    window.setTimeout(() => btn?.classList.remove('is-rippling'), 420);
    _transitionVmBootstrapPanel('options', 'forward');
  });

  document.getElementById('btnVmOnboardBack')?.addEventListener('click', () => {
    _transitionVmBootstrapPanel('empty', 'reverse');
  });

  document.getElementById('cardVmOnboardDownload')?.addEventListener('click', (event) => {
    if (event.target.closest('button, input, select')) return;
    flow.selectedOption = 'download';
    _saveVmBootstrapPrefs({
      lastOption: flow.selectedOption,
      selectedVmType: flow.selectedVmType,
      downloadFolder: flow.downloadFolder,
      importFolder: flow.importFolder
    });
    _clearVmBootstrapInlineError();
    _showVmBootstrapPanel();
  });

  document.getElementById('cardVmOnboardImport')?.addEventListener('click', async (event) => {
    if (event.target.closest('button, input, select')) return;
    flow.selectedOption = 'import';
    _saveVmBootstrapPrefs({
      lastOption: flow.selectedOption,
      selectedVmType: flow.selectedVmType,
      downloadFolder: flow.downloadFolder,
      importFolder: flow.importFolder
    });
    _clearVmBootstrapInlineError();
    _showVmBootstrapPanel();
    if (!flow.importFolder) {
      const selected = await _pickVmBootstrapFolder('import');
      if (selected) await _validateVmBootstrapImportFolder(flow.importFolder);
    }
  });

  document.getElementById('onboardVmType')?.addEventListener('change', (event) => {
    flow.selectedVmType = event.target.value;
    _saveVmBootstrapPrefs({
      lastOption: flow.selectedOption,
      selectedVmType: flow.selectedVmType,
      downloadFolder: flow.downloadFolder,
      importFolder: flow.importFolder
    });
    _clearVmBootstrapInlineError();
    _showVmBootstrapPanel();
  });

  document.getElementById('onboardDownloadFolder')?.addEventListener('input', (event) => {
    flow.downloadFolder = event.target.value || '';
    _saveVmBootstrapPrefs({
      lastOption: flow.selectedOption,
      selectedVmType: flow.selectedVmType,
      downloadFolder: flow.downloadFolder,
      importFolder: flow.importFolder
    });
    _clearVmBootstrapInlineError();
  });

  document.getElementById('btnOnboardDownloadBrowse')?.addEventListener('click', async () => {
    await _pickVmBootstrapFolder('download');
  });

  document.getElementById('btnOnboardImportBrowse')?.addEventListener('click', async () => {
    const selected = await _pickVmBootstrapFolder('import');
    if (selected) await _validateVmBootstrapImportFolder(flow.importFolder);
  });

  document.getElementById('btnOnboardContinueDownload')?.addEventListener('click', () => {
    flow.selectedOption = 'download';
    _saveVmBootstrapPrefs({
      lastOption: flow.selectedOption,
      selectedVmType: flow.selectedVmType,
      downloadFolder: flow.downloadFolder,
      importFolder: flow.importFolder
    });
    _launchVmBootstrapSetup('download');
  });

  document.getElementById('btnOnboardContinueImport')?.addEventListener('click', async () => {
    flow.selectedOption = 'import';
    if (!flow.validated && flow.importFolder) {
      const valid = await _validateVmBootstrapImportFolder(flow.importFolder);
      if (!valid) return;
    }
    _saveVmBootstrapPrefs({
      lastOption: flow.selectedOption,
      selectedVmType: flow.selectedVmType,
      downloadFolder: flow.downloadFolder,
      importFolder: flow.importFolder
    });
    _launchVmBootstrapSetup('import');
  });
}

function _showVmBootstrapPanel(message = 'No V Os were found. Choose how to continue.') {
  const flow = appState.vmBootstrapFlow;
  const enteringBootstrap = appState.currentView !== 'vm-bootstrap';
  if (!flow.selectedVmType) {
    flow.selectedVmType = appState.osName || Object.keys(appState.defaults?.osCatalog || {})[0] || '';
  }
  if (!flow.downloadFolder) {
    flow.downloadFolder = appState.installPath || appState.defaults?.defaultInstallPath || '';
  }
  if (!flow.importFolder && appState.existingVmFolder) {
    flow.importFolder = appState.existingVmFolder;
  }
  if (message) flow.statusMessage = message;
  if (enteringBootstrap && !flow.panelEnter) flow.panelEnter = 'initial';

  appState.currentView = 'vm-bootstrap';
  appState.isRunning = false;

  _setActiveNav('machines');
  _setPrimaryCta('vm-bootstrap');
  _setSidebarNavigationDisabled(false);

  const stepIndicator = document.getElementById('stepIndicator');
  if (stepIndicator) stepIndicator.style.display = 'none';

  const container = document.getElementById('wizardContainer');
  if (!container) return;
  container.innerHTML = _renderVmBootstrapPanel({
    candidateCount: Array.isArray(appState.downloadedVmCandidates) ? appState.downloadedVmCandidates.length : 0,
    message: flow.statusMessage
  });

  _bindVmBootstrapEvents();
  if (flow.panelEnter) flow.panelEnter = '';
}

async function _checkAndHandleVmBootstrapOnStartup() {
  if (appState.isRunning) return false;

  try {
    const vmListResult = await window.vmInstaller.listVMs();
    if (!vmListResult?.success || !Array.isArray(vmListResult.vms)) {
      return false;
    }

    if (vmListResult.vms.length > 0) {
      appState.existingVMs = vmListResult.vms;
      return false;
    }

    const detectedCandidates = await _scanDownloadedVmsForBootstrap();
    appState.vmBootstrapFlow.panel = 'empty';
    appState.vmBootstrapFlow.panelEnter = '';
    _showVmBootstrapPanel(
      detectedCandidates.length > 0
        ? `No registered V Os found, but ${detectedCandidates.length} downloaded candidates were detected.`
        : 'No V Os found. Set up or import one to continue.'
    );
    return true;
  } catch {
    return false;
  }
}

function _refreshCatalogInBackground() {
  if (startupCatalogRefreshPromise) return startupCatalogRefreshPromise;

  startupCatalogRefreshPromise = window.vmInstaller.refreshOfficialCatalog()
    .then((refreshed) => {
      if (!refreshed?.success) return refreshed;

      appState.defaults.osCatalog = refreshed.osCatalog || appState.defaults.osCatalog;
      appState.defaults.osCategories = refreshed.osCategories || appState.defaults.osCategories;
      appState.catalogRefreshMeta = {
        timestamp: Date.now(),
        totalAdded: refreshed.totalAdded || 0,
        summary: refreshed.summary || {}
      };
      _saveCatalogRefreshMeta(appState.catalogRefreshMeta);

      if (!appState.osName || !appState.defaults.osCatalog?.[appState.osName]) {
        appState.osName = Object.keys(appState.defaults.osCatalog || {})[0] || appState.osName;
      }

      return refreshed;
    })
    .catch((err) => {
      console.warn('Background catalog refresh failed:', err);
      return { success: false, error: err?.message || 'Catalog refresh failed' };
    })
    .finally(() => {
      startupCatalogRefreshPromise = null;
    });

  return startupCatalogRefreshPromise;
}

function _renderOverview() {
  return `
    <div class="dashboard overview-premium">
      <section class="overview-hero-panel">
        <div>
          <div class="overview-eyebrow">Dashboard</div>
          <h2 class="dashboard-title">VM Xposed Command Center</h2>
          <p class="dashboard-subtitle">High-signal visibility across virtualization workload, resources, and host readiness.</p>
        </div>
        <div class="overview-hero-meta">
          <div class="ov-health-badge is-neutral" id="ovHealthBadgeTop">Syncing diagnostics...</div>
          <span class="overview-last-sync" id="ovLastChecked">Last update: --</span>
          <span class="overview-last-sync" id="ovLastFullScan">Full scan: not run</span>
        </div>
      </section>

      <section class="overview-metric-grid" id="overviewStats">
        <article class="overview-metric-card">
          <div class="overview-metric-head">
            <div class="overview-metric-icon">${Icons.sized(Icons.play, 16)}</div>
            <span>Active V Os</span>
          </div>
          <div class="overview-metric-value" id="ovMetricActive">--</div>
          <div class="overview-metric-sub" id="ovRunningCountLabel">Syncing inventory...</div>
        </article>

        <article class="overview-metric-card">
          <div class="overview-metric-head">
            <div class="overview-metric-icon">${Icons.sized(Icons.cpu, 16)}</div>
            <span>CPU Usage</span>
          </div>
          <div class="overview-metric-value" id="ovMetricCpu">--</div>
          <div class="overview-metric-sub" id="ovMetricCpuSub">Detecting host CPU load</div>
          <div class="overview-metric-spark" id="ovCpuSpark">
            <span class="skeleton-bar"></span><span class="skeleton-bar"></span><span class="skeleton-bar"></span>
          </div>
        </article>

        <article class="overview-metric-card">
          <div class="overview-metric-head">
            <div class="overview-metric-icon">${Icons.sized(Icons.memory, 16)}</div>
            <span>RAM Usage</span>
          </div>
          <div class="overview-metric-value" id="ovMetricRam">--</div>
          <div class="overview-metric-sub" id="ovMetricRamSub">Collecting memory utilization</div>
          <div class="overview-metric-spark" id="ovRamSpark">
            <span class="skeleton-bar"></span><span class="skeleton-bar"></span><span class="skeleton-bar"></span>
          </div>
        </article>

        <article class="overview-metric-card">
          <div class="overview-metric-head">
            <div class="overview-metric-icon">${Icons.sized(Icons.hardDrive, 16)}</div>
            <span>Disk I/O</span>
          </div>
          <div class="overview-metric-value" id="ovMetricDiskIo">--</div>
          <div class="overview-metric-sub" id="ovMetricDiskTrend">Awaiting workload telemetry</div>
        </article>

        <article class="overview-metric-card">
          <div class="overview-metric-head">
            <div class="overview-metric-icon">${Icons.sized(Icons.network, 16)}</div>
            <span>Network Activity</span>
          </div>
          <div class="overview-metric-value" id="ovMetricNetwork">--</div>
          <div class="overview-metric-sub" id="ovMetricNetworkTrend">No active traffic yet</div>
        </article>
      </section>

      <div class="overview-main-grid">
        <section class="overview-panel">
          <div class="overview-panel-head">
            <div class="overview-panel-title">
              <div class="overview-panel-icon">${Icons.sized(Icons.vm, 16)}</div>
              <h3>Running V Os</h3>
            </div>
            <button class="btn btn-secondary btn-sm" id="ovGoMachines">Open V Os</button>
          </div>
          <div class="overview-running-list" id="ovRunningList">
            <div class="overview-vm-row is-skeleton"><div class="overview-skeleton-line"></div></div>
            <div class="overview-vm-row is-skeleton"><div class="overview-skeleton-line"></div></div>
            <div class="overview-vm-row is-skeleton"><div class="overview-skeleton-line"></div></div>
          </div>
        </section>

        <section class="overview-panel">
          <div class="overview-panel-head">
            <div class="overview-panel-title">
              <div class="overview-panel-icon">${Icons.sized(Icons.cpu, 16)}</div>
              <h3>Resource Monitor</h3>
            </div>
            <span class="overview-muted">Animated host trends</span>
          </div>
          <div class="overview-chart-grid">
            <article class="overview-chart-card">
              <div class="overview-chart-meta"><span>CPU over time</span><strong id="ovChartCpuValue">--</strong></div>
              <svg class="overview-chart-svg" viewBox="0 0 320 110" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="ovChartGradCpu" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#5B8CFF"></stop>
                    <stop offset="100%" stop-color="#8B5CF6"></stop>
                  </linearGradient>
                  <linearGradient id="ovChartAreaGradCpu" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="#5B8CFF" stop-opacity="0.26"></stop>
                    <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0.02"></stop>
                  </linearGradient>
                </defs>
                <path id="ovChartCpuArea" class="ov-chart-area" fill="url(#ovChartAreaGradCpu)" d=""></path>
                <path id="ovChartCpuPath" class="ov-chart-line" stroke="url(#ovChartGradCpu)" d=""></path>
              </svg>
            </article>
            <article class="overview-chart-card">
              <div class="overview-chart-meta"><span>Memory over time</span><strong id="ovChartRamValue">--</strong></div>
              <svg class="overview-chart-svg" viewBox="0 0 320 110" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="ovChartGradRam" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#5B8CFF"></stop>
                    <stop offset="100%" stop-color="#8B5CF6"></stop>
                  </linearGradient>
                  <linearGradient id="ovChartAreaGradRam" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="#5B8CFF" stop-opacity="0.24"></stop>
                    <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0.02"></stop>
                  </linearGradient>
                </defs>
                <path id="ovChartRamArea" class="ov-chart-area" fill="url(#ovChartAreaGradRam)" d=""></path>
                <path id="ovChartRamPath" class="ov-chart-line" stroke="url(#ovChartGradRam)" d=""></path>
              </svg>
            </article>
            <article class="overview-chart-card">
              <div class="overview-chart-meta"><span>Disk throughput</span><strong id="ovChartDiskValue">--</strong></div>
              <svg class="overview-chart-svg" viewBox="0 0 320 110" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="ovChartGradDisk" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stop-color="#5B8CFF"></stop>
                    <stop offset="100%" stop-color="#8B5CF6"></stop>
                  </linearGradient>
                  <linearGradient id="ovChartAreaGradDisk" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="#5B8CFF" stop-opacity="0.22"></stop>
                    <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0.02"></stop>
                  </linearGradient>
                </defs>
                <path id="ovChartDiskArea" class="ov-chart-area" fill="url(#ovChartAreaGradDisk)" d=""></path>
                <path id="ovChartDiskPath" class="ov-chart-line" stroke="url(#ovChartGradDisk)" d=""></path>
              </svg>
            </article>
          </div>
        </section>
      </div>

      <div class="overview-main-grid overview-main-grid--lower">
        <section class="overview-panel">
          <div class="overview-panel-head">
            <div class="overview-panel-title">
              <div class="overview-panel-icon">${Icons.sized(Icons.hardDrive, 16)}</div>
              <h3>Storage & System Health</h3>
            </div>
            <span class="overview-muted" id="ovHealthSummary">Running diagnostics...</span>
          </div>
          <div class="overview-storage-grid">
            <div class="overview-storage-item"><span>Total Capacity</span><strong id="ovStorageTotal">--</strong></div>
            <div class="overview-storage-item"><span>Estimated V Os Usage</span><strong id="ovStorageUsed">--</strong></div>
            <div class="overview-storage-item"><span>Free Space</span><strong id="ovStorageFree">--</strong></div>
            <div class="overview-storage-item"><span>Fleet Footprint</span><strong id="ovVmStorage">--</strong></div>
          </div>
          <div class="ov-chip-list">
            <div class="ov-chip-row">
              <span>Virtualization</span>
              <span class="ov-status-chip is-neutral" id="ovVirtStatus">Checking</span>
            </div>
            <div class="ov-chip-row">
              <span>Hypervisor Status</span>
              <span class="ov-status-chip is-neutral" id="ovVBoxStatus">Checking</span>
            </div>
            <div class="ov-chip-row">
              <span>Disk Requirement</span>
              <span class="ov-status-chip is-neutral" id="ovDiskStatus">Checking</span>
            </div>
          </div>
        </section>

        <section class="overview-panel">
          <div class="overview-panel-head">
            <div class="overview-panel-title">
              <div class="overview-panel-icon">${Icons.sized(Icons.arrowRight, 16)}</div>
              <h3>Quick Actions</h3>
            </div>
            <span class="overview-muted">Fast paths for daily workflow</span>
          </div>
          <div class="overview-actions-grid">
            <button class="btn btn-primary ov-action-btn" id="ovRunFullScan">${Icons.sized(Icons.search, 14)} Full Scan</button>
            <button class="btn btn-secondary ov-action-btn" id="ovGoMachinesQuick">Open V Os</button>
            <button class="btn btn-secondary ov-action-btn" id="ovGoSnapshots">Open Snapshots</button>
            <button class="btn btn-secondary ov-action-btn" id="ovGoStorage">Open Storage</button>
            <button class="btn btn-secondary ov-action-btn" id="ovGoNetwork">Open Network</button>
            <button class="btn btn-secondary ov-action-btn" id="ovGoLibrary">OS Library</button>
            <button class="btn btn-secondary ov-action-btn" id="ovHostGuide">${Icons.sized(Icons.shield, 14)} Guided Host Fix</button>
            <button class="btn ov-action-btn ov-refresh-btn" id="ovRefreshHealth">${Icons.sized(Icons.refresh, 14)} Refresh Health</button>
          </div>
          <div class="overview-muted" id="ovHostGuideStatus">Guided Host Fix can open Windows blocker settings when needed.</div>
          <div class="overview-host-grid">
            <div><span>Host</span><strong id="ovHostName">--</strong></div>
            <div><span>OS</span><strong id="ovHostOs">--</strong></div>
            <div><span>Arch</span><strong id="ovHostArch">--</strong></div>
            <div><span>CPU</span><strong id="ovHostCpu">--</strong></div>
          </div>
        </section>
      </div>

      <section class="overview-panel">
        <div class="overview-panel-head">
          <div class="overview-panel-title">
            <div class="overview-panel-icon">${Icons.sized(Icons.terminal, 16)}</div>
            <h3>Activity / Logs</h3>
          </div>
          <span class="overview-muted">Recent runtime actions</span>
        </div>
        <div class="overview-activity-list" id="ovActivityTimeline">
          <div class="overview-activity-item is-skeleton"><div class="overview-skeleton-line"></div></div>
          <div class="overview-activity-item is-skeleton"><div class="overview-skeleton-line"></div></div>
        </div>
      </section>
    </div>
  `;
}

async function _initOverview() {
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(value ?? '--');
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const setChip = (id, status = 'neutral', text = 'Unknown') => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('is-pass', 'is-warn', 'is-fail', 'is-neutral');
    const normalized = String(status || 'neutral').toLowerCase();
    if (normalized === 'pass') el.classList.add('is-pass');
    else if (normalized === 'warn' || normalized === 'info') el.classList.add('is-warn');
    else if (normalized === 'fail') el.classList.add('is-fail');
    else el.classList.add('is-neutral');
    el.textContent = text;
  };
  const setHealthBadge = (statusClass = 'is-neutral', text = 'Checking') => {
    const badge = document.getElementById('ovHealthBadgeTop');
    if (badge) {
      badge.classList.remove('is-pass', 'is-warn', 'is-fail', 'is-neutral');
      badge.classList.add(statusClass);
      badge.textContent = text;
    }
    const header = document.getElementById('headerSystemStatus');
    const headerText = document.getElementById('headerSystemStatusText');
    if (header) {
      header.classList.remove('is-pass', 'is-warn', 'is-fail', 'is-neutral');
      header.classList.add(statusClass);
    }
    if (headerText) {
      headerText.textContent = text;
    }
  };
  const setFullScanMeta = (timestamp) => {
    const label = document.getElementById('ovLastFullScan');
    if (!label) return;
    if (!timestamp) {
      label.textContent = 'Full scan: not run';
      return;
    }
    const parsed = new Date(timestamp);
    label.textContent = Number.isNaN(parsed.getTime())
      ? `Full scan: ${String(timestamp)}`
      : `Full scan: ${_formatLocalizedDateTime(parsed)}`;
  };
  const parseNumber = (value) => {
    const match = String(value || '').match(/([\d.]+)/);
    return match ? Number(match[1]) : 0;
  };
  const parseRamValue = (value) => {
    const match = String(value || '').match(/([\d.]+)\s*GB total,\s*([\d.]+)\s*GB free/i);
    if (!match) return null;
    return { total: Number(match[1]), free: Number(match[2]) };
  };
  const getCheck = (checks, name) => checks.find((check) => String(check?.name || '').toLowerCase() === name.toLowerCase());
  const buildSeries = (base, variance, points = 24) => {
    const b = clamp(base, 2, 98);
    return Array.from({ length: points }, (_, i) => {
      const waveA = Math.sin((i + 1) * 0.56) * variance;
      const waveB = Math.cos((i + 1) * 0.24) * (variance * 0.55);
      return clamp(Math.round(b + waveA + waveB), 2, 98);
    });
  };
  const setSpark = (id, samples) => {
    const el = document.getElementById(id);
    if (!el) return;
    const bars = (samples || []).slice(-18);
    el.innerHTML = bars.map((value) => `<span style="height:${clamp(value, 12, 100)}%"></span>`).join('');
  };
  const setChartPath = (id, samples, areaId = null) => {
    const pathEl = document.getElementById(id);
    if (!pathEl || !Array.isArray(samples) || samples.length === 0) return;
    const width = 320;
    const height = 110;
    const step = width / Math.max(1, samples.length - 1);
    const points = samples.map((value, index) => {
      const x = Math.round(index * step);
      const y = Math.round(height - ((clamp(value, 0, 100) / 100) * (height - 8)) - 4);
      return { x, y };
    });
    if (points.length === 1) {
      pathEl.setAttribute('d', `M ${points[0].x} ${points[0].y} L ${points[0].x + 1} ${points[0].y}`);
      if (areaId) {
        const areaEl = document.getElementById(areaId);
        if (areaEl) {
          areaEl.setAttribute('d', `M ${points[0].x} ${points[0].y} L ${points[0].x + 1} ${points[0].y} L ${points[0].x + 1} ${height - 2} L ${points[0].x} ${height - 2} Z`);
        }
      }
      return;
    }
    let d = `M ${points[0].x} ${points[0].y}`;
    if (points.length === 2) {
      d += ` L ${points[1].x} ${points[1].y}`;
    } else {
      for (let i = 1; i < points.length - 1; i += 1) {
        const cx = Math.round((points[i].x + points[i + 1].x) / 2);
        const cy = Math.round((points[i].y + points[i + 1].y) / 2);
        d += ` Q ${points[i].x} ${points[i].y} ${cx} ${cy}`;
      }
      const last = points[points.length - 1];
      d += ` T ${last.x} ${last.y}`;
    }
    pathEl.setAttribute('d', d);
    if (areaId) {
      const areaEl = document.getElementById(areaId);
      if (areaEl) {
        const first = points[0];
        const last = points[points.length - 1];
        areaEl.setAttribute('d', `${d} L ${last.x} ${height - 2} L ${first.x} ${height - 2} Z`);
      }
    }
  };
  const renderActivity = (items) => {
    const timeline = document.getElementById('ovActivityTimeline');
    if (!timeline) return;
    if (!Array.isArray(items) || items.length === 0) {
      timeline.innerHTML = `<div class="overview-empty-inline">No recent activity available.</div>`;
      return;
    }

    timeline.innerHTML = items.map((item) => `
      <div class="overview-activity-item is-${item.level || 'info'}">
        <div class="overview-activity-dot"></div>
        <div class="overview-activity-copy">
          <strong>${item.title}</strong>
          <span>${item.note}</span>
        </div>
        <time>${item.time || '--:--'}</time>
      </div>
    `).join('');
  };
  const renderRunningList = (vms, summary = {}, hostCpu, hostRam) => {
    const container = document.getElementById('ovRunningList');
    if (!container) return;
    const totalCount = Number(summary?.totalCount || 0);
    const inventoryLoaded = summary?.inventoryLoaded !== false;
    const inventoryError = String(summary?.inventoryError || '').trim();

    if (!Array.isArray(vms) || vms.length === 0) {
      if (!inventoryLoaded) {
        container.innerHTML = `
          <div class="overview-empty-state">
            <div class="overview-empty-illustration" aria-hidden="true">
              <span class="overview-empty-ring"></span>
              <span class="overview-empty-ring is-alt"></span>
              <span class="overview-empty-dot"></span>
              <div class="overview-empty-icon">${Icons.sized(Icons.warning, 26)}</div>
            </div>
            <h4>Could not load V Os inventory</h4>
            <p>${inventoryError || 'VirtualBox inventory check failed. Refresh to retry.'}</p>
            <div class="overview-empty-actions">
              <button class="btn btn-primary" data-empty-action="refresh">Refresh Dashboard</button>
              <button class="btn btn-secondary" data-empty-action="open-machines">Open V Os</button>
            </div>
          </div>
        `;
        return;
      }

      if (totalCount > 0) {
        container.innerHTML = `
          <div class="overview-empty-state">
            <div class="overview-empty-illustration" aria-hidden="true">
              <span class="overview-empty-ring"></span>
              <span class="overview-empty-ring is-alt"></span>
              <span class="overview-empty-dot"></span>
              <div class="overview-empty-icon">${Icons.sized(Icons.vm, 26)}</div>
            </div>
            <h4>No active V Os right now</h4>
            <p>${totalCount} V Os detected. Start one from the V Os panel.</p>
            <div class="overview-empty-actions">
              <button class="btn btn-primary" data-empty-action="open-machines">Open V Os</button>
              <button class="btn btn-secondary" data-empty-action="create">Create New V Os</button>
            </div>
          </div>
        `;
        return;
      }

      container.innerHTML = `
        <div class="overview-empty-state">
          <div class="overview-empty-illustration" aria-hidden="true">
            <span class="overview-empty-ring"></span>
            <span class="overview-empty-ring is-alt"></span>
            <span class="overview-empty-dot"></span>
            <div class="overview-empty-icon">${Icons.sized(Icons.vm, 26)}</div>
          </div>
          <h4>No virtual machines found</h4>
          <p>Start by creating a new V Os or importing an existing one.</p>
          <div class="overview-empty-actions">
            <button class="btn btn-primary" data-empty-action="create">Open Setup Wizard</button>
            <button class="btn btn-secondary" data-empty-action="import">Open Import Flow</button>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = vms.slice(0, 8).map((vm) => {
      const state = String(vm.state || 'unknown').toLowerCase();
      const cpuPct = hostCpu > 0 ? clamp(Math.round((Number(vm.cpus || 0) / hostCpu) * 100), 2, 100) : 0;
      const ramPct = hostRam > 0 ? clamp(Math.round(((Number(vm.ram || 0) / 1024) / hostRam) * 100), 2, 100) : 0;
      const statusClass = state === 'running' ? 'is-running' : (state === 'paused' ? 'is-paused' : 'is-stopped');
      const powerAction = state === 'running' || state === 'paused' ? 'stop' : 'start';
      const powerLabel = powerAction === 'stop' ? 'Stop' : 'Start';

      return `
        <article class="overview-vm-row">
          <div class="overview-vm-meta">
            <strong>${vm.name}</strong>
            <span>${vm.os || 'Unknown OS'} · ${vm.cpus || 0} vCPU · ${Math.max(1, Math.round((vm.ram || 0) / 1024))} GB RAM</span>
          </div>
          <div class="overview-vm-usage">
            <div class="overview-vm-bar"><span style="width:${cpuPct}%"></span></div>
            <div class="overview-vm-bar"><span style="width:${ramPct}%"></span></div>
          </div>
          <div class="overview-vm-status ${statusClass}">${state.toUpperCase()}</div>
          <div class="overview-vm-actions">
            <button class="vm-row-action" data-vm-action="${powerAction}" data-vm-name="${vm.name}">${powerLabel}</button>
            <button class="vm-row-action" data-vm-action="open" data-vm-name="${vm.name}">Open</button>
            <button class="vm-row-action" data-vm-action="snapshot" data-vm-name="${vm.name}">Snapshot</button>
          </div>
        </article>
      `;
    }).join('');
  };
  const metricHistory = { cpu: [], ram: [], disk: [] };
  let lastRealtimeMetrics = null;
  let realtimeRefreshing = false;
  let lastOverviewCpuPct = 0;
  const formatDiskRate = (valueMbPerSec) => {
    const value = Number(valueMbPerSec || 0);
    if (!Number.isFinite(value) || value <= 0) return '0 KB/s';
    if (value >= 1) return `${value.toFixed(1)} MB/s`;
    return `${Math.max(1, Math.round(value * 1024))} KB/s`;
  };
  const formatNetworkRate = (valueMbps) => {
    const value = Number(valueMbps || 0);
    if (!Number.isFinite(value) || value <= 0) return '0 Kbps';
    if (value >= 1) return `${value.toFixed(1)} Mbps`;
    return `${Math.max(1, Math.round(value * 1000))} Kbps`;
  };

  const applyRealtimeMetrics = (incomingMetrics, options = {}) => {
    const keepLast = options.keepLast !== false;
    const hasFresh = !!(incomingMetrics && incomingMetrics.success);
    if (hasFresh) {
      lastRealtimeMetrics = incomingMetrics;
    }

    const realtime = hasFresh
      ? incomingMetrics
      : (keepLast ? lastRealtimeMetrics : null);
    const hasRealtime = !!realtime;
    appState.realtimeMetrics = realtime || null;

    const diskRead = hasRealtime ? Number(realtime.diskReadBytesPerSec || 0) / (1024 * 1024) : 0;
    const diskWrite = hasRealtime ? Number(realtime.diskWriteBytesPerSec || 0) / (1024 * 1024) : 0;
    const netDown = hasRealtime ? (Number(realtime.netRxBytesPerSec || 0) * 8) / 1000000 : 0;
    const netUp = hasRealtime ? (Number(realtime.netTxBytesPerSec || 0) * 8) / 1000000 : 0;
    const liveCpuPct = hasRealtime ? clamp(Math.round(Number(realtime.cpuLoadPercent || 0)), 0, 100) : null;
    const liveRamPct = hasRealtime ? clamp(Math.round(Number(realtime.memoryUsagePercent || 0)), 0, 100) : null;
    const liveTotalRamGb = hasRealtime ? Number(realtime.totalMemoryGb || 0) : 0;
    const liveUsedRamGb = hasRealtime ? Number(realtime.usedMemoryGb || 0) : 0;
    const totalDiskRate = diskRead + diskWrite;
    const hostAdapterCount = hasRealtime && Array.isArray(realtime.adapters) ? realtime.adapters.length : 0;
    if (hasRealtime && Number.isFinite(liveCpuPct)) {
      lastOverviewCpuPct = liveCpuPct;
      setText('ovMetricCpu', `${liveCpuPct}%`);
      setText('ovMetricCpuSub', 'Live host CPU load');
      setText('ovChartCpuValue', `${liveCpuPct}%`);
      metricHistory.cpu.push(liveCpuPct);
      if (metricHistory.cpu.length > 32) metricHistory.cpu.shift();
      const cpuSeries = metricHistory.cpu.length > 3
        ? metricHistory.cpu.slice(-24)
        : buildSeries(liveCpuPct, 10);
      setSpark('ovCpuSpark', cpuSeries);
      setChartPath('ovChartCpuPath', cpuSeries, 'ovChartCpuArea');
    }
    if (hasRealtime && Number.isFinite(liveRamPct)) {
      setText('ovMetricRam', `${liveRamPct}%`);
      setText(
        'ovMetricRamSub',
        liveTotalRamGb > 0
          ? `${Math.max(0, liveUsedRamGb).toFixed(1)} GB / ${liveTotalRamGb.toFixed(1)} GB host used`
          : 'Live host memory usage'
      );
      setText(
        'ovChartRamValue',
        liveTotalRamGb > 0
          ? `${Math.max(0, liveUsedRamGb).toFixed(1)} GB used`
          : `${liveRamPct}% used`
      );
      metricHistory.ram.push(liveRamPct);
      if (metricHistory.ram.length > 32) metricHistory.ram.shift();
      const ramSeries = metricHistory.ram.length > 3
        ? metricHistory.ram.slice(-24)
        : buildSeries(liveRamPct, 8);
      setSpark('ovRamSpark', ramSeries);
      setChartPath('ovChartRamPath', ramSeries, 'ovChartRamArea');
    }
    _setSystemFlowActivity({
      cpuUsage: Number.isFinite(liveCpuPct) ? liveCpuPct : lastOverviewCpuPct,
      netMbps: netDown + netUp,
      diskMBps: totalDiskRate
    });

    setText('ovMetricDiskIo', `${formatDiskRate(diskRead)} / ${formatDiskRate(diskWrite)}`);
    setText('ovMetricNetwork', `${formatNetworkRate(netDown)} / ${formatNetworkRate(netUp)}`);

    if (hasFresh) {
      setText('ovMetricDiskTrend', 'Live host disk I/O from computer counters');
      setText(
        'ovMetricNetworkTrend',
        hostAdapterCount > 0
          ? `Live host network traffic (${hostAdapterCount} non-virtual adapter${hostAdapterCount === 1 ? '' : 's'})`
          : 'Live host network counters (no active adapter traffic yet)'
      );
    } else if (hasRealtime) {
      setText('ovMetricDiskTrend', 'Using last known host disk telemetry');
      setText('ovMetricNetworkTrend', 'Using last known host network telemetry');
    } else {
      setText('ovMetricDiskTrend', 'Waiting for realtime disk telemetry');
      setText('ovMetricNetworkTrend', 'Waiting for realtime network telemetry');
    }

    setText('ovChartDiskValue', formatDiskRate(totalDiskRate));
    metricHistory.disk.push(hasRealtime ? clamp(Math.round(totalDiskRate * 2), 0, 100) : 0);
    if (metricHistory.disk.length > 32) metricHistory.disk.shift();
    const diskSeries = metricHistory.disk.length > 3
      ? metricHistory.disk.slice(-24)
      : buildSeries(hasRealtime ? clamp(Math.round(totalDiskRate * 2), 1, 90) : 2, 12);
    setChartPath('ovChartDiskPath', diskSeries, 'ovChartDiskArea');
  };

  const refreshRealtimeOnly = async () => {
    if (realtimeRefreshing) return;
    realtimeRefreshing = true;
    try {
      const realtime = await window.vmInstaller.getRealtimeMetrics?.();
      applyRealtimeMetrics(realtime, { keepLast: true });
    } catch {
      applyRealtimeMetrics(null, { keepLast: true });
    } finally {
      realtimeRefreshing = false;
    }
  };

  const refreshBtn = document.getElementById('ovRefreshHealth');
  const hostGuideBtn = document.getElementById('ovHostGuide');
  const fullScanBtn = document.getElementById('ovRunFullScan');
  const setHostGuideStatus = (text) => {
    const el = document.getElementById('ovHostGuideStatus');
    if (!el) return;
    el.textContent = String(text || '').trim() || 'Guided Host Fix can open Windows blocker settings when needed.';
  };
  let hostGuideState = {
    platform: 'unknown',
    isAdmin: false,
    hasDriverIssue: false,
    hasHypervisorConflict: false,
    hasMemoryIntegrityConflict: false,
    hasRuntimeIssue: false,
    hasPendingReboot: false,
    hasAnyIssue: false,
    primaryMessage: ''
  };
  setFullScanMeta(_loadUiPrefs()?.lastFullScanAt || '');
  const runningList = document.getElementById('ovRunningList');
  if (runningList && !runningList.dataset.wired) {
    runningList.dataset.wired = '1';
    runningList.addEventListener('click', async (event) => {
      const emptyAction = event.target.closest('[data-empty-action]');
      if (emptyAction) {
        const action = emptyAction.getAttribute('data-empty-action');
        if (action === 'create') app.showWizard();
        if (action === 'import') _openImportWizard();
        if (action === 'open-machines') app.showMachines();
        if (action === 'refresh') safeRefresh({ withSpinner: true });
        return;
      }

      const actionBtn = event.target.closest('[data-vm-action]');
      if (!actionBtn) return;
      const vmName = actionBtn.getAttribute('data-vm-name') || '';
      const action = actionBtn.getAttribute('data-vm-action');
      if (!vmName || !action) return;

      actionBtn.disabled = true;
      try {
        if (action === 'start') {
          const result = await window.vmInstaller.startVM(vmName);
          if (!result?.success) _notify(result?.error || `Could not start ${vmName}`, 'error');
        } else if (action === 'stop') {
          const result = await window.vmInstaller.stopVM(vmName);
          if (!result?.success) _notify(result?.error || `Could not stop ${vmName}`, 'error');
        } else if (action === 'open') {
          app.showMachines();
        } else if (action === 'snapshot') {
          _notify('Open the V Os panel to create or restore snapshots.', 'info');
          app.showMachines();
        }
      } finally {
        actionBtn.disabled = false;
        if (action === 'start' || action === 'stop') {
          safeRefresh({ withSpinner: false });
        }
      }
    });
  }

  const runOverviewRefresh = async ({ withSpinner = true } = {}) => {
    if (refreshBtn && withSpinner) {
      refreshBtn.disabled = true;
      refreshBtn.innerHTML = `${Icons.sized(Icons.spinner, 14)} Refreshing...`;
    }

    setHealthBadge('is-neutral', 'Refreshing');

    const [vmResult, systemResult, permissionsResult] = await Promise.allSettled([
      window.vmInstaller.listVMs(),
      window.vmInstaller.checkSystem(appState.installPath || appState.defaults?.defaultInstallPath || ''),
      window.vmInstaller.checkPermissions?.()
    ]);

    const vmData = vmResult.status === 'fulfilled' ? vmResult.value : null;
    const allVms = vmData?.success && Array.isArray(vmData.vms) ? vmData.vms : [];
    const runningVms = allVms.filter((vm) => ['running', 'paused'].includes(String(vm.state || '').toLowerCase()));

    const report = systemResult.status === 'fulfilled' && systemResult.value?.checks
      ? systemResult.value
      : null;

    const checks = Array.isArray(report?.checks) ? report.checks : [];
    const permissions = permissionsResult.status === 'fulfilled' ? permissionsResult.value : null;
    const permissionChecks = Array.isArray(permissions?.checks) ? permissions.checks : [];
    const permissionDriverIssue = permissionChecks.find((check) => {
      const name = String(check?.name || '').toLowerCase();
      const status = String(check?.status || '').toLowerCase();
      return name === 'vbox kernel driver' && ['required', 'unavailable', 'warning', 'fail'].includes(status);
    });
    const hostBlockers = permissions?.hostBlockers || {};
    const hostSignals = permissions?.hostSignals || {};
    const detectedPlatform = String(permissions?.platform || '').toLowerCase()
      || (String(navigator?.platform || '').toLowerCase().includes('win') ? 'win32' : 'unknown');
    const fallbackHypervisorConflict = detectedPlatform === 'win32'
      && (
        String(hostSignals?.hyperV || '').toLowerCase() === 'enabled'
        || String(hostSignals?.hypervisorPlatform || '').toLowerCase() === 'enabled'
        || String(hostSignals?.virtualMachinePlatform || '').toLowerCase() === 'enabled'
      );
    const fallbackMemoryIntegrityConflict = detectedPlatform === 'win32'
      && hostSignals?.memoryIntegrityEnabled === true;
    const hasDriverIssue = typeof hostBlockers?.hasDriverIssue === 'boolean'
      ? hostBlockers.hasDriverIssue
      : !!permissionDriverIssue;
    const hasHypervisorConflict = typeof hostBlockers?.hasHypervisorConflict === 'boolean'
      ? hostBlockers.hasHypervisorConflict
      : fallbackHypervisorConflict;
    const hasMemoryIntegrityConflict = typeof hostBlockers?.hasMemoryIntegrityConflict === 'boolean'
      ? hostBlockers.hasMemoryIntegrityConflict
      : fallbackMemoryIntegrityConflict;
    const hasRuntimeIssue = hostBlockers?.hasRuntimeIssue === true;
    const hasPendingReboot = hostBlockers?.hasPendingReboot === true;
    const hasAnyIssue = hasDriverIssue || hasHypervisorConflict || hasMemoryIntegrityConflict || hasRuntimeIssue || hasPendingReboot;
    hostGuideState = {
      platform: detectedPlatform,
      isAdmin: permissions?.isAdmin === true,
      hasDriverIssue,
      hasHypervisorConflict,
      hasMemoryIntegrityConflict,
      hasRuntimeIssue,
      hasPendingReboot,
      hasAnyIssue,
      primaryMessage: String(hostBlockers?.primaryMessage || '').trim()
    };
    if (hostGuideBtn) {
      hostGuideBtn.classList.remove('btn-primary', 'btn-secondary');
      hostGuideBtn.classList.add(hostGuideState.hasAnyIssue ? 'btn-primary' : 'btn-secondary');
      hostGuideBtn.innerHTML = hostGuideState.hasAnyIssue
        ? `${Icons.sized(Icons.shield, 14)} Guided Host Fix (Needed)`
        : `${Icons.sized(Icons.shield, 14)} Guided Host Fix`;
    }
    if (hostGuideState.platform !== 'win32') {
      setHostGuideStatus('Guided Host Fix is for Windows hosts.');
    } else if (hostGuideState.hasAnyIssue) {
      const issues = [];
      if (hostGuideState.hasHypervisorConflict) issues.push('turn off Hyper-V stack');
      if (hostGuideState.hasMemoryIntegrityConflict) issues.push('turn off Memory Integrity');
      if (hostGuideState.hasDriverIssue) issues.push('repair VBox driver');
      if (hostGuideState.hasRuntimeIssue && !hostGuideState.hasDriverIssue) issues.push('repair VirtualBox runtime');
      if (hostGuideState.hasPendingReboot) issues.push('restart Windows');
      if (issues.length > 0) {
        setHostGuideStatus(`Host fix needed: ${issues.join(' · ')}. Click Guided Host Fix and follow the steps.`);
      } else {
        setHostGuideStatus(hostGuideState.primaryMessage || 'Host attention is needed. Click Guided Host Fix and follow the steps.');
      }
    } else {
      setHostGuideStatus('Host virtualization checks look healthy.');
    }
    const sysInfo = report?.systemInfo || {};
    const cpuCheck = getCheck(checks, 'CPU Cores');
    const ramCheck = getCheck(checks, 'System RAM');
    const diskCheck = getCheck(checks, 'Disk Space');
    const virtCheck = getCheck(checks, 'CPU Virtualization (VT-x / AMD-V)');
    const vboxCheck = getCheck(checks, 'VirtualBox');
    const ramFromValue = parseRamValue(ramCheck?.value);
    const hostCpu = Number(sysInfo.cpuCount || parseNumber(cpuCheck?.value) || 4);
    const totalRam = Number(sysInfo.totalRAM || ramFromValue?.total || 0);
    const freeRam = Number(sysInfo.freeRAM || ramFromValue?.free || 0);

    const allocatedCpu = runningVms.reduce((sum, vm) => sum + Number(vm.cpus || 0), 0);
    const runningRamGb = runningVms.reduce((sum, vm) => sum + (Number(vm.ram || 0) / 1024), 0);
    const liveCpuPct = Number(appState.realtimeMetrics?.cpuLoadPercent);
    const liveRamPct = Number(appState.realtimeMetrics?.memoryUsagePercent);
    const liveTotalRam = Number(appState.realtimeMetrics?.totalMemoryGb);
    const liveUsedRam = Number(appState.realtimeMetrics?.usedMemoryGb);

    const hasLiveCpu = Number.isFinite(liveCpuPct) && liveCpuPct >= 0;
    const hasLiveRam = Number.isFinite(liveRamPct) && liveRamPct >= 0;
    const hasLiveRamTotals = Number.isFinite(liveTotalRam) && liveTotalRam > 0 && Number.isFinite(liveUsedRam) && liveUsedRam >= 0;

    const cpuUsagePct = hasLiveCpu
      ? clamp(Math.round(liveCpuPct), 0, 100)
      : (runningVms.length === 0 ? 0 : clamp(Math.round((allocatedCpu / Math.max(hostCpu, 1)) * 62 + (runningVms.length * 6)), 6, 96));
    lastOverviewCpuPct = cpuUsagePct;
    const ramUsagePct = hasLiveRam
      ? clamp(Math.round(liveRamPct), 0, 100)
      : (totalRam > 0 ? clamp(Math.round((runningRamGb / totalRam) * 100), 2, 98) : 0);
    const displayTotalRam = hasLiveRamTotals ? liveTotalRam : totalRam;
    const displayUsedRam = hasLiveRamTotals
      ? liveUsedRam
      : (totalRam > 0 ? Math.max(0, totalRam - freeRam) : runningRamGb);
    const diskFreeGb = parseNumber(diskCheck?.value);
    const estimatedVmStorage = allVms.reduce((sum, vm) => sum + Math.max(8, Math.round((Number(vm.ram || 0) || 1024) / 192)), 0);
    const storageTotal = diskFreeGb > 0 ? Math.round(diskFreeGb + estimatedVmStorage) : 0;
    setText('ovMetricActive', runningVms.length);
    setText('ovRunningCountLabel', `${runningVms.length} active of ${allVms.length} total`);
    setText('ovMetricCpu', `${cpuUsagePct}%`);
    setText(
      'ovMetricCpuSub',
      hasLiveCpu
        ? `Live host CPU load · ${allocatedCpu}/${Math.max(hostCpu, 1)} vCPU assigned to active V Os`
        : `${allocatedCpu}/${Math.max(hostCpu, 1)} vCPU in active use`
    );
    setText('ovMetricRam', (hasLiveRam || displayTotalRam > 0) ? `${ramUsagePct}%` : '--');
    setText(
      'ovMetricRamSub',
      displayTotalRam > 0
        ? `${displayUsedRam.toFixed(1)} GB / ${displayTotalRam.toFixed(1)} GB host used`
        : 'Memory data unavailable'
    );

    setText('ovChartCpuValue', `${cpuUsagePct}%`);
    setText('ovChartRamValue', displayTotalRam > 0 ? `${displayUsedRam.toFixed(1)} GB used` : 'Unknown');

    metricHistory.cpu.push(cpuUsagePct);
    metricHistory.ram.push(ramUsagePct);
    if (metricHistory.cpu.length > 32) metricHistory.cpu.shift();
    if (metricHistory.ram.length > 32) metricHistory.ram.shift();

    const cpuSeries = metricHistory.cpu.length > 3
      ? metricHistory.cpu.slice(-24)
      : buildSeries(cpuUsagePct, runningVms.length > 0 ? 12 : 4);
    const ramSeries = metricHistory.ram.length > 3
      ? metricHistory.ram.slice(-24)
      : buildSeries(ramUsagePct, 8);
    setSpark('ovCpuSpark', cpuSeries);
    setSpark('ovRamSpark', ramSeries);
    setChartPath('ovChartCpuPath', cpuSeries, 'ovChartCpuArea');
    setChartPath('ovChartRamPath', ramSeries, 'ovChartRamArea');
    applyRealtimeMetrics(null, { keepLast: true });

    renderRunningList(
      runningVms,
      {
        totalCount: allVms.length,
        inventoryLoaded: vmData?.success === true,
        inventoryError: vmData?.error || ''
      },
      Math.max(hostCpu, 1),
      totalRam
    );

    setText('ovStorageTotal', storageTotal > 0 ? `${storageTotal} GB` : '--');
    setText('ovStorageUsed', `${estimatedVmStorage} GB`);
    setText('ovStorageFree', diskFreeGb > 0 ? `${diskFreeGb} GB` : 'Unknown');
    setText('ovVmStorage', `${allVms.length} V Os · est ${estimatedVmStorage} GB`);

    const realtime = appState.realtimeMetrics;
    const hasRealtime = !!realtime;
    const diskRead = hasRealtime ? Number(realtime.diskReadBytesPerSec || 0) / (1024 * 1024) : 0;
    const diskWrite = hasRealtime ? Number(realtime.diskWriteBytesPerSec || 0) / (1024 * 1024) : 0;
    const netDown = hasRealtime ? (Number(realtime.netRxBytesPerSec || 0) * 8) / 1000000 : 0;
    const netUp = hasRealtime ? (Number(realtime.netTxBytesPerSec || 0) * 8) / 1000000 : 0;

    const activityItems = [
      {
        level: 'info',
        title: `Inventory synced: ${allVms.length} V Os detected`,
        note: hasRealtime ? `Realtime I/O ${diskRead.toFixed(1)}/${diskWrite.toFixed(1)} MB/s · Net ${netDown.toFixed(1)}/${netUp.toFixed(1)} Mbps` : `${runningVms.length} active sessions`,
        time: _formatLocalizedTime(Date.now())
      }
    ];

    if (!report) {
      setHealthBadge('is-warn', 'Diagnostics unavailable');
      setText('ovHealthSummary', 'Unable to fetch host diagnostics right now.');
      setText('ovLastChecked', 'Last update: --');
      setChip('ovVirtStatus', 'neutral', 'Unknown');
      setChip('ovVBoxStatus', 'neutral', 'Unknown');
      setChip('ovDiskStatus', 'neutral', 'Unknown');
      renderActivity(activityItems);
      if (refreshBtn && withSpinner) {
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = `${Icons.sized(Icons.refresh, 14)} Refresh Health`;
      }
      return;
    }

    appState.systemReport = report;
    const passCount = checks.filter((check) => check.status === 'pass').length;
    const warnCount = checks.filter((check) => check.status === 'warn' || check.status === 'info').length;
    const failCount = checks.filter((check) => check.status === 'fail').length;

    let healthText = 'Healthy';
    let healthClass = 'is-pass';
    if (failCount > 0) {
      healthText = 'Needs Attention';
      healthClass = 'is-fail';
    } else if (warnCount > 0) {
      healthText = 'Stable with Warnings';
      healthClass = 'is-warn';
    }

    setHealthBadge(healthClass, healthText);
    setText('ovHealthSummary', `${passCount} passed · ${warnCount} warnings · ${failCount} failed`);
    setText('ovLastChecked', `Last update: ${_formatLocalizedTime(report.timestamp || Date.now())}`);
    setChip('ovVirtStatus', virtCheck?.status, virtCheck?.status === 'pass' ? 'ENABLED' : 'CHECK BIOS');
    setChip('ovVBoxStatus', vboxCheck?.status, report.vboxInstalled ? 'RUNNING' : 'MISSING');
    setChip('ovDiskStatus', diskCheck?.status, (diskCheck?.status || 'unknown').toUpperCase());
    setText('ovHostName', sysInfo.hostname || '--');
    setText('ovHostOs', `${String(sysInfo.os || 'Unknown').toUpperCase()} ${sysInfo.osVersion || ''}`.trim());
    setText('ovHostArch', sysInfo.arch || '--');
    setText('ovHostCpu', sysInfo.cpuModel || cpuCheck?.value || '--');

    const warnings = checks
      .filter((check) => ['warn', 'fail', 'info'].includes(String(check.status || '').toLowerCase()))
      .slice(0, 3)
      .map((check) => ({
        level: check.status === 'fail' ? 'error' : 'warn',
        title: `${check.name}: ${String(check.status || '').toUpperCase()}`,
        note: check.message || check.value || 'No details',
        time: _formatLocalizedTime(report.timestamp || Date.now())
      }));
    renderActivity([...activityItems, ...warnings]);

    if (refreshBtn && withSpinner) {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = `${Icons.sized(Icons.refresh, 14)} Refresh Health`;
    }
  };

  document.getElementById('ovGoMachines')?.addEventListener('click', () => app.showMachines());
  document.getElementById('ovGoMachinesQuick')?.addEventListener('click', () => app.showMachines());
  document.getElementById('ovGoSnapshots')?.addEventListener('click', () => app.showSnapshots());
  document.getElementById('ovGoStorage')?.addEventListener('click', () => app.showStorage());
  document.getElementById('ovGoNetwork')?.addEventListener('click', () => app.showNetwork());
  document.getElementById('ovGoLibrary')?.addEventListener('click', () => app.showLibrary());
  let refreshing = false;
  const safeRefresh = async (options = {}) => {
    if (refreshing) return;
    refreshing = true;
    try {
      await runOverviewRefresh(options);
      await refreshRealtimeOnly();
    } finally {
      refreshing = false;
    }
  };
  document.getElementById('ovRefreshHealth')?.addEventListener('click', () => {
    safeRefresh();
  });
  document.getElementById('ovHostGuide')?.addEventListener('click', async () => {
    const btn = document.getElementById('ovHostGuide');
    const originalText = btn?.innerHTML || `${Icons.sized(Icons.shield, 14)} Guided Host Fix`;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `${Icons.sized(Icons.spinner, 14)} Opening guide...`;
    }
    try {
      await safeRefresh({ withSpinner: false });

      if (String(hostGuideState.platform || '').toLowerCase() !== 'win32') {
        _notify('Guided Host Fix is available on Windows hosts only.', 'info');
        return;
      }

      if (!hostGuideState.hasAnyIssue) {
        _notify('No host blockers were detected. Try starting your V Os now.', 'success');
        return;
      }

      if (!hostGuideState.isAdmin) {
        window.vmxAdminAccess?.focus?.('Guided host fix runs best with administrator mode.');
        _notify('Step 1: Click "Continue with Admin Privilege" first.', 'info');
      }

      if (hostGuideState.hasHypervisorConflict) {
        const disableResult = await window.vmInstaller.runHostRecoveryAction('disable-hypervisor-stack');
        if (disableResult?.success) {
          _notify('Step 2 complete: Hyper-V stack was disabled.', 'success');
        } else if (disableResult?.requiresAdmin) {
          _notify(disableResult?.message || 'Administrator mode is required to disable Hyper-V blockers automatically.', 'info');
        } else {
          _notify(disableResult?.message || 'Could not disable Hyper-V blockers automatically. Opening Windows Features...', 'info');
        }

        const featuresResult = await window.vmInstaller.runHostRecoveryAction('open-windows-features');
        if (featuresResult?.success) {
          _notify('Step 3: In Windows Features, uncheck Hyper-V, Virtual Machine Platform, and Windows Hypervisor Platform.', 'info');
        }
      }

      if (hostGuideState.hasMemoryIntegrityConflict) {
        const coreIsoResult = await window.vmInstaller.runHostRecoveryAction('open-core-isolation');
        if (coreIsoResult?.success) {
          _notify('Step 4: Turn Memory Integrity OFF, then return to VM Xposed.', 'info');
        } else {
          _notify(coreIsoResult?.message || 'Could not open Core Isolation settings.', 'error');
        }
      }

      if (hostGuideState.hasDriverIssue && !hostGuideState.hasHypervisorConflict && !hostGuideState.hasMemoryIntegrityConflict) {
        const driverResult = await window.vmInstaller.fixDriver();
        if (driverResult?.success) {
          _notify(driverResult.message || 'VBox driver is now ready.', 'success');
        } else if (driverResult?.requiresAdmin) {
          _notify(driverResult.message || 'Administrator mode is required to fix the VBox driver.', 'info');
        } else {
          _notify(driverResult?.message || 'VBox driver still needs attention. Use Prepare Host from V Os page if needed.', 'error');
        }
      }

      if (hostGuideState.hasRuntimeIssue && !hostGuideState.hasDriverIssue && !hostGuideState.hasHypervisorConflict && !hostGuideState.hasMemoryIntegrityConflict) {
        const prepareResult = await window.vmInstaller.prepareHostRecovery();
        if (prepareResult?.success) {
          _notify(prepareResult.message || 'Host recovery checks completed.', 'success');
        } else if (prepareResult?.requiresAdmin) {
          _notify(prepareResult?.message || 'Administrator mode is required for runtime recovery actions.', 'info');
        } else {
          _notify(prepareResult?.message || 'Host runtime still needs attention. Open the V Os page and use Prepare Host.', 'error');
        }
      }

      if (hostGuideState.hasPendingReboot) {
        _notify('Windows restart is pending. Reboot first, then retry Start V Os.', 'info');
      }

      _notify('Final step: Restart Windows, open VM Xposed, then press Start V Os.', 'success');
    } catch (err) {
      _notify(err?.message || 'Guided host fix failed.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
      await safeRefresh({ withSpinner: false });
    }
  });

  fullScanBtn?.addEventListener('click', async () => {
    if (fullScanBtn.disabled) return;
    if (!window.vmInstaller?.fullSystemScan) {
      _notify('Full scan is unavailable in this build.', 'error');
      return;
    }

    const originalText = fullScanBtn.innerHTML;
    fullScanBtn.disabled = true;
    fullScanBtn.innerHTML = `${Icons.sized(Icons.spinner, 14)} Scanning...`;
    setHealthBadge('is-neutral', 'Running full scan');

    try {
      const result = await window.vmInstaller.fullSystemScan();
      if (!result?.success) {
        _notify(result?.error || 'Full scan failed.', 'error');
        return;
      }

      const prefs = result.prefs || {};
      const normalizedScanPrefs = _saveUiPrefs(prefs);
      appState.installPath = normalizedScanPrefs.installPath || appState.installPath;
      appState.downloadPath = normalizedScanPrefs.downloadPath || appState.downloadPath;
      appState.sharedFolderPath = normalizedScanPrefs.sharedFolderPath || appState.sharedFolderPath;
      appState.startFullscreen = normalizedScanPrefs.startFullscreen !== false;
      appState.accelerate3d = normalizedScanPrefs.accelerate3d === true;
      appState.enableSharedFolder = normalizedScanPrefs.enableSharedFolder === undefined
        ? !!appState.sharedFolderPath
        : !!normalizedScanPrefs.enableSharedFolder;
      appState.defaultUserUsername = normalizedScanPrefs.defaultUserUsername || appState.defaultUserUsername || 'user';
      appState.defaultUserPassword = String(normalizedScanPrefs.defaultUserPassword ?? appState.defaultUserPassword ?? 'user');
      appState.guestUsername = normalizedScanPrefs.guestUsername || appState.guestUsername || 'guest';
      appState.guestPassword = String(normalizedScanPrefs.guestPassword ?? appState.guestPassword ?? 'guest');
      if (!appState.defaultUserPassword) appState.defaultUserPassword = 'user';
      if (!appState.guestPassword) appState.guestPassword = 'guest';
      appState.startupView = normalizedScanPrefs.startupView || appState.startupView || 'dashboard';
      appState.language = normalizedScanPrefs.language || appState.language;
      appState.notificationLevel = normalizedScanPrefs.notificationLevel || appState.notificationLevel;
      appState.adminModePolicy = normalizedScanPrefs.adminModePolicy || appState.adminModePolicy;
      appState.autoRepairLevel = normalizedScanPrefs.autoRepairLevel || appState.autoRepairLevel;
      appState.maxHostRamPercent = normalizedScanPrefs.maxHostRamPercent || appState.maxHostRamPercent || 75;
      appState.maxHostCpuPercent = normalizedScanPrefs.maxHostCpuPercent || appState.maxHostCpuPercent || 75;
      appState.vmDefaultPreset = normalizedScanPrefs.vmDefaultPreset || appState.vmDefaultPreset || 'balanced';
      appState.credentialStorage = normalizedScanPrefs.credentialStorage || appState.credentialStorage || 'keychain';
      appState.telemetryEnabled = normalizedScanPrefs.telemetryEnabled === true;
      appState.trustedPaths = String(normalizedScanPrefs.trustedPaths || appState.trustedPaths || '');
      appState.logLevel = normalizedScanPrefs.logLevel || appState.logLevel || 'info';
      appState.logRetentionDays = normalizedScanPrefs.logRetentionDays || appState.logRetentionDays || 14;
      const activeAccountType = appState.accountType === 'user' ? 'user' : 'guest';
      appState.username = activeAccountType === 'user' ? appState.defaultUserUsername : appState.guestUsername;
      appState.password = activeAccountType === 'user' ? appState.defaultUserPassword : appState.guestPassword;
      _applyLanguagePreference(appState.language);
      _clampSetupResourcesToPolicy(appState);
      applyVisualEffectsModeFromSettings();
      if (result.systemReport) {
        appState.systemReport = result.systemReport;
      }

      setFullScanMeta(result.timestamp || prefs.lastFullScanAt || '');
      const partitionCount = Array.isArray(result.partitions) ? result.partitions.length : 0;
      const vmPathCount = Array.isArray(result.detectedVmPaths) ? result.detectedVmPaths.length : 0;
      const warningCount = Array.isArray(result.warnings) ? result.warnings.length : 0;
      _notify(
        `Full scan complete. ${partitionCount} partition(s) analyzed, ${vmPathCount} V Os path(s) detected${warningCount ? `, ${warningCount} warning(s).` : '.'}`,
        warningCount ? 'info' : 'success'
      );
      await safeRefresh({ withSpinner: false });
    } catch (err) {
      _notify(`Full scan failed: ${err?.message || 'Unknown error'}`, 'error');
    } finally {
      fullScanBtn.disabled = false;
      fullScanBtn.innerHTML = originalText;
    }
  });

  await safeRefresh();
  _setRealtimePanelTimer(() => {
    if (appState.currentView === 'dashboard' && !appState.isRunning) {
      refreshRealtimeOnly();
    }
  }, 1200);
}

function _renderSnapshots() {
  return `
    <div class="dashboard">
      <div class="dashboard-header">
        <div class="dashboard-title-group">
          <h2 class="dashboard-title">Snapshots</h2>
          <span class="dashboard-subtitle">Create, restore, and remove V Os checkpoints safely.</span>
        </div>
        <div class="dashboard-actions">
          <button class="btn btn-secondary" id="btnSnapshotRefresh">${Icons.sized(Icons.refresh, 14)} Refresh</button>
        </div>
      </div>

      <div class="overview-panel">
        <div class="overview-actions-grid" style="grid-template-columns: minmax(220px, 300px) 1fr auto;">
          <select class="form-select" id="snapVmSelect"></select>
          <input class="form-input" id="snapNameInput" placeholder="Snapshot name (e.g., Before update)" />
          <button class="btn btn-primary" id="btnCreateSnapshot">Create Snapshot</button>
        </div>
      </div>

      <div class="overview-panel">
        <div class="overview-panel-head">
          <div class="overview-panel-title">
            <div class="overview-panel-icon">${Icons.sized(Icons.copy, 16)}</div>
            <h3>Snapshot Timeline</h3>
          </div>
          <span class="overview-muted" id="snapMeta">Loading...</span>
        </div>
        <div class="overview-activity-list" id="snapList"></div>
      </div>
    </div>
  `;
}

async function _initSnapshots() {
  const vmSelect = document.getElementById('snapVmSelect');
  const snapList = document.getElementById('snapList');
  const snapMeta = document.getElementById('snapMeta');
  const snapNameInput = document.getElementById('snapNameInput');

  const renderSnapshotItems = (items, vmName) => {
    if (!snapList) return;
    if (!items || items.length === 0) {
      snapList.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'overview-empty-inline';
      empty.textContent = `No snapshots found for ${vmName || 'this V Os'}.`;
      snapList.appendChild(empty);
      return;
    }

    snapList.innerHTML = '';
    items.forEach((snap) => {
      const item = document.createElement('div');
      item.className = `overview-activity-item ${snap.isCurrent ? 'is-info' : ''}`.trim();

      const dot = document.createElement('div');
      dot.className = 'overview-activity-dot';

      const copy = document.createElement('div');
      copy.className = 'overview-activity-copy';

      const title = document.createElement('strong');
      title.textContent = String(snap.name || snap.id || 'Snapshot');

      const subtitle = document.createElement('span');
      subtitle.textContent = String(
        snap.description || (snap.timestamp ? _formatLocalizedDateTime(snap.timestamp) : 'No description')
      );

      copy.appendChild(title);
      copy.appendChild(subtitle);

      const actions = document.createElement('div');
      actions.className = 'overview-vm-actions';

      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'vm-row-action';
      restoreBtn.textContent = 'Restore';
      restoreBtn.setAttribute('data-snap-action', 'restore');
      restoreBtn.setAttribute('data-snap-ref', String(snap.id || snap.name || ''));
      restoreBtn.setAttribute('data-vm-name', String(vmName || ''));

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'vm-row-action';
      deleteBtn.textContent = 'Delete';
      deleteBtn.setAttribute('data-snap-action', 'delete');
      deleteBtn.setAttribute('data-snap-ref', String(snap.id || snap.name || ''));
      deleteBtn.setAttribute('data-vm-name', String(vmName || ''));

      actions.appendChild(restoreBtn);
      actions.appendChild(deleteBtn);

      item.appendChild(dot);
      item.appendChild(copy);
      item.appendChild(actions);

      snapList.appendChild(item);
    });
  };

  const loadSnapshots = async () => {
    const vmName = String(vmSelect?.value || '');
    if (!vmName) {
      if (snapMeta) snapMeta.textContent = 'No V Os selected';
      if (snapList) snapList.innerHTML = `<div class="overview-empty-inline">Select a V Os to view snapshots.</div>`;
      return;
    }
    if (snapMeta) snapMeta.textContent = `Loading snapshots for ${vmName}...`;
    const result = await window.vmInstaller.listSnapshots(vmName);
    if (!result?.success) {
      if (snapMeta) snapMeta.textContent = 'Snapshot listing failed';
      renderSnapshotItems([], vmName);
      _notify(result?.error || 'Could not load snapshots.', 'error');
      return;
    }
    const snapshots = result.snapshots || [];
    if (snapMeta) snapMeta.textContent = `${snapshots.length} snapshot(s) for ${vmName}`;
    renderSnapshotItems(snapshots, vmName);
  };

  const vmResult = await window.vmInstaller.listVMs();
  const allVms = vmResult?.success ? (vmResult.vms || []) : [];
  if (vmSelect) {
    vmSelect.innerHTML = '';
    if (allVms.length > 0) {
      allVms.forEach((vm) => {
        const option = document.createElement('option');
        option.value = String(vm.name || '');
        option.textContent = `${vm.name || 'Unknown'} (${vm.state || 'unknown'})`;
        vmSelect.appendChild(option);
      });
    } else {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No V Os available';
      vmSelect.appendChild(option);
    }
  }

  vmSelect?.addEventListener('change', () => loadSnapshots());
  document.getElementById('btnSnapshotRefresh')?.addEventListener('click', () => loadSnapshots());
  document.getElementById('btnCreateSnapshot')?.addEventListener('click', async () => {
    const vmName = String(vmSelect?.value || '');
    const inputName = String(snapNameInput?.value || '').trim();
    if (!vmName) {
      _notify('Select a V Os first.', 'error');
      return;
    }
    const snapshotName = inputName || `Snapshot ${_formatLocalizedDateTime(Date.now())}`;
    const result = await window.vmInstaller.createSnapshot(vmName, snapshotName);
    if (!result?.success) {
      _notify(result?.error || 'Could not create snapshot.', 'error');
      return;
    }
    if (snapNameInput) snapNameInput.value = '';
    _notify(`Snapshot created for ${vmName}.`, 'success');
    loadSnapshots();
  });

  snapList?.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-snap-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-snap-action');
    const vmName = btn.getAttribute('data-vm-name') || '';
    const snapshotRef = btn.getAttribute('data-snap-ref') || '';
    if (!action || !vmName || !snapshotRef) return;

    btn.disabled = true;
    try {
      if (action === 'restore') {
        const result = await window.vmInstaller.restoreSnapshot(vmName, snapshotRef);
        if (!result?.success) {
          _notify(result?.error || 'Could not restore snapshot.', 'error');
          return;
        }
        _notify(`Snapshot restored for ${vmName}.`, 'success');
      } else if (action === 'delete') {
        const result = await window.vmInstaller.deleteSnapshot(vmName, snapshotRef);
        if (!result?.success) {
          _notify(result?.error || 'Could not delete snapshot.', 'error');
          return;
        }
        _notify('Snapshot deleted.', 'success');
      }
      loadSnapshots();
    } finally {
      btn.disabled = false;
    }
  });

  await loadSnapshots();
}

function _renderStorage() {
  return `
    <div class="dashboard">
      <div class="dashboard-header">
        <div class="dashboard-title-group">
          <h2 class="dashboard-title">Storage</h2>
          <span class="dashboard-subtitle">Live VM footprint, host capacity, and storage locations.</span>
        </div>
        <div class="dashboard-actions">
          <button class="btn btn-secondary" id="btnStorageRefresh">${Icons.sized(Icons.refresh, 14)} Refresh</button>
        </div>
      </div>

      <div class="overview-storage-grid overview-storage-grid--four">
        <div class="overview-storage-item"><span>Host Total</span><strong id="stHostTotal">--</strong></div>
        <div class="overview-storage-item"><span>Host Free</span><strong id="stHostFree">--</strong></div>
        <div class="overview-storage-item"><span>VM Storage Used</span><strong id="stVmUsed">--</strong></div>
        <div class="overview-storage-item"><span>Tracked V Os</span><strong id="stVmCount">--</strong></div>
      </div>

      <div class="overview-panel">
        <div class="overview-panel-head">
          <div class="overview-panel-title">
            <div class="overview-panel-icon">${Icons.sized(Icons.hardDrive, 16)}</div>
            <h3>V Os Disk Footprint</h3>
          </div>
          <span class="overview-muted" id="stMeta">Loading...</span>
        </div>
        <div class="overview-running-list" id="stVmList"></div>
      </div>
    </div>
  `;
}

async function _initStorage() {
  const formatGb = (bytes) => `${(Number(bytes || 0) / (1024 ** 3)).toFixed(2)} GB`;
  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const encodeData = (value) => encodeURIComponent(String(value ?? ''));
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value ?? '--');
  };

  const loadStorage = async () => {
    setText('stMeta', 'Refreshing...');
    const [storageRes, sysRes] = await Promise.allSettled([
      window.vmInstaller.getVMStorageUsage?.(),
      window.vmInstaller.checkSystem(appState.installPath || appState.defaults?.defaultInstallPath || '')
    ]);

    const storage = storageRes.status === 'fulfilled' ? storageRes.value : null;
    const report = sysRes.status === 'fulfilled' ? sysRes.value : null;
    const diskCheck = Array.isArray(report?.checks)
      ? report.checks.find((check) => String(check.name || '').toLowerCase() === 'disk space')
      : null;
    const freeGb = Number(String(diskCheck?.value || '').match(/([\d.]+)/)?.[1] || 0);

    setText('stHostFree', freeGb > 0 ? `${freeGb.toFixed(1)} GB` : 'Unknown');
    setText('stHostTotal', freeGb > 0 && storage?.totalGb >= 0 ? `${(freeGb + Number(storage.totalGb || 0)).toFixed(1)} GB` : 'Unknown');
    setText('stVmUsed', storage?.success ? `${Number(storage.totalGb || 0).toFixed(2)} GB` : '--');
    setText('stVmCount', storage?.success ? (storage.items || []).length : '--');

    const list = document.getElementById('stVmList');
    if (!list) return;

    if (!storage?.success) {
      list.innerHTML = `<div class="overview-empty-inline">Could not load storage data.</div>`;
      setText('stMeta', 'Storage scan failed');
      return;
    }

    const items = (storage.items || []).sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0));
    setText('stMeta', `${items.length} V Os scanned`);
    list.innerHTML = items.length > 0
      ? items.map((item) => {
          const vmName = String(item.name || '');
          const vmDir = String(item.vmDir || '');
          const safeVmName = escapeHtml(vmName || 'Unknown');
          const safeVmDir = escapeHtml(vmDir || 'Storage path unavailable');
          const encodedVmName = encodeData(vmName);
          const encodedVmDir = encodeData(vmDir);
          return `
            <article class="overview-vm-row">
              <div class="overview-vm-meta">
                <strong>${safeVmName}</strong>
                <span title="${safeVmDir}">${safeVmDir}</span>
              </div>
              <div class="overview-vm-status is-running">${formatGb(item.sizeBytes)}</div>
              <div class="overview-vm-actions">
                <button class="vm-row-action" data-storage-action="open" data-vm-name="${encodedVmName}" data-vm-dir="${encodedVmDir}">Open Folder</button>
              </div>
            </article>
          `;
        }).join('')
      : `<div class="overview-empty-inline">No storage entries found.</div>`;

    list.querySelectorAll('[data-storage-action="open"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const vmName = decodeURIComponent(btn.getAttribute('data-vm-name') || '');
        const vmDir = decodeURIComponent(btn.getAttribute('data-vm-dir') || '');
        if (!vmName && !vmDir) return;
        const openResult = await window.vmInstaller.showVMInExplorer({ vmName, vmDir });
        if (!openResult?.success) {
          _notify(openResult?.error || 'Could not open V Os folder.', 'error');
        }
      });
    });
  };

  document.getElementById('btnStorageRefresh')?.addEventListener('click', () => loadStorage());
  await loadStorage();
}

function _renderNetwork() {
  return `
    <div class="dashboard">
      <div class="dashboard-header">
        <div class="dashboard-title-group">
          <h2 class="dashboard-title">Network</h2>
          <span class="dashboard-subtitle">Realtime adapter throughput and V Os network configuration.</span>
        </div>
        <div class="dashboard-actions">
          <button class="btn btn-secondary" id="btnNetworkRefresh">${Icons.sized(Icons.refresh, 14)} Refresh</button>
        </div>
      </div>

      <div class="overview-storage-grid overview-storage-grid--three">
        <div class="overview-storage-item"><span>Download</span><strong id="netDown">--</strong></div>
        <div class="overview-storage-item"><span>Upload</span><strong id="netUp">--</strong></div>
        <div class="overview-storage-item"><span>Total Throughput</span><strong id="netTotal">--</strong></div>
      </div>

      <div class="overview-panel">
        <div class="overview-panel-head">
          <div class="overview-panel-title">
            <div class="overview-panel-icon">${Icons.sized(Icons.network, 16)}</div>
            <h3>Host Adapters</h3>
          </div>
          <span class="overview-muted" id="netAdapterMeta">Loading...</span>
        </div>
        <div class="overview-running-list" id="netAdapterList"></div>
      </div>

      <div class="overview-panel">
        <div class="overview-panel-head">
          <div class="overview-panel-title">
            <div class="overview-panel-icon">${Icons.sized(Icons.vm, 16)}</div>
            <h3>V Os Network Modes</h3>
          </div>
        </div>
        <div class="overview-running-list" id="netVmList"></div>
      </div>
    </div>
  `;
}

async function _initNetwork() {
  const formatMbps = (bytesPerSec) => `${((Number(bytesPerSec || 0) * 8) / 1000000).toFixed(2)} Mbps`;
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value ?? '--');
  };

  const renderNetwork = async () => {
    const [metricsRes, vmRes] = await Promise.allSettled([
      window.vmInstaller.getRealtimeMetrics?.(),
      window.vmInstaller.listVMs()
    ]);
    const metrics = metricsRes.status === 'fulfilled' ? metricsRes.value : null;
    const vmData = vmRes.status === 'fulfilled' ? vmRes.value : null;

    if (metrics?.success) {
      const downBps = Number(metrics.netRxBytesPerSec || 0);
      const upBps = Number(metrics.netTxBytesPerSec || 0);
      setText('netDown', formatMbps(downBps));
      setText('netUp', formatMbps(upBps));
      setText('netTotal', `${(((downBps + upBps) * 8) / 1000000).toFixed(2)} Mbps`);

      const adapterList = document.getElementById('netAdapterList');
      if (adapterList) {
        const adapters = Array.isArray(metrics.adapters) ? metrics.adapters : [];
        setText('netAdapterMeta', `${adapters.length} adapter(s) reporting`);
        adapterList.innerHTML = adapters.length > 0
          ? adapters.map((adapter) => `
              <article class="overview-vm-row">
                <div class="overview-vm-meta">
                  <strong>${adapter.name}</strong>
                  <span>Download ${formatMbps(adapter.bytesReceivedPerSec)} · Upload ${formatMbps(adapter.bytesSentPerSec)}</span>
                </div>
                <div class="overview-vm-status is-running">${formatMbps(adapter.bytesTotalPerSec)}</div>
              </article>
            `).join('')
          : `<div class="overview-empty-inline">No host adapter telemetry available.</div>`;
      }
    } else {
      setText('netDown', '--');
      setText('netUp', '--');
      setText('netTotal', '--');
      setText('netAdapterMeta', 'Realtime adapter telemetry unavailable');
      const adapterList = document.getElementById('netAdapterList');
      if (adapterList) {
        adapterList.innerHTML = `<div class="overview-empty-inline">Realtime adapter telemetry unavailable.</div>`;
      }
    }

    const vmList = document.getElementById('netVmList');
    if (!vmList) return;
    if (!vmData?.success) {
      vmList.innerHTML = `<div class="overview-empty-inline">Could not load V Os network details.</div>`;
      return;
    }
    const vms = vmData.vms || [];
    vmList.innerHTML = vms.length > 0
      ? vms.map((vm) => `
          <article class="overview-vm-row">
            <div class="overview-vm-meta">
              <strong>${vm.name}</strong>
              <span>${vm.os || 'Unknown OS'} · ${String(vm.state || 'unknown').toUpperCase()}</span>
            </div>
            <div class="overview-vm-status is-running">${String(vm.network || 'nat').toUpperCase()}</div>
          </article>
        `).join('')
      : `<div class="overview-empty-inline">No V Os found.</div>`;
  };

  document.getElementById('btnNetworkRefresh')?.addEventListener('click', () => renderNetwork());
  await renderNetwork();
  _setRealtimePanelTimer(() => {
    if (appState.currentView === 'network' && !appState.isRunning) {
      renderNetwork();
    }
  }, 2200);
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
  const refreshStatusText = refreshMeta?.timestamp
    ? `Last refresh completed at ${_formatLocalizedTime(refreshMeta.timestamp)} · Added ${refreshMeta.totalAdded || 0}`
    : 'Not refreshed yet in this session';
  const refreshPanel = refreshMeta
    ? `
      <div class="vm-card" style="margin-bottom: 16px;">
        <div class="vm-card-header">
          <div class="vm-card-title-group">
            <div class="vm-card-name">Official Refresh Status</div>
            <div class="vm-card-os">Last refresh: ${_formatLocalizedDateTime(refreshMeta.timestamp)} · Added: ${refreshMeta.totalAdded || 0}</div>
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
      <div id="catalogRefreshInlineStatus" class="dashboard-subtitle" style="font-size:12px; margin-top:-8px; margin-bottom:10px;">${refreshStatusText}</div>
      ${refreshPanel}
      <div class="vm-grid" id="libraryGrid">${rows || '<div class="vm-empty">No OS catalog available.</div>'}</div>
    </div>
  `;
}

function _initLibrary() {
  document.getElementById('btnRefreshCatalog')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnRefreshCatalog');
    const statusEl = document.getElementById('catalogRefreshInlineStatus');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Refreshing...';
    }
    if (statusEl) {
      statusEl.textContent = 'Refreshing official versions...';
    }

    try {
      const refreshed = await _withTimeout(
        window.vmInstaller.refreshOfficialCatalog(),
        90000,
        'Catalog refresh timed out. Please try again.'
      );

      if (!refreshed?.success) {
        _notify(`Catalog refresh failed: ${refreshed?.error || 'Unknown error'}`, 'error');
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
      if (statusEl) {
        statusEl.textContent = `Last refresh completed at ${_formatLocalizedTime(appState.catalogRefreshMeta.timestamp)} · Added ${appState.catalogRefreshMeta.totalAdded || 0}`;
      }
      _notify(`Official catalog updated. Added ${refreshed.totalAdded || 0} new versions.`, 'success');
      app.showLibrary();
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `Refresh failed: ${err?.message || 'Unknown error'}`;
      }
      _notify(`Catalog refresh failed: ${err?.message || 'Unknown error'}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Refresh Official Versions';
      }
    }
  });

  document.querySelectorAll('[data-action="select-os"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-os-name');
      appState.osName = name;
      _notify(`Selected "${name}" for Create V Os.`, 'success');
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

function _renderSettings(initialState = {}) {
  const prefs = _loadUiPrefs();
  const defaults = appState.defaults || {};
  const pick = (key, fallback) => (prefs[key] === undefined ? fallback : prefs[key]);
  const selected = (value, expected) => String(value) === String(expected) ? 'selected' : '';
  const requestedScope = initialState?.scope === 'vos' ? 'vos' : 'global';
  const lockedScope = initialState?.lockScope === true ? requestedScope : '';
  const settingsTitle = lockedScope === 'vos'
    ? 'V Os Settings'
    : (lockedScope === 'global' ? 'VM Xposed Settings' : 'Settings');
  const settingsSubtitle = lockedScope === 'vos'
    ? 'Configuration center for selected V Os only'
    : (lockedScope === 'global'
      ? 'Configuration center for VM Xposed app-level settings'
      : 'Zero-redundancy control center for app-level and V Os-level configuration');

  const defaultInstallPath = String(defaults.defaultInstallPath || '');
  const defaultDownloadPath = String(defaults.defaultDownloadDir || '');
  const defaultSharedPath = String(defaults.defaultSharedFolder || '');

  const installPath = String(pick('installPath', appState.installPath || defaultInstallPath || ''));
  const downloadPath = String(pick('downloadPath', appState.downloadPath || defaultDownloadPath || ''));
  const sharedFolderPath = String(pick('sharedFolderPath', appState.sharedFolderPath || defaultSharedPath || ''));
  const defaultUserUsername = String(pick('defaultUserUsername', appState.defaultUserUsername || 'user') || 'user');
  const defaultUserPassword = String(pick('defaultUserPassword', appState.defaultUserPassword || 'user'));
  const guestUsername = String(pick('guestUsername', pick('username', appState.guestUsername || appState.username || 'guest')) || 'guest');
  const guestPassword = String(pick('guestPassword', pick('password', appState.guestPassword || appState.password || 'guest')));
  const startFullscreen = pick('startFullscreen', appState.startFullscreen) !== false;
  const accelerate3d = pick('accelerate3d', appState.accelerate3d) === true;

  const visualEffectsSetting = String(pick('visualEffectsMode', _resolveVisualEffectsMode())) === 'full' ? 'full' : 'lite';
  const language = String(pick('language', 'en'));
  const startupView = String(pick('startupView', 'dashboard'));
  const notificationLevel = String(pick('notificationLevel', 'important'));
  const virtualBoxPath = String(pick('virtualBoxPath', ''));
  const adminModePolicy = String(pick('adminModePolicy', 'manual'));
  const autoRepairLevel = String(pick('autoRepairLevel', 'safe'));
  const maxHostRamPercent = Math.max(40, Math.min(95, parseInt(pick('maxHostRamPercent', 75), 10) || 75));
  const maxHostCpuPercent = Math.max(40, Math.min(95, parseInt(pick('maxHostCpuPercent', 75), 10) || 75));
  const vmDefaultPreset = String(pick('vmDefaultPreset', 'balanced'));
  const credentialStorage = String(pick('credentialStorage', 'keychain'));
  const telemetryEnabled = pick('telemetryEnabled', false) === true;
  const trustedPaths = String(pick('trustedPaths', ''));
  const logLevel = String(pick('logLevel', 'info'));
  const logRetentionDays = Math.max(1, Math.min(365, parseInt(pick('logRetentionDays', 14), 10) || 14));
  const ignoredUpdateVersion = _normalizeVersionText(String(pick('ignoredUpdateVersion', '')));
  const updateInfo = appState.updateInfo || {};
  const currentVersionText = String(updateInfo.currentVersion || 'Checking...');
  const latestVersionText = String(updateInfo.latestVersion || (ignoredUpdateVersion || 'Not checked'));
  const updateStatusText = updateInfo.hasUpdate
    ? (updateInfo.isIgnored ? 'Update available (ignored)' : 'Update available')
    : (updateInfo.checkedAt ? 'Up to date' : 'Not checked');
  const checkedAtStamp = Date.parse(String(updateInfo.checkedAt || ''));
  const publishedAtText = Number.isFinite(checkedAtStamp)
    ? `Last checked ${_formatLocalizedDateTime(checkedAtStamp)}`
    : 'Update check has not run yet.';

  const safeInstallPath = _escapeHtml(installPath);
  const safeDownloadPath = _escapeHtml(downloadPath);
  const safeSharedFolderPath = _escapeHtml(sharedFolderPath);
  const safeDefaultUserUsername = _escapeHtml(defaultUserUsername);
  const safeDefaultUserPassword = _escapeHtml(defaultUserPassword);
  const safeGuestUsername = _escapeHtml(guestUsername);
  const safeGuestPassword = _escapeHtml(guestPassword);
  const safeVirtualBoxPath = _escapeHtml(virtualBoxPath);
  const safeTrustedPaths = _escapeHtml(trustedPaths);
  const safeCurrentVersion = _escapeHtml(currentVersionText);
  const safeLatestVersion = _escapeHtml(latestVersionText);
  const safeUpdateStatus = _escapeHtml(updateStatusText);
  const safePublishedAt = _escapeHtml(publishedAtText);
  const safeIgnoredVersion = _escapeHtml(ignoredUpdateVersion);

  return `
    <div class="dashboard">
      <div class="dashboard-header">
        <div class="dashboard-title-group">
          <h2 class="dashboard-title">${settingsTitle}</h2>
          <span class="dashboard-subtitle">${settingsSubtitle}</span>
        </div>
      </div>

      <div class="settings-shell vm-card">
        <div class="settings-toolbar">
          <div class="settings-search-wrap">
            <input class="form-input settings-search-input" id="setSearch" placeholder="Search settings: clipboard, drag drop, shared folder, performance..." />
          </div>
          <div class="settings-scope-switch" role="tablist" aria-label="Settings scope"${lockedScope ? ' style="display:none;"' : ''}>
            <button class="btn btn-sm btn-primary" id="setScopeGlobal" data-settings-scope="global">VM Xposed Settings</button>
            <button class="btn btn-sm btn-secondary" id="setScopeVos" data-settings-scope="vos">V Os Settings</button>
          </div>
        </div>

        <div class="settings-layout">
          <aside class="settings-nav">
            <button class="settings-nav-btn active" data-settings-scope="global" data-settings-section="general">General</button>
            <button class="settings-nav-btn" data-settings-scope="global" data-settings-section="host">Host & VirtualBox</button>
            <button class="settings-nav-btn" data-settings-scope="global" data-settings-section="resources">Resource Policy</button>
            <button class="settings-nav-btn" data-settings-scope="global" data-settings-section="account">Account</button>
            <button class="settings-nav-btn" data-settings-scope="global" data-settings-section="security">Security & Privacy</button>
            <button class="settings-nav-btn" data-settings-scope="global" data-settings-section="version">Version Details</button>
            <button class="settings-nav-btn" data-settings-scope="global" data-settings-section="diagnostics">Diagnostics & Recovery</button>

            <button class="settings-nav-btn" data-settings-scope="vos" data-settings-section="profile">Profile & Preset</button>
            <button class="settings-nav-btn" data-settings-scope="vos" data-settings-section="compute">Compute & Boot</button>
            <button class="settings-nav-btn" data-settings-scope="vos" data-settings-section="display">Display & Experience</button>
            <button class="settings-nav-btn" data-settings-scope="vos" data-settings-section="devices">Devices & Network</button>
            <button class="settings-nav-btn" data-settings-scope="vos" data-settings-section="integration">Integration</button>
            <button class="settings-nav-btn" data-settings-scope="vos" data-settings-section="access">Guest Access</button>
            <button class="settings-nav-btn" data-settings-scope="vos" data-settings-section="recovery">Safety & Recovery</button>
          </aside>

          <div class="settings-content">
            <div class="settings-scope-pane active" id="settingsGlobalScope" data-settings-pane="global">
              <section class="settings-section active" data-settings-section="general">
                <h3>General</h3>
                <div class="setting-row" data-search="visual effects performance gpu smooth lite full">
                  <div class="setting-copy">
                    <label class="setting-label" for="setVisualEffectsMode">Visual Effects</label>
                    <p class="setting-desc">Control animation intensity for smoother performance.</p>
                    <details class="setting-advanced"><summary>Advanced</summary><p>Lite reduces GPU load. Full enables richer motion effects.</p></details>
                  </div>
                  <div class="setting-control">
                    <select class="form-select" id="setVisualEffectsMode" data-default="lite">
                      <option value="lite" ${selected(visualEffectsSetting, 'lite')}>Lite (Recommended)</option>
                      <option value="full" ${selected(visualEffectsSetting, 'full')}>Full</option>
                    </select>
                  </div>
                </div>

                <div class="setting-row" data-search="language locale english">
                  <div class="setting-copy">
                    <label class="setting-label" for="setLanguage">Language</label>
                    <p class="setting-desc">Primary interface language.</p>
                  </div>
                  <div class="setting-control">
                    <select class="form-select" id="setLanguage" data-default="en">
                      <option value="en" ${selected(language, 'en')}>English</option>
                      <option value="hi" ${selected(language, 'hi')}>Hindi</option>
                    </select>
                  </div>
                </div>

                <div class="setting-row" data-search="startup view launch default page">
                  <div class="setting-copy">
                    <label class="setting-label" for="setStartupView">Startup View</label>
                    <p class="setting-desc">Default page opened on app launch.</p>
                  </div>
                  <div class="setting-control">
                    <select class="form-select" id="setStartupView" data-default="dashboard">
                      <option value="dashboard" ${selected(startupView, 'dashboard')}>Dashboard</option>
                      <option value="machines" ${selected(startupView, 'machines')}>V Os</option>
                      <option value="wizard" ${selected(startupView, 'wizard')}>Create V Os</option>
                      <option value="settings" ${selected(startupView, 'settings')}>Settings</option>
                    </select>
                  </div>
                </div>

                <div class="setting-row" data-search="notification toast warning error">
                  <div class="setting-copy">
                    <label class="setting-label" for="setNotificationLevel">Notifications</label>
                    <p class="setting-desc">How much app feedback to show.</p>
                  </div>
                  <div class="setting-control">
                    <select class="form-select" id="setNotificationLevel" data-default="important">
                      <option value="all" ${selected(notificationLevel, 'all')}>All</option>
                      <option value="important" ${selected(notificationLevel, 'important')}>Important only</option>
                      <option value="minimal" ${selected(notificationLevel, 'minimal')}>Minimal</option>
                    </select>
                  </div>
                </div>
              </section>

              <section class="settings-section" data-settings-section="host">
                <h3>Host & VirtualBox</h3>
                <div class="setting-row" data-search="virtualbox path vboxmanage binary">
                  <div class="setting-copy">
                    <label class="setting-label" for="setVBoxPath">VirtualBox Path</label>
                    <p class="setting-desc">Optional manual override for VBoxManage executable path.</p>
                  </div>
                  <div class="setting-control">
                    <input class="form-input" id="setVBoxPath" value="${safeVirtualBoxPath}" data-default="" placeholder="Auto-detect (recommended)" />
                  </div>
                </div>

                <div class="setting-row" data-search="install path vos storage root">
                  <div class="setting-copy">
                    <label class="setting-label" for="setInstallPath">Default Install Path</label>
                    <p class="setting-desc">Location used when creating new V Os.</p>
                  </div>
                  <div class="setting-control">
                    <div class="settings-inline-input">
                      <input class="form-input" id="setInstallPath" value="${safeInstallPath}" data-default="${_escapeHtml(defaultInstallPath)}" />
                      <button class="btn btn-secondary" id="setInstallBrowse">Browse</button>
                    </div>
                  </div>
                </div>

                <div class="setting-row" data-search="download folder iso official">
                  <div class="setting-copy">
                    <label class="setting-label" for="setDownloadPath">Default ISO Download Folder</label>
                    <p class="setting-desc">Used when downloading official OS images.</p>
                  </div>
                  <div class="setting-control">
                    <div class="settings-inline-input">
                      <input class="form-input" id="setDownloadPath" value="${safeDownloadPath}" data-default="${_escapeHtml(defaultDownloadPath)}" />
                      <button class="btn btn-secondary" id="setDownloadBrowse">Browse</button>
                    </div>
                  </div>
                </div>

                <div class="setting-row" data-search="admin privilege elevation">
                  <div class="setting-copy">
                    <label class="setting-label" for="setAdminModePolicy">Admin Mode Policy</label>
                    <p class="setting-desc">How elevation prompts are handled.</p>
                  </div>
                  <div class="setting-control">
                    <select class="form-select" id="setAdminModePolicy" data-default="manual">
                      <option value="manual" ${selected(adminModePolicy, 'manual')}>Manual only (Recommended)</option>
                      <option value="auto" ${selected(adminModePolicy, 'auto')}>Auto-prompt when needed (Legacy)</option>
                    </select>
                  </div>
                </div>

                <div class="setting-row" data-search="auto repair startup recovery boot">
                  <div class="setting-copy">
                    <label class="setting-label" for="setAutoRepairLevel">Auto Repair Level</label>
                    <p class="setting-desc">Boot-time repair strategy for broken V Os sessions.</p>
                  </div>
                  <div class="setting-control">
                    <select class="form-select" id="setAutoRepairLevel" data-default="safe">
                      <option value="none" ${selected(autoRepairLevel, 'none')}>None</option>
                      <option value="safe" ${selected(autoRepairLevel, 'safe')}>Safe</option>
                      <option value="full" ${selected(autoRepairLevel, 'full')}>Full</option>
                    </select>
                  </div>
                </div>
              </section>

              <section class="settings-section" data-settings-section="resources">
                <h3>Resource Policy</h3>
                <div class="setting-row" data-search="ram guardrail host freeze">
                  <div class="setting-copy">
                    <label class="setting-label" for="setMaxHostRamPercent">Max Host RAM Usage %</label>
                    <p class="setting-desc">Hard guardrail before provisioning warns and blocks unsafe values.</p>
                  </div>
                  <div class="setting-control">
                    <input class="form-input" type="number" min="40" max="95" id="setMaxHostRamPercent" value="${maxHostRamPercent}" data-default="75" />
                  </div>
                </div>
                <div class="setting-row" data-search="cpu guardrail lag">
                  <div class="setting-copy">
                    <label class="setting-label" for="setMaxHostCpuPercent">Max Host CPU Usage %</label>
                    <p class="setting-desc">Default cap for safe CPU assignment.</p>
                  </div>
                  <div class="setting-control">
                    <input class="form-input" type="number" min="40" max="95" id="setMaxHostCpuPercent" value="${maxHostCpuPercent}" data-default="75" />
                  </div>
                </div>
                <div class="setting-row" data-search="preset beginner balanced advanced">
                  <div class="setting-copy">
                    <label class="setting-label" for="setVmDefaultPreset">Default V Os Preset</label>
                    <p class="setting-desc">Starting profile for new V Os creation.</p>
                  </div>
                  <div class="setting-control">
                    <select class="form-select" id="setVmDefaultPreset" data-default="balanced">
                      <option value="beginner" ${selected(vmDefaultPreset, 'beginner')}>Beginner</option>
                      <option value="balanced" ${selected(vmDefaultPreset, 'balanced')}>Balanced</option>
                      <option value="advanced" ${selected(vmDefaultPreset, 'advanced')}>Advanced</option>
                    </select>
                  </div>
                </div>
                <div class="setting-row" data-search="shared folder default path">
                  <div class="setting-copy">
                    <label class="setting-label" for="setSharedPath">Default Shared Folder Path</label>
                    <p class="setting-desc">Fallback host path used in guest integration setup.</p>
                  </div>
                  <div class="setting-control">
                    <div class="settings-inline-input">
                      <input class="form-input" id="setSharedPath" value="${safeSharedFolderPath}" data-default="${_escapeHtml(defaultSharedPath)}" />
                      <button class="btn btn-secondary" id="setSharedBrowse">Browse</button>
                    </div>
                  </div>
                </div>
              </section>

              <section class="settings-section" data-settings-section="account">
                <h3>Account</h3>
                <div class="setting-row" data-search="default user username password credentials">
                  <div class="setting-copy">
                    <label class="setting-label">Default User Credentials</label>
                    <p class="setting-desc">Used when Account Type is set to User in Create V Os flow.</p>
                  </div>
                  <div class="setting-control settings-credentials-grid">
                    <input class="form-input" id="setDefaultUserName" value="${safeDefaultUserUsername}" data-default="user" placeholder="Default user username" />
                    <input class="form-input" id="setDefaultUserPass" value="${safeDefaultUserPassword}" data-default="user" placeholder="Default user password" />
                  </div>
                </div>
                <div class="setting-row" data-search="guest user username password credentials">
                  <div class="setting-copy">
                    <label class="setting-label">Guest Credentials</label>
                    <p class="setting-desc">Used by Guest Setup, Fix All, and account actions inside the V Os.</p>
                  </div>
                  <div class="setting-control settings-credentials-grid">
                    <input class="form-input" id="setGuestUserName" value="${safeGuestUsername}" data-default="guest" placeholder="Guest username" />
                    <input class="form-input" id="setGuestUserPass" value="${safeGuestPassword}" data-default="guest" placeholder="Guest password" />
                  </div>
                </div>
              </section>

              <section class="settings-section" data-settings-section="security">
                <h3>Security & Privacy</h3>
                <div class="setting-row" data-search="credential storage keychain">
                  <div class="setting-copy">
                    <label class="setting-label" for="setCredentialStorage">Credential Storage</label>
                    <p class="setting-desc">Where OS admin credentials are stored.</p>
                  </div>
                  <div class="setting-control">
                    <select class="form-select" id="setCredentialStorage" data-default="keychain">
                      <option value="keychain" ${selected(credentialStorage, 'keychain')}>OS keychain (recommended)</option>
                      <option value="session" ${selected(credentialStorage, 'session')}>Session only</option>
                    </select>
                  </div>
                </div>
                <div class="setting-row" data-search="trusted paths share folder whitelist">
                  <div class="setting-copy">
                    <label class="setting-label" for="setTrustedPaths">Trusted Paths</label>
                    <p class="setting-desc">Approved host path prefix(es) for shared folders.</p>
                  </div>
                  <div class="setting-control">
                    <div class="settings-inline-input">
                      <input class="form-input" id="setTrustedPaths" value="${safeTrustedPaths}" data-default="" placeholder="Example: D:\\VM\\Share Folder" />
                      <button class="btn btn-secondary" id="setTrustedBrowse">Browse</button>
                    </div>
                  </div>
                </div>
                <div class="setting-row" data-search="telemetry analytics">
                  <div class="setting-copy">
                    <label class="setting-label" for="setTelemetryEnabled">Telemetry</label>
                    <p class="setting-desc">Allow anonymous diagnostic analytics.</p>
                  </div>
                  <div class="setting-control">
                    <label class="settings-check"><input type="checkbox" id="setTelemetryEnabled" data-default="false" ${telemetryEnabled ? 'checked' : ''} /> Enable telemetry</label>
                  </div>
                </div>
              </section>

              <section class="settings-section" data-settings-section="version">
                <h3>Version Details</h3>
                <div class="setting-row" data-search="current version build installed">
                  <div class="setting-copy">
                    <label class="setting-label">Current Version</label>
                    <p class="setting-desc">Installed VM Xposed version on this PC.</p>
                  </div>
                  <div class="setting-control">
                    <span class="settings-note-chip" id="setUpdateCurrentVersion">${safeCurrentVersion}</span>
                  </div>
                </div>
                <div class="setting-row" data-search="latest version release">
                  <div class="setting-copy">
                    <label class="setting-label">Latest Version</label>
                    <p class="setting-desc">Latest version detected from repository update folders.</p>
                  </div>
                  <div class="setting-control">
                    <span class="settings-note-chip" id="setUpdateLatestVersion">${safeLatestVersion}</span>
                  </div>
                </div>
                <div class="setting-row" data-search="status update available ignored">
                  <div class="setting-copy">
                    <label class="setting-label">Update Status</label>
                    <p class="setting-desc">Whether a newer installer is available for VM Xposed.</p>
                  </div>
                  <div class="setting-control">
                    <span class="settings-note-chip" id="setUpdateStatus">${safeUpdateStatus}</span>
                  </div>
                </div>
                <div class="setting-row" data-search="last checked update sync timestamp">
                  <div class="setting-copy">
                    <label class="setting-label">Last Update Check</label>
                    <p class="setting-desc" id="setUpdatePublishedAt">${safePublishedAt}</p>
                  </div>
                  <div class="setting-control">
                    <button class="btn btn-secondary" id="setOpenUpdatesView">Open Updates Section</button>
                  </div>
                </div>
                <p class="settings-update-ignored" id="setUpdateIgnoredVersion"${ignoredUpdateVersion ? '' : ' hidden'}>Ignored update version: ${safeIgnoredVersion || '-'}</p>
              </section>

              <section class="settings-section" data-settings-section="diagnostics">
                <h3>Diagnostics & Recovery</h3>
                <div class="setting-row" data-search="log level debug info warning error">
                  <div class="setting-copy">
                    <label class="setting-label" for="setLogLevel">Log Level</label>
                    <p class="setting-desc">Minimum event level recorded in diagnostics output.</p>
                  </div>
                  <div class="setting-control">
                    <select class="form-select" id="setLogLevel" data-default="info">
                      <option value="error" ${selected(logLevel, 'error')}>Error</option>
                      <option value="warning" ${selected(logLevel, 'warning')}>Warning</option>
                      <option value="info" ${selected(logLevel, 'info')}>Info</option>
                      <option value="debug" ${selected(logLevel, 'debug')}>Debug</option>
                    </select>
                  </div>
                </div>
                <div class="setting-row" data-search="retention logs cleanup days">
                  <div class="setting-copy">
                    <label class="setting-label" for="setLogRetentionDays">Log Retention (days)</label>
                    <p class="setting-desc">Retention period before automatic log cleanup.</p>
                  </div>
                  <div class="setting-control">
                    <input class="form-input" type="number" min="1" max="365" id="setLogRetentionDays" value="${logRetentionDays}" data-default="14" />
                  </div>
                </div>
                <div class="setting-row" data-search="launch fullscreen display fit 3d">
                  <div class="setting-copy">
                    <label class="setting-label">Default Guest Experience</label>
                    <p class="setting-desc">Baseline runtime behavior for newly configured V Os.</p>
                  </div>
                  <div class="setting-control settings-check-grid">
                    <label class="settings-check"><input type="checkbox" id="setStartFullscreen" data-default="true" ${startFullscreen ? 'checked' : ''} /> Guest display fit by default</label>
                    <label class="settings-check"><input type="checkbox" id="setAccelerate3d" data-default="false" ${accelerate3d ? 'checked' : ''} /> 3D acceleration by default</label>
                  </div>
                </div>
              </section>
            </div>

            <div class="settings-scope-pane" id="settingsVosScope" data-settings-pane="vos">
              <section class="settings-section active" data-settings-section="profile">
                <h3>Profile & Preset</h3>
                <div class="setting-row" data-search="select vm vos choose machine">
                  <div class="setting-copy">
                    <label class="setting-label" for="setVmSelect">Selected V Os</label>
                    <p class="setting-desc">Pick one V Os to edit detailed settings.</p>
                  </div>
                  <div class="setting-control">
                    <select class="form-select" id="setVmSelect">
                      <option value="">Loading V Os...</option>
                    </select>
                  </div>
                </div>
                <div class="setting-row" data-search="preset mode beginner balanced advanced custom">
                  <div class="setting-copy">
                    <label class="setting-label" for="setVmPreset">Preset Mode</label>
                    <p class="setting-desc">Operational profile for this V Os.</p>
                  </div>
                  <div class="setting-control">
                    <select class="form-select" id="setVmPreset" data-default="custom">
                      <option value="beginner">Beginner</option>
                      <option value="balanced">Balanced</option>
                      <option value="advanced">Advanced</option>
                      <option value="custom" selected>Custom</option>
                    </select>
                  </div>
                </div>
                <div class="setting-row" data-search="state health running paused poweroff">
                  <div class="setting-copy">
                    <div class="setting-label">State Summary</div>
                    <p class="setting-desc">Real-time VM state and integration health indicator.</p>
                  </div>
                  <div class="setting-control">
                    <div class="settings-state-badge" id="setVmStateBadge">Unknown</div>
                  </div>
                </div>
              </section>

              <section class="settings-section" data-settings-section="compute">
                <h3>Compute & Boot</h3>
                <div class="form-row settings-grid-row">
                  <div class="setting-row" data-search="ram memory">
                    <div class="setting-copy"><label class="setting-label" for="setVmRam">RAM (MB)</label><p class="setting-desc">Memory assigned to this V Os.</p></div>
                    <div class="setting-control"><input class="form-input" id="setVmRam" type="number" min="512" step="256" /></div>
                  </div>
                  <div class="setting-row" data-search="cpu cores">
                    <div class="setting-copy"><label class="setting-label" for="setVmCpus">CPU Cores</label><p class="setting-desc">Virtual CPU allocation.</p></div>
                    <div class="setting-control"><input class="form-input" id="setVmCpus" type="number" min="1" max="32" /></div>
                  </div>
                  <div class="setting-row" data-search="vram video memory">
                    <div class="setting-copy"><label class="setting-label" for="setVmVram">VRAM (MB)</label><p class="setting-desc">Video memory for guest display.</p></div>
                    <div class="setting-control"><input class="form-input" id="setVmVram" type="number" min="16" step="16" /></div>
                  </div>
                  <div class="setting-row" data-search="firmware bios efi">
                    <div class="setting-copy"><label class="setting-label" for="setVmFirmware">Firmware</label><p class="setting-desc">Boot firmware type.</p></div>
                    <div class="setting-control"><select class="form-select" id="setVmFirmware"><option value="bios">BIOS</option><option value="efi">EFI</option></select></div>
                  </div>
                </div>
                <div class="setting-row" data-search="boot order sequence disk dvd network">
                  <div class="setting-copy">
                    <div class="setting-label">Boot Priority</div>
                    <p class="setting-desc">Boot device order using structured priority slots.</p>
                  </div>
                  <div class="setting-control settings-boot-grid">
                    <select class="form-select" id="setVmBoot1"><option value="disk">Disk</option><option value="dvd">DVD</option><option value="net">Network</option><option value="none">None</option></select>
                    <select class="form-select" id="setVmBoot2"><option value="disk">Disk</option><option value="dvd">DVD</option><option value="net">Network</option><option value="none">None</option></select>
                    <select class="form-select" id="setVmBoot3"><option value="disk">Disk</option><option value="dvd">DVD</option><option value="net">Network</option><option value="none">None</option></select>
                    <select class="form-select" id="setVmBoot4"><option value="disk">Disk</option><option value="dvd">DVD</option><option value="net">Network</option><option value="none">None</option></select>
                  </div>
                </div>
                <div class="setting-row" data-search="nested virtualization">
                  <div class="setting-copy"><label class="setting-label" for="setVmNested">Nested Virtualization</label><p class="setting-desc">Enable only when guest hypervisors are needed.</p></div>
                  <div class="setting-control"><label class="settings-check"><input type="checkbox" id="setVmNested" /> Enable nested virtualization</label></div>
                </div>
              </section>

              <section class="settings-section" data-settings-section="display">
                <h3>Display & Experience</h3>
                <div class="setting-row" data-search="graphics controller vmsvga vboxsvga vboxvga">
                  <div class="setting-copy"><label class="setting-label" for="setVmGraphics">Graphics Controller</label><p class="setting-desc">Choose guest graphics adapter profile.</p></div>
                  <div class="setting-control">
                    <select class="form-select" id="setVmGraphics">
                      <option value="vmsvga">VMSVGA</option>
                      <option value="vboxsvga">VBoxSVGA</option>
                      <option value="vboxvga">VBoxVGA</option>
                    </select>
                  </div>
                </div>
                <div class="setting-row" data-search="display fit fullscreen">
                  <div class="setting-copy"><label class="setting-label" for="setVmDisplayFit">Guest Display Fit</label><p class="setting-desc">Fit guest desktop to VM viewport.</p></div>
                  <div class="setting-control"><label class="settings-check"><input type="checkbox" id="setVmDisplayFit" /> Enable display fit</label></div>
                </div>
                <div class="setting-row" data-search="3d acceleration">
                  <div class="setting-copy"><label class="setting-label" for="setVm3d">3D Acceleration</label><p class="setting-desc">Can improve graphics but may reduce stability on some hosts.</p></div>
                  <div class="setting-control"><label class="settings-check"><input type="checkbox" id="setVm3d" /> Enable 3D acceleration</label></div>
                </div>
              </section>

              <section class="settings-section" data-settings-section="devices">
                <h3>Devices & Network</h3>
                <div class="setting-row" data-search="audio enable controller">
                  <div class="setting-copy"><div class="setting-label">Audio</div><p class="setting-desc">Audio output and emulation controller.</p></div>
                  <div class="setting-control settings-inline-controls">
                    <label class="settings-check"><input type="checkbox" id="setVmAudio" /> Enabled</label>
                    <select class="form-select" id="setVmAudioController">
                      <option value="hda">HDA</option>
                      <option value="ac97">AC97</option>
                      <option value="sb16">SB16</option>
                    </select>
                  </div>
                </div>
                <div class="setting-row" data-search="usb controller">
                  <div class="setting-copy"><label class="setting-label" for="setVmUsb">USB</label><p class="setting-desc">Enable guest USB passthrough support.</p></div>
                  <div class="setting-control"><label class="settings-check"><input type="checkbox" id="setVmUsb" /> Enable USB</label></div>
                </div>
                <div class="setting-row" data-search="network mode nat bridged internal host-only">
                  <div class="setting-copy"><label class="setting-label" for="setVmNetworkMode">Network Mode</label><p class="setting-desc">Primary networking policy for this V Os.</p></div>
                  <div class="setting-control">
                    <select class="form-select" id="setVmNetworkMode">
                      <option value="nat">NAT</option>
                      <option value="bridged">Bridged</option>
                      <option value="internal">Internal</option>
                      <option value="hostonly">Host-Only</option>
                    </select>
                  </div>
                </div>
              </section>

              <section class="settings-section" data-settings-section="integration">
                <h3>Integration</h3>
                <div class="setting-row" data-search="clipboard sync host guest">
                  <div class="setting-copy"><label class="setting-label" for="setVmClipboard">Clipboard Sync</label><p class="setting-desc">Direction for clipboard sharing.</p></div>
                  <div class="setting-control">
                    <select class="form-select" id="setVmClipboard">
                      <option value="disabled">Disabled</option>
                      <option value="hosttoguest">Host to Guest</option>
                      <option value="guesttohost">Guest to Host</option>
                      <option value="bidirectional">Bidirectional</option>
                    </select>
                  </div>
                </div>
                <div class="setting-row" data-search="drag drop host guest">
                  <div class="setting-copy"><label class="setting-label" for="setVmDnD">Drag & Drop</label><p class="setting-desc">Direction for drag-and-drop exchange.</p></div>
                  <div class="setting-control">
                    <select class="form-select" id="setVmDnD">
                      <option value="disabled">Disabled</option>
                      <option value="hosttoguest">Host to Guest</option>
                      <option value="guesttohost">Guest to Host</option>
                      <option value="bidirectional">Bidirectional</option>
                    </select>
                  </div>
                </div>
                <div class="setting-row" data-search="shared folder path mount">
                  <div class="setting-copy"><label class="setting-label" for="setVmSharedPath">Primary Shared Folder</label><p class="setting-desc">Host folder mapped as <code>shared</code> inside guest.</p></div>
                  <div class="setting-control">
                    <div class="settings-inline-input">
                      <input class="form-input" id="setVmSharedPath" placeholder="D:\\VM\\Share Folder" />
                      <button class="btn btn-secondary" id="setVmSharedBrowse">Browse</button>
                    </div>
                  </div>
                </div>
                <div class="settings-inline-actions">
                  <button class="btn btn-primary" id="setVmFixAll">Fix All</button>
                  <button class="btn btn-secondary" id="setVmManage">Manage Guest Setup</button>
                </div>
              </section>

              <section class="settings-section" data-settings-section="access">
                <h3>Guest Access & Accounts</h3>
                <div class="setting-row" data-search="accounts users create update delete">
                  <div class="setting-copy"><div class="setting-label">Guest Accounts Center</div><p class="setting-desc">Open account manager for user operations inside guest.</p></div>
                  <div class="setting-control"><button class="btn btn-secondary" id="setVmAccounts">Open Account Management</button></div>
                </div>
                <div class="setting-row" data-search="session x11 wayland drag drop">
                  <div class="setting-copy"><div class="setting-label">Session Compatibility</div><p class="setting-desc">Drag & drop guest→host is most reliable on X11 guest sessions.</p></div>
                  <div class="setting-control"><div class="settings-note-chip">Hint: switch guest to Xorg if DnD fails on Wayland.</div></div>
                </div>
              </section>

              <section class="settings-section" data-settings-section="recovery">
                <h3>Safety, Snapshots & Recovery</h3>
                <div class="setting-row" data-search="boot fix diagnostics">
                  <div class="setting-copy"><div class="setting-label">Troubleshooting</div><p class="setting-desc">Run diagnostics and recovery actions for this V Os.</p></div>
                  <div class="setting-control settings-inline-actions">
                    <button class="btn btn-secondary" id="setVmBootFix">Run Boot Diagnostics</button>
                    <button class="btn btn-secondary" id="setVmOpenStorage">Open V Os Folder</button>
                  </div>
                </div>
              </section>
            </div>

            <div class="settings-search-empty" id="setSearchEmpty" style="display:none;">
              No settings match this search in the current scope.
            </div>
          </div>
        </div>

        <div class="settings-footer">
          <button class="btn btn-secondary" id="setCloseSettings">Close Settings</button>
          <button class="btn btn-secondary" id="setResetSection">Reset Section</button>
          <button class="btn btn-secondary" id="setResetAll">Reset Scope</button>
          <button class="btn btn-primary" id="setSaveGlobal">Save VM Xposed Settings</button>
          <button class="btn btn-primary" id="setSaveVos" style="display:none;">Save V Os Settings</button>
        </div>
      </div>
    </div>
  `;
}

function _renderDownload() {
  const prefs = _loadUiPrefs();
  const updateInfo = appState.updateInfo || {};
  const ignoredVersion = _normalizeVersionText(String(prefs.ignoredUpdateVersion || ''));
  const currentVersionText = _normalizeVersionText(updateInfo.currentVersion || '') || 'Checking...';
  const latestVersionText = _normalizeVersionText(updateInfo.latestVersion || '') || 'Not checked';
  const statusText = updateInfo.hasUpdate
    ? ((ignoredVersion && ignoredVersion === _normalizeVersionText(updateInfo.latestVersion || '')) ? 'Update available (ignored)' : 'Update available')
    : (updateInfo.checkedAt ? 'Up to date' : 'Not checked');
  const checkedAtStamp = Date.parse(String(updateInfo.checkedAt || ''));
  const metaText = Number.isFinite(checkedAtStamp)
    ? `Last checked ${_formatLocalizedDateTime(checkedAtStamp)}`
    : (updateInfo.patchNotesName ? `Patch source: ${String(updateInfo.patchNotesName)}` : 'Patch notes appear after update checks.');
  const notesText = String(updateInfo.releaseNotes || 'No patch notes loaded yet.');
  const patchHistoryCount = Array.isArray(updateInfo.patchHistory) ? updateInfo.patchHistory.length : 0;

  return `
    <div class="dashboard">
      <div class="dashboard-header">
        <div class="dashboard-title-group">
          <h2 class="dashboard-title">Updates</h2>
          <span class="dashboard-subtitle">Check new VM Xposed releases, read patch notes, and install updates</span>
        </div>
      </div>

      <div class="settings-shell vm-card" style="max-width: 1060px;">
        <section class="settings-section active">
          <h3>Release Overview</h3>
          <div class="setting-row">
            <div class="setting-copy">
              <label class="setting-label">Current Version</label>
              <p class="setting-desc">Installed VM Xposed version on this PC.</p>
            </div>
            <div class="setting-control">
              <span class="settings-note-chip" id="updCurrentVersion">${_escapeHtml(currentVersionText)}</span>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <label class="setting-label">Latest Version</label>
              <p class="setting-desc">Latest version detected from repository update folders.</p>
            </div>
            <div class="setting-control">
              <span class="settings-note-chip" id="updLatestVersion">${_escapeHtml(latestVersionText)}</span>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <label class="setting-label">Update Status</label>
              <p class="setting-desc">Whether a newer installer is available for VM Xposed.</p>
            </div>
            <div class="setting-control">
              <span class="settings-note-chip" id="updStatus">${_escapeHtml(statusText)}</span>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <label class="setting-label">Patch Notes</label>
              <p class="setting-desc" id="updMeta">${_escapeHtml(metaText)}</p>
            </div>
            <div class="setting-control">
              <pre class="settings-update-notes" id="updNotes">${_escapeHtml(notesText)}</pre>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <label class="setting-label">Patch History</label>
              <p class="setting-desc"><span id="updPatchHistoryCount">${_escapeHtml(String(patchHistoryCount))}</span> patch note versions available in repository history.</p>
            </div>
            <div class="setting-control">
              <div class="settings-update-history-list" id="updPatchHistoryList">
                <p class="settings-update-history-empty">Run update check to load patch history.</p>
              </div>
              <pre class="settings-update-history-viewer" id="updPatchHistoryViewer">Select a patch version to preview its full notes.</pre>
            </div>
          </div>
          <div class="settings-inline-actions settings-update-actions">
            <button class="btn btn-secondary" id="updCheck">Check for Updates</button>
            <button class="btn btn-primary" id="updInstall" disabled>Update Now</button>
            <button class="btn btn-secondary" id="updIgnore" disabled>Ignore This Version</button>
            <button class="btn btn-secondary" id="updOpenInstaller">Open Installer Folder</button>
            <button class="btn btn-secondary" id="updOpenPatchFolder">Open Patch Notes Folder</button>
          </div>
          <p class="settings-update-ignored" id="updIgnoredVersion"${ignoredVersion ? '' : ' hidden'}>Ignored update version: ${_escapeHtml(ignoredVersion || '-')}</p>
        </section>
        <div class="settings-footer">
          <button class="btn btn-secondary" id="btnUpdateOpenSettings">Version Details</button>
        </div>
      </div>
    </div>
  `;
}

function _renderCredits() {
  return `
    <div class="dashboard">
      <div class="dashboard-header">
        <div class="dashboard-title-group">
          <h2 class="dashboard-title">Credits</h2>
          <span class="dashboard-subtitle">About this project and how to support it</span>
        </div>
      </div>

      <div class="vm-card" style="max-width: 760px;">
        <div class="vm-card-header">
          <div class="vm-card-title-group">
            <div class="vm-card-name">Why I created this</div>
            <div class="vm-card-os">A personal mission behind VM Xposed</div>
          </div>
        </div>

        <div style="color: var(--text-secondary); font-size: 14px; line-height: 1.7;">
          I created VM Xposed to make virtual OS setup simple, fast, and reliable for everyone.
          The goal is to remove confusing manual steps and give users a clean workflow where V Os creation,
          OS selection, and management feel smooth from start to finish.
        </div>

        <div class="vm-card-controls" style="margin-top: 8px;">
          <div class="vm-actions-secondary">
            <button class="btn btn-primary btn-icon-text" id="btnSupportGithub">
              ${Icons.externalLink} Support on GitHub @jeet1511
            </button>
            <button class="btn btn-secondary btn-icon-text" id="btnSupportInstagram">
              ${Icons.externalLink} Follow on Instagram @_echo.del.alma_
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function _initCredits() {
  document.getElementById('btnSupportGithub')?.addEventListener('click', async () => {
    await window.vmInstaller.openExternal('https://github.com/jeet1511');
  });

  document.getElementById('btnSupportInstagram')?.addEventListener('click', async () => {
    await window.vmInstaller.openExternal('https://instagram.com/_echo.del.alma_');
  });
}

function _initDownload() {
  const currentVersionEl = document.getElementById('updCurrentVersion');
  const latestVersionEl = document.getElementById('updLatestVersion');
  const statusEl = document.getElementById('updStatus');
  const metaEl = document.getElementById('updMeta');
  const notesEl = document.getElementById('updNotes');
  const historyCountEl = document.getElementById('updPatchHistoryCount');
  const historyListEl = document.getElementById('updPatchHistoryList');
  const historyViewerEl = document.getElementById('updPatchHistoryViewer');
  const ignoredEl = document.getElementById('updIgnoredVersion');
  const checkBtn = document.getElementById('updCheck');
  const installBtn = document.getElementById('updInstall');
  const ignoreBtn = document.getElementById('updIgnore');
  const openInstallerBtn = document.getElementById('updOpenInstaller');
  const openPatchFolderBtn = document.getElementById('updOpenPatchFolder');
  const openSettingsBtn = document.getElementById('btnUpdateOpenSettings');

  const patchHistoryCache = appState.patchHistoryCache || {};
  appState.patchHistoryCache = patchHistoryCache;
  let selectedPatchHistoryKey = '';
  let patchHistoryRequestToken = 0;

  const formatCheckText = (value) => {
    const stamp = Date.parse(String(value || ''));
    if (!Number.isFinite(stamp)) return 'Update check has not run yet.';
    return `Last checked ${_formatLocalizedDateTime(stamp)}`;
  };

  const getPatchHistoryEntries = (info = {}) => {
    if (!Array.isArray(info.patchHistory)) return [];
    return info.patchHistory
      .map((entry) => ({
        version: _normalizeVersionText(entry?.version || ''),
        name: String(entry?.name || '').trim(),
        url: String(entry?.url || '').trim()
      }))
      .filter((entry) => entry.version && entry.name);
  };

  const getPatchHistoryKey = (entry = {}) => `${_normalizeVersionText(entry.version || '')}|${String(entry.name || '').trim()}`;

  const showPatchHistoryText = (text) => {
    if (!historyViewerEl) return;
    historyViewerEl.textContent = String(text || 'No patch note text available.');
  };

  const loadPatchHistoryText = async (entry, forceRefresh = false) => {
    if (!entry || !entry.url) {
      showPatchHistoryText('Patch note file URL is missing for this entry.');
      return;
    }
    const key = getPatchHistoryKey(entry);
    if (!forceRefresh && patchHistoryCache[key]) {
      showPatchHistoryText(patchHistoryCache[key]);
      return;
    }
    if (!forceRefresh && appState.updateInfo?.patchNotesUrl === entry.url && appState.updateInfo?.releaseNotes) {
      patchHistoryCache[key] = String(appState.updateInfo.releaseNotes);
      showPatchHistoryText(patchHistoryCache[key]);
      return;
    }

    const token = ++patchHistoryRequestToken;
    showPatchHistoryText('Loading patch note...');
    const result = await window.vmInstaller.getPatchNoteText({ url: entry.url }).catch((err) => ({ success: false, error: err?.message || 'Failed to load patch note.' }));
    if (token !== patchHistoryRequestToken) return;
    if (!result?.success) {
      showPatchHistoryText(`Could not load patch note: ${result?.error || 'Unknown error'}`);
      return;
    }
    patchHistoryCache[key] = String(result.text || '').trim() || 'Patch note is empty.';
    showPatchHistoryText(patchHistoryCache[key]);
  };

  const renderPatchHistory = (info = {}) => {
    const entries = getPatchHistoryEntries(info);
    if (historyCountEl) historyCountEl.textContent = String(entries.length);
    if (!historyListEl) return;

    historyListEl.innerHTML = '';
    if (entries.length === 0) {
      historyListEl.innerHTML = '<p class="settings-update-history-empty">No patch history found yet.</p>';
      selectedPatchHistoryKey = '';
      showPatchHistoryText('No patch history loaded yet.');
      return;
    }

    const containsSelected = entries.some((entry) => getPatchHistoryKey(entry) === selectedPatchHistoryKey);
    if (!containsSelected) selectedPatchHistoryKey = getPatchHistoryKey(entries[0]);

    entries.forEach((entry) => {
      const key = getPatchHistoryKey(entry);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `settings-update-history-item${key === selectedPatchHistoryKey ? ' active' : ''}`;
      button.setAttribute('data-patch-history-key', key);
      button.innerHTML = `
        <span class="settings-update-history-version">v${_escapeHtml(entry.version)}</span>
        <span class="settings-update-history-name">${_escapeHtml(entry.name)}</span>
      `;
      button.addEventListener('click', async () => {
        selectedPatchHistoryKey = key;
        historyListEl.querySelectorAll('.settings-update-history-item').forEach((node) => {
          node.classList.toggle('active', node.getAttribute('data-patch-history-key') === key);
        });
        await loadPatchHistoryText(entry);
      });
      historyListEl.appendChild(button);
    });

    const selectedEntry = entries.find((entry) => getPatchHistoryKey(entry) === selectedPatchHistoryKey) || entries[0];
    if (selectedEntry) loadPatchHistoryText(selectedEntry).catch(() => {});
  };

  const renderUpdateState = (info = appState.updateInfo || {}) => {
    const state = info || {};
    const currentVersion = _normalizeVersionText(state.currentVersion || '');
    const latestVersion = _normalizeVersionText(state.latestVersion || '');
    const prefs = _loadUiPrefs();
    const ignoredVersion = _normalizeVersionText(prefs.ignoredUpdateVersion || state.ignoredVersion || '');
    const isIgnored = !!latestVersion && ignoredVersion === latestVersion;
    const statusText = state.hasUpdate
      ? (isIgnored ? 'Update available (ignored)' : 'Update available')
      : (state.checkedAt ? 'Up to date' : 'Not checked');

    if (currentVersionEl) currentVersionEl.textContent = currentVersion || 'Unknown';
    if (latestVersionEl) latestVersionEl.textContent = latestVersion || 'Not checked';
    if (statusEl) statusEl.textContent = statusText;
    if (metaEl) metaEl.textContent = formatCheckText(state.checkedAt);
    if (notesEl) notesEl.textContent = String(state.releaseNotes || 'No patch notes loaded yet.');
    if (installBtn) installBtn.disabled = !state.hasUpdate || !state.installerUrl;
    if (ignoreBtn) ignoreBtn.disabled = !state.hasUpdate || !latestVersion;
    if (ignoredEl) {
      ignoredEl.hidden = !ignoredVersion;
      ignoredEl.textContent = ignoredVersion ? `Ignored update version: ${ignoredVersion}` : '';
    }
    renderPatchHistory(state);
  };

  const refreshUpdateState = async ({ force = false, notifyOnUpdate = false, notifyOnNoUpdate = false, notifyOnError = false } = {}) => {
    if (checkBtn) {
      checkBtn.disabled = true;
      checkBtn.textContent = 'Checking...';
    }
    const result = await _checkForAppUpdates({ force, notifyOnUpdate, notifyOnNoUpdate, notifyOnError });
    if (result?.success) {
      appState.updateInfo = result;
      const checkStamp = new Date().toISOString();
      try {
        await _persistUiPrefsPatch({ lastUpdateCheckAt: checkStamp });
      } catch (err) {
        if (notifyOnError) _notify(`Could not persist update timestamp: ${err?.message || 'Unknown error'}`, 'error');
      }
    }
    if (checkBtn) {
      checkBtn.disabled = false;
      checkBtn.textContent = 'Check for Updates';
    }
    renderUpdateState(appState.updateInfo || result || {});
    return result;
  };

  checkBtn?.addEventListener('click', async () => {
    await refreshUpdateState({ force: true, notifyOnUpdate: true, notifyOnNoUpdate: true, notifyOnError: true });
  });
  installBtn?.addEventListener('click', async () => {
    const info = appState.updateInfo || {};
    if (!info?.hasUpdate || !info?.installerUrl) {
      _notify('Run update check first to fetch installer details.', 'error');
      return;
    }
    installBtn.disabled = true;
    const originalText = installBtn.textContent;
    installBtn.textContent = 'Downloading installer...';
    try {
      const result = await window.vmInstaller.downloadAndInstallUpdate({
        installerUrl: info.installerUrl,
        version: info.latestVersion
      });
      if (!result?.success) {
        _notify(result?.error || 'Update installation failed.', 'error');
        return;
      }
      _notify('Installer launched. VM Xposed will close and update now.', 'info');
    } catch (err) {
      _notify(`Update installation failed: ${err?.message || 'Unknown error'}`, 'error');
    } finally {
      installBtn.disabled = false;
      installBtn.textContent = originalText || 'Update Now';
    }
  });
  ignoreBtn?.addEventListener('click', async () => {
    const latestVersion = _normalizeVersionText(appState.updateInfo?.latestVersion || '');
    if (!latestVersion) return;
    try {
      await _persistUiPrefsPatch({ ignoredUpdateVersion: latestVersion });
      if (appState.updateInfo) {
        appState.updateInfo.ignoredVersion = latestVersion;
        appState.updateInfo.isIgnored = true;
      }
      _updateNavBadge(appState.updateInfo);
      renderUpdateState(appState.updateInfo || {});
      _notify(`Ignored update v${latestVersion}.`, 'info');
    } catch (err) {
      _notify(`Could not ignore this update: ${err?.message || 'Unknown error'}`, 'error');
    }
  });
  openInstallerBtn?.addEventListener('click', async () => {
    const target = String(appState.updateInfo?.releasesPage || RELEASES_PAGE_URL);
    const result = await window.vmInstaller.openExternal(target);
    if (!result?.success) {
      _notify(`Could not open installer folder: ${result?.error || 'Unknown error'}`, 'error');
    }
  });
  openPatchFolderBtn?.addEventListener('click', async () => {
    const target = String(appState.updateInfo?.patchNotesPage || 'https://github.com/Jeet1511/VM-Manager/tree/main/Patch%20notes');
    const result = await window.vmInstaller.openExternal(target);
    if (!result?.success) {
      _notify(`Could not open patch notes folder: ${result?.error || 'Unknown error'}`, 'error');
    }
  });
  openSettingsBtn?.addEventListener('click', () => {
    app.showSettings({ scope: 'global', section: 'version', lockScope: true });
  });

  renderUpdateState(appState.updateInfo || {});
  window.vmInstaller.getAppVersion?.().then((versionResult) => {
    if (versionResult?.success) {
      appState.updateInfo = {
        ...(appState.updateInfo || {}),
        currentVersion: _normalizeVersionText(versionResult.version || '')
      };
      renderUpdateState(appState.updateInfo);
    }
  }).catch(() => {
    console.warn('[Updates] Failed to read current app version.');
  });
  if (!appState.updateInfo?.checkedAt) {
    refreshUpdateState({ force: false, notifyOnError: false }).catch(() => {
      console.warn('[Updates] Initial update check failed.');
    });
  }
}

function _initSettings(initialState = {}) {
  let isSavingGlobal = false;
  let isSavingVm = false;
  const settingsState = appState.settingsUi = appState.settingsUi || {
    scope: 'global',
    globalSection: 'general',
    vosSection: 'profile',
    vmList: [],
    selectedVmName: '',
    lockedScope: ''
  };

  settingsState.lockedScope = '';
  if (initialState && typeof initialState === 'object') {
    if (initialState.lockScope === true) {
      settingsState.lockedScope = initialState.scope === 'vos' ? 'vos' : 'global';
      settingsState.scope = settingsState.lockedScope;
    }
    if (initialState.scope === 'global' || initialState.scope === 'vos') {
      settingsState.scope = settingsState.lockedScope || initialState.scope;
    }
    if (typeof initialState.globalSection === 'string' && initialState.globalSection.trim()) {
      settingsState.globalSection = initialState.globalSection.trim();
    }
    if (typeof initialState.vosSection === 'string' && initialState.vosSection.trim()) {
      settingsState.vosSection = initialState.vosSection.trim();
    }
    if (typeof initialState.section === 'string' && initialState.section.trim()) {
      if ((initialState.scope || settingsState.scope) === 'vos') settingsState.vosSection = initialState.section.trim();
      else settingsState.globalSection = initialState.section.trim();
    }
    if (typeof initialState.vmName === 'string' && initialState.vmName.trim()) {
      settingsState.selectedVmName = initialState.vmName.trim();
    }
  }
  if (settingsState.globalSection === 'updates') settingsState.globalSection = 'version';
  const allowedGlobalSections = ['general', 'host', 'resources', 'account', 'security', 'version', 'diagnostics'];
  if (!allowedGlobalSections.includes(settingsState.globalSection)) {
    settingsState.globalSection = 'general';
  }

  const saveGlobalBtn = document.getElementById('setSaveGlobal');
  const saveVmBtn = document.getElementById('setSaveVos');
  const searchInput = document.getElementById('setSearch');
  const searchEmpty = document.getElementById('setSearchEmpty');
  const vmSelect = document.getElementById('setVmSelect');
  const closeSettingsBtn = document.getElementById('setCloseSettings');
  const updateCurrentVersionEl = document.getElementById('setUpdateCurrentVersion');
  const updateLatestVersionEl = document.getElementById('setUpdateLatestVersion');
  const updateStatusEl = document.getElementById('setUpdateStatus');
  const updatePublishedAtEl = document.getElementById('setUpdatePublishedAt');
  const updateNotesEl = document.getElementById('setUpdateNotes');
  const updateIgnoredEl = document.getElementById('setUpdateIgnoredVersion');
  const patchHistoryCountEl = document.getElementById('setPatchHistoryCount');
  const patchHistoryListEl = document.getElementById('setPatchHistoryList');
  const patchHistoryViewerEl = document.getElementById('setPatchHistoryViewer');
  const updateCheckBtn = document.getElementById('setUpdateCheck');
  const updateInstallBtn = document.getElementById('setUpdateInstall');
  const updateIgnoreBtn = document.getElementById('setUpdateIgnore');
  const updateOpenReleasesBtn = document.getElementById('setUpdateOpenReleases');
  const updateOpenPatchFolderBtn = document.getElementById('setUpdateOpenPatchFolder');
  const patchHistoryCache = appState.patchHistoryCache || {};
  appState.patchHistoryCache = patchHistoryCache;
  let selectedPatchHistoryKey = '';
  let patchHistoryRequestToken = 0;

  const navigateToView = (view) => {
    if (view === 'machines') return app.showMachines();
    if (view === 'wizard') return app.showWizard();
    if (view === 'library') return app.showLibrary();
    if (view === 'snapshots') return app.showSnapshots();
    if (view === 'storage') return app.showStorage();
    if (view === 'network') return app.showNetwork();
    if (view === 'download') return app.showDownload();
    if (view === 'credits') return app.showCredits();
    return app.showDashboard();
  };

  const clamp = (value, min, max, fallback) => {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  };

  const resetControlToDefault = (control) => {
    const defaultValue = control.getAttribute('data-default');
    if (defaultValue === null) return;
    if (control.type === 'checkbox') {
      control.checked = defaultValue === 'true';
    } else {
      control.value = defaultValue;
    }
  };

  const setScope = (scope) => {
    const nextScope = scope === 'vos' ? 'vos' : 'global';
    settingsState.scope = settingsState.lockedScope || nextScope;
    document.querySelectorAll('.settings-scope-switch [data-settings-scope]').forEach((btn) => {
      const isActive = btn.getAttribute('data-settings-scope') === settingsState.scope;
      btn.classList.toggle('btn-primary', isActive);
      btn.classList.toggle('btn-secondary', !isActive);
    });

    document.querySelectorAll('.settings-nav-btn').forEach((btn) => {
      btn.style.display = btn.getAttribute('data-settings-scope') === settingsState.scope ? '' : 'none';
    });

    document.querySelectorAll('.settings-scope-pane').forEach((pane) => {
      pane.classList.toggle('active', pane.getAttribute('data-settings-pane') === settingsState.scope);
    });

    if (saveGlobalBtn) saveGlobalBtn.style.display = settingsState.scope === 'global' ? '' : 'none';
    if (saveVmBtn) saveVmBtn.style.display = settingsState.scope === 'vos' ? '' : 'none';
    setSection(settingsState.scope, settingsState.scope === 'global' ? settingsState.globalSection : settingsState.vosSection);
    filterSettings();
  };

  const setSection = (scope, section) => {
    let nextSection = section;
    if (scope === 'global' && nextSection === 'updates') nextSection = 'version';
    if (scope === 'vos') settingsState.vosSection = nextSection;
    if (scope === 'global') settingsState.globalSection = nextSection;

    const activeSection = scope === 'global' ? settingsState.globalSection : settingsState.vosSection;
    document.querySelectorAll(`.settings-scope-pane[data-settings-pane="${scope}"] .settings-section`).forEach((pane) => {
      pane.classList.toggle('active', pane.getAttribute('data-settings-section') === activeSection);
    });
    document.querySelectorAll(`.settings-nav-btn[data-settings-scope="${scope}"]`).forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-settings-section') === activeSection);
    });
    filterSettings();
  };

  const filterSettings = () => {
    const query = String(searchInput?.value || '').trim().toLowerCase();
    const scopePane = document.querySelector(`.settings-scope-pane[data-settings-pane="${settingsState.scope}"]`);
    if (!scopePane) return;

    const activeSection = settingsState.scope === 'global' ? settingsState.globalSection : settingsState.vosSection;
    let visibleSections = 0;

    scopePane.querySelectorAll('.settings-section').forEach((section) => {
      const sectionId = section.getAttribute('data-settings-section');
      const rows = Array.from(section.querySelectorAll('.setting-row'));
      let hasVisibleRow = rows.length === 0;

      rows.forEach((row) => {
        const haystack = `${row.getAttribute('data-search') || ''} ${row.textContent || ''}`.toLowerCase();
        const rowVisible = !query || haystack.includes(query);
        row.style.display = rowVisible ? '' : 'none';
        if (rowVisible) hasVisibleRow = true;
      });

      const sectionVisible = query ? hasVisibleRow : sectionId === activeSection;
      section.style.display = sectionVisible ? '' : 'none';
      if (sectionVisible) visibleSections += 1;
    });

    if (searchEmpty) {
      searchEmpty.style.display = visibleSections > 0 ? 'none' : '';
    }
  };

  const formatUpdateTimestamp = (value) => {
    if (!value) return 'Update check has not run yet.';
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return 'Update check has not run yet.';
    return `Last checked ${_formatLocalizedDateTime(parsed)}`;
  };

  const getPatchHistoryEntries = (info = {}) => {
    if (!Array.isArray(info.patchHistory)) return [];
    return info.patchHistory
      .map((entry) => ({
        version: _normalizeVersionText(entry?.version || ''),
        name: String(entry?.name || '').trim(),
        url: String(entry?.url || '').trim()
      }))
      .filter((entry) => entry.version && entry.name);
  };

  const getPatchHistoryKey = (entry = {}) => `${_normalizeVersionText(entry.version || '')}|${String(entry.name || '').trim()}`;

  const showPatchHistoryText = (text) => {
    if (!patchHistoryViewerEl) return;
    patchHistoryViewerEl.textContent = String(text || 'No patch note text available.');
  };

  const loadPatchHistoryText = async (entry, forceRefresh = false) => {
    if (!entry || !entry.url) {
      showPatchHistoryText('Patch note file URL is missing for this entry.');
      return;
    }
    const key = getPatchHistoryKey(entry);
    if (!forceRefresh && patchHistoryCache[key]) {
      showPatchHistoryText(patchHistoryCache[key]);
      return;
    }
    if (!forceRefresh && appState.updateInfo?.patchNotesUrl === entry.url && appState.updateInfo?.releaseNotes) {
      patchHistoryCache[key] = String(appState.updateInfo.releaseNotes);
      showPatchHistoryText(patchHistoryCache[key]);
      return;
    }

    const requestToken = ++patchHistoryRequestToken;
    showPatchHistoryText('Loading patch note...');
    const result = await window.vmInstaller.getPatchNoteText({ url: entry.url }).catch((err) => ({ success: false, error: err?.message || 'Failed to load patch note.' }));
    if (requestToken !== patchHistoryRequestToken) return;
    if (!result?.success) {
      showPatchHistoryText(`Could not load patch note: ${result?.error || 'Unknown error'}`);
      return;
    }
    patchHistoryCache[key] = String(result.text || '').trim() || 'Patch note is empty.';
    showPatchHistoryText(patchHistoryCache[key]);
  };

  const renderPatchHistory = (info = {}) => {
    const entries = getPatchHistoryEntries(info);
    if (patchHistoryCountEl) patchHistoryCountEl.textContent = String(entries.length);
    if (!patchHistoryListEl) return;

    patchHistoryListEl.innerHTML = '';
    if (entries.length === 0) {
      patchHistoryListEl.innerHTML = '<p class="settings-update-history-empty">No patch history found yet.</p>';
      selectedPatchHistoryKey = '';
      showPatchHistoryText('No patch history loaded yet.');
      return;
    }

    const containsSelected = entries.some((entry) => getPatchHistoryKey(entry) === selectedPatchHistoryKey);
    if (!containsSelected) selectedPatchHistoryKey = getPatchHistoryKey(entries[0]);

    entries.forEach((entry) => {
      const key = getPatchHistoryKey(entry);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `settings-update-history-item${key === selectedPatchHistoryKey ? ' active' : ''}`;
      button.setAttribute('data-patch-history-key', key);
      button.innerHTML = `
        <span class="settings-update-history-version">v${_escapeHtml(entry.version)}</span>
        <span class="settings-update-history-name">${_escapeHtml(entry.name)}</span>
      `;
      button.addEventListener('click', async () => {
        selectedPatchHistoryKey = key;
        patchHistoryListEl.querySelectorAll('.settings-update-history-item').forEach((node) => {
          node.classList.toggle('active', node.getAttribute('data-patch-history-key') === key);
        });
        await loadPatchHistoryText(entry);
      });
      patchHistoryListEl.appendChild(button);
    });

    const selectedEntry = entries.find((entry) => getPatchHistoryKey(entry) === selectedPatchHistoryKey) || entries[0];
    if (selectedEntry) loadPatchHistoryText(selectedEntry).catch(() => {});
  };

  const renderUpdateState = (state = appState.updateInfo || {}) => {
    const info = state || {};
    const currentVersion = _normalizeVersionText(info.currentVersion || '');
    const latestVersion = _normalizeVersionText(info.latestVersion || '');
    const prefs = _loadUiPrefs();
    const ignoredVersion = _normalizeVersionText(prefs.ignoredUpdateVersion || info.ignoredVersion || '');
    const isIgnored = !!latestVersion && ignoredVersion === latestVersion;
    const statusText = info.hasUpdate
      ? (isIgnored ? 'Update available (ignored)' : 'Update available')
      : (info.checkedAt ? 'Up to date' : 'Not checked');

    if (updateCurrentVersionEl) updateCurrentVersionEl.textContent = currentVersion || 'Unknown';
    if (updateLatestVersionEl) updateLatestVersionEl.textContent = latestVersion || 'Not checked';
    if (updateStatusEl) updateStatusEl.textContent = statusText;
    if (updatePublishedAtEl) updatePublishedAtEl.textContent = formatUpdateTimestamp(info.checkedAt);
    if (updateNotesEl) updateNotesEl.textContent = String(info.releaseNotes || 'No patch notes loaded yet.');
    if (updateInstallBtn) updateInstallBtn.disabled = !info.hasUpdate || !info.installerUrl;
    if (updateIgnoreBtn) updateIgnoreBtn.disabled = !info.hasUpdate || !latestVersion;
    if (updateIgnoredEl) {
      updateIgnoredEl.hidden = !ignoredVersion;
      updateIgnoredEl.textContent = ignoredVersion ? `Ignored version: ${ignoredVersion}` : '';
    }
    renderPatchHistory(info);
  };

  const refreshUpdateState = async ({
    force = false,
    notifyOnUpdate = false,
    notifyOnNoUpdate = false,
    notifyOnError = false
  } = {}) => {
    if (updateCheckBtn) {
      updateCheckBtn.disabled = true;
      updateCheckBtn.textContent = 'Checking...';
    }
    const result = await _checkForAppUpdates({ force, notifyOnUpdate, notifyOnNoUpdate, notifyOnError });
    if (result?.success) {
      appState.updateInfo = result;
      const checkStamp = new Date().toISOString();
      try {
        await _persistUiPrefsPatch({ lastUpdateCheckAt: checkStamp });
      } catch (err) {
        if (notifyOnError) _notify(`Could not persist update timestamp: ${err?.message || 'Unknown error'}`, 'error');
      }
    }
    if (updateCheckBtn) {
      updateCheckBtn.disabled = false;
      updateCheckBtn.textContent = 'Check for Updates';
    }
    renderUpdateState(appState.updateInfo || result || {});
    return result;
  };

  const findSelectedVm = () => settingsState.vmList.find((vm) => vm.name === settingsState.selectedVmName) || null;

  const updateVmControlDefaults = () => {
    ['setVmRam', 'setVmCpus', 'setVmVram', 'setVmBoot1', 'setVmBoot2', 'setVmBoot3', 'setVmBoot4', 'setVmFirmware', 'setVmNested',
      'setVmGraphics', 'setVmDisplayFit', 'setVm3d', 'setVmAudio', 'setVmAudioController', 'setVmUsb', 'setVmNetworkMode',
      'setVmClipboard', 'setVmDnD', 'setVmSharedPath'].forEach((id) => {
      const control = document.getElementById(id);
      if (!control) return;
      const value = control.type === 'checkbox' ? (control.checked ? 'true' : 'false') : String(control.value ?? '');
      control.setAttribute('data-default', value);
    });
  };

  const fillVmEditor = (vm) => {
    const badge = document.getElementById('setVmStateBadge');
    if (badge) {
      const state = String(vm?.state || 'unknown');
      badge.textContent = `${state.toUpperCase()}${vm?.integrationChecks?.guestAdditions ? ' • GA Ready' : ''}`;
      badge.classList.toggle('running', state.toLowerCase() === 'running');
    }

    const boot = Array.isArray(vm?.bootOrder) && vm.bootOrder.length > 0
      ? vm.bootOrder
      : ['disk', 'dvd', 'none', 'none'];
    const networkMode = String(vm?.network || 'nat').toLowerCase() === 'intnet'
      ? 'internal'
      : String(vm?.network || 'nat').toLowerCase();
    const clipboardMode = String(vm?.clipboardMode || 'bidirectional').toLowerCase();
    const dragDropMode = String(vm?.dragAndDrop || 'bidirectional').toLowerCase();
    const setValue = (id, value, isBool = false) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox' || isBool) el.checked = !!value;
      else el.value = value ?? '';
    };

    setValue('setVmRam', parseInt(vm?.ram || 2048, 10));
    setValue('setVmCpus', parseInt(vm?.cpus || 2, 10));
    setValue('setVmVram', parseInt(vm?.vram || 128, 10));
    setValue('setVmBoot1', boot[0] || 'disk');
    setValue('setVmBoot2', boot[1] || 'dvd');
    setValue('setVmBoot3', boot[2] || 'none');
    setValue('setVmBoot4', boot[3] || 'none');
    setValue('setVmFirmware', vm?.efiEnabled ? 'efi' : 'bios');
    setValue('setVmNested', !!vm?.nestedVirtualization, true);
    setValue('setVmGraphics', String(vm?.graphicscontroller || vm?.graphicsController || 'vmsvga').toLowerCase());
    setValue('setVmDisplayFit', vm?.fullscreenEnabled !== false, true);
    setValue('setVm3d', !!vm?.accelerate3d, true);
    setValue('setVmAudio', !!vm?.audioEnabled, true);
    setValue('setVmAudioController', String(vm?.audioController || 'hda').toLowerCase());
    setValue('setVmUsb', !!vm?.usbEnabled, true);
    setValue('setVmNetworkMode', ['nat', 'bridged', 'internal', 'hostonly'].includes(networkMode) ? networkMode : 'nat');
    setValue('setVmClipboard', ['disabled', 'hosttoguest', 'guesttohost', 'bidirectional'].includes(clipboardMode) ? clipboardMode : 'disabled');
    setValue('setVmDnD', ['disabled', 'hosttoguest', 'guesttohost', 'bidirectional'].includes(dragDropMode) ? dragDropMode : 'disabled');
    setValue('setVmSharedPath', String(vm?.primarySharedFolderPath || vm?.sharedFolders?.[0]?.hostPath || '').trim());
    updateVmControlDefaults();
  };

  const loadVmList = async (preferredName = '') => {
    if (!vmSelect) return;
    const result = await window.vmInstaller.listVMs().catch(() => ({ success: false, vms: [] }));
    settingsState.vmList = result?.success ? (result.vms || []) : [];
    vmSelect.innerHTML = '';

    if (settingsState.vmList.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No V Os available';
      vmSelect.appendChild(option);
      settingsState.selectedVmName = '';
      fillVmEditor(null);
      return;
    }

    settingsState.vmList.forEach((vm) => {
      const option = document.createElement('option');
      option.value = vm.name;
      option.textContent = `${vm.name} (${String(vm.state || 'unknown')})`;
      vmSelect.appendChild(option);
    });

    const hasPreferred = preferredName && settingsState.vmList.some((vm) => vm.name === preferredName);
    settingsState.selectedVmName = hasPreferred
      ? preferredName
      : (settingsState.selectedVmName && settingsState.vmList.some((vm) => vm.name === settingsState.selectedVmName)
        ? settingsState.selectedVmName
        : settingsState.vmList[0].name);

    vmSelect.value = settingsState.selectedVmName;
    fillVmEditor(findSelectedVm());
  };

  document.querySelectorAll('.settings-scope-switch [data-settings-scope]').forEach((button) => {
    button.addEventListener('click', () => setScope(button.getAttribute('data-settings-scope') || 'global'));
  });
  document.querySelectorAll('.settings-nav-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const scope = button.getAttribute('data-settings-scope') || settingsState.scope;
      const section = button.getAttribute('data-settings-section') || '';
      setScope(scope);
      setSection(scope, section);
    });
  });
  searchInput?.addEventListener('input', filterSettings);
  if (initialState?.search && searchInput) {
    searchInput.value = String(initialState.search);
  }

  vmSelect?.addEventListener('change', () => {
    settingsState.selectedVmName = vmSelect.value || '';
    fillVmEditor(findSelectedVm());
  });

  closeSettingsBtn?.addEventListener('click', () => {
    const fallback = appState.settingsReturnView && appState.settingsReturnView !== 'settings'
      ? appState.settingsReturnView
      : 'dashboard';
    navigateToView(fallback);
  });

  document.getElementById('setInstallBrowse')?.addEventListener('click', async () => {
    const selected = await window.vmInstaller.selectFolder('Select default install path', document.getElementById('setInstallPath')?.value || appState.installPath || '');
    if (selected) document.getElementById('setInstallPath').value = selected;
  });
  document.getElementById('setSharedBrowse')?.addEventListener('click', async () => {
    const selected = await window.vmInstaller.selectFolder('Select default shared folder', document.getElementById('setSharedPath')?.value || appState.sharedFolderPath || '');
    if (selected) document.getElementById('setSharedPath').value = selected;
  });
  document.getElementById('setDownloadBrowse')?.addEventListener('click', async () => {
    const selected = await window.vmInstaller.selectFolder('Select default ISO download folder', document.getElementById('setDownloadPath')?.value || appState.downloadPath || appState.defaults?.defaultDownloadDir || '');
    if (selected) document.getElementById('setDownloadPath').value = selected;
  });
  document.getElementById('setTrustedBrowse')?.addEventListener('click', async () => {
    const selected = await window.vmInstaller.selectFolder('Select trusted folder path', document.getElementById('setTrustedPaths')?.value || '');
    if (selected) document.getElementById('setTrustedPaths').value = selected;
  });
  document.getElementById('setOpenUpdatesView')?.addEventListener('click', () => {
    app.showDownload();
  });
  const applyVisualEffectsModeFromSettings = () => {
    const mode = document.getElementById('setVisualEffectsMode')?.value === 'full' ? 'full' : 'lite';
    _applyVisualEffectsMode(mode);
    _ensureMotionSystemMounted();
    resolveMotionPreference();
    _validateMotionVisibility();
  };
  document.getElementById('setVisualEffectsMode')?.addEventListener('change', applyVisualEffectsModeFromSettings);
  updateCheckBtn?.addEventListener('click', async () => {
    await refreshUpdateState({
      force: true,
      notifyOnUpdate: true,
      notifyOnNoUpdate: true,
      notifyOnError: true
    });
  });
  updateInstallBtn?.addEventListener('click', async () => {
    const info = appState.updateInfo || {};
    if (!info?.hasUpdate || !info?.installerUrl) {
      _notify('Run update check first to fetch installer details.', 'error');
      return;
    }
    updateInstallBtn.disabled = true;
    const originalLabel = updateInstallBtn.textContent;
    updateInstallBtn.textContent = 'Downloading installer...';
    try {
      const result = await window.vmInstaller.downloadAndInstallUpdate({
        installerUrl: info.installerUrl,
        version: info.latestVersion
      });
      if (!result?.success) {
        _notify(result?.error || 'Update installation failed.', 'error');
        return;
      }
      _notify('Installer launched. VM Xposed will close and update now.', 'info');
    } catch (err) {
      _notify(`Update installation failed: ${err?.message || 'Unknown error'}`, 'error');
    } finally {
      updateInstallBtn.disabled = false;
      updateInstallBtn.textContent = originalLabel || 'Update Now';
    }
  });
  updateIgnoreBtn?.addEventListener('click', async () => {
    const latestVersion = _normalizeVersionText(appState.updateInfo?.latestVersion || '');
    if (!latestVersion) return;
    try {
      await _persistUiPrefsPatch({ ignoredUpdateVersion: latestVersion });
      if (appState.updateInfo) {
        appState.updateInfo.ignoredVersion = latestVersion;
        appState.updateInfo.isIgnored = true;
      }
      _updateNavBadge(appState.updateInfo);
      renderUpdateState(appState.updateInfo || {});
      _notify(`Ignored update v${latestVersion}.`, 'info');
    } catch (err) {
      _notify(`Could not ignore this update: ${err?.message || 'Unknown error'}`, 'error');
    }
  });
  updateOpenReleasesBtn?.addEventListener('click', async () => {
    const target = String(appState.updateInfo?.releasesPage || RELEASES_PAGE_URL);
    const result = await window.vmInstaller.openExternal(target);
    if (!result?.success) {
      _notify(`Could not open installer folder: ${result?.error || 'Unknown error'}`, 'error');
    }
  });
  updateOpenPatchFolderBtn?.addEventListener('click', async () => {
    const target = String(appState.updateInfo?.patchNotesPage || 'https://github.com/Jeet1511/VM-Manager/tree/main/Patch%20notes');
    const result = await window.vmInstaller.openExternal(target);
    if (!result?.success) {
      _notify(`Could not open patch notes folder: ${result?.error || 'Unknown error'}`, 'error');
    }
  });
  document.getElementById('setVmSharedBrowse')?.addEventListener('click', async () => {
    const selected = await window.vmInstaller.selectFolder('Select V Os shared folder path', document.getElementById('setVmSharedPath')?.value || '');
    if (selected) document.getElementById('setVmSharedPath').value = selected;
  });

  document.getElementById('setResetSection')?.addEventListener('click', () => {
    const activePane = document.querySelector(`.settings-scope-pane[data-settings-pane="${settingsState.scope}"]`);
    const activeSection = activePane?.querySelector('.settings-section.active');
    if (!activeSection) return;
    activeSection.querySelectorAll('[data-default]').forEach(resetControlToDefault);
    applyVisualEffectsModeFromSettings();
    _notify('Active section restored to defaults.', 'info');
  });

  document.getElementById('setResetAll')?.addEventListener('click', () => {
    const activePane = document.querySelector(`.settings-scope-pane[data-settings-pane="${settingsState.scope}"]`);
    if (!activePane) return;
    activePane.querySelectorAll('[data-default]').forEach(resetControlToDefault);
    applyVisualEffectsModeFromSettings();
    _notify('Current scope restored to defaults.', 'info');
  });

  saveGlobalBtn?.addEventListener('click', async () => {
    if (isSavingGlobal) return;
    isSavingGlobal = true;
    saveGlobalBtn.disabled = true;
    saveGlobalBtn.textContent = 'Saving...';
    try {
      const currentPrefs = _loadUiPrefs();
      const defaultUserNameInput = document.getElementById('setDefaultUserName')?.value?.trim() || 'user';
      const guestUserNameInput = document.getElementById('setGuestUserName')?.value?.trim() || 'guest';
      const linuxUserPattern = /^[a-z_][a-z0-9_-]{0,31}$/i;
      if (!linuxUserPattern.test(defaultUserNameInput)) {
        _notify('Default user username is invalid. Use letters/numbers/underscore/hyphen and start with a letter or underscore.', 'error');
        return;
      }
      if (!linuxUserPattern.test(guestUserNameInput)) {
        _notify('Guest username is invalid. Use letters/numbers/underscore/hyphen and start with a letter or underscore.', 'error');
        return;
      }

      const prefs = {
        installPath: document.getElementById('setInstallPath')?.value?.trim() || '',
        sharedFolderPath: document.getElementById('setSharedPath')?.value?.trim() || '',
        downloadPath: document.getElementById('setDownloadPath')?.value?.trim() || '',
        startFullscreen: !!document.getElementById('setStartFullscreen')?.checked,
        accelerate3d: !!document.getElementById('setAccelerate3d')?.checked,
        enableSharedFolder: !!(document.getElementById('setSharedPath')?.value?.trim()),
        defaultUserUsername: defaultUserNameInput,
        defaultUserPassword: document.getElementById('setDefaultUserPass')?.value ?? 'user',
        guestUsername: guestUserNameInput,
        guestPassword: document.getElementById('setGuestUserPass')?.value ?? 'guest',
        username: guestUserNameInput,
        password: document.getElementById('setGuestUserPass')?.value ?? 'guest',
        theme: 'dark',
        visualEffectsMode: document.getElementById('setVisualEffectsMode')?.value === 'full' ? 'full' : 'lite',
        language: document.getElementById('setLanguage')?.value || 'en',
        startupView: document.getElementById('setStartupView')?.value || 'dashboard',
        notificationLevel: document.getElementById('setNotificationLevel')?.value || 'important',
        virtualBoxPath: document.getElementById('setVBoxPath')?.value?.trim() || '',
        adminModePolicy: document.getElementById('setAdminModePolicy')?.value || 'manual',
        autoRepairLevel: document.getElementById('setAutoRepairLevel')?.value || 'safe',
        maxHostRamPercent: clamp(document.getElementById('setMaxHostRamPercent')?.value, 40, 95, 75),
        maxHostCpuPercent: clamp(document.getElementById('setMaxHostCpuPercent')?.value, 40, 95, 75),
        vmDefaultPreset: document.getElementById('setVmDefaultPreset')?.value || 'balanced',
        credentialStorage: document.getElementById('setCredentialStorage')?.value || 'keychain',
        telemetryEnabled: !!document.getElementById('setTelemetryEnabled')?.checked,
        trustedPaths: document.getElementById('setTrustedPaths')?.value?.trim() || '',
        logLevel: document.getElementById('setLogLevel')?.value || 'info',
        logRetentionDays: clamp(document.getElementById('setLogRetentionDays')?.value, 1, 365, 14),
        ignoredUpdateVersion: _normalizeVersionText(currentPrefs.ignoredUpdateVersion || ''),
        lastUpdateCheckAt: String(currentPrefs.lastUpdateCheckAt || '')
      };

      const normalizedPrefs = _saveUiPrefs(prefs);
      appState.installPath = normalizedPrefs.installPath;
      appState.sharedFolderPath = normalizedPrefs.sharedFolderPath;
      appState.downloadPath = normalizedPrefs.downloadPath;
      appState.startFullscreen = normalizedPrefs.startFullscreen !== false;
      appState.accelerate3d = normalizedPrefs.accelerate3d === true;
      appState.enableSharedFolder = !!normalizedPrefs.enableSharedFolder;
      appState.defaultUserUsername = normalizedPrefs.defaultUserUsername;
      appState.defaultUserPassword = normalizedPrefs.defaultUserPassword;
      appState.guestUsername = normalizedPrefs.guestUsername;
      appState.guestPassword = normalizedPrefs.guestPassword;
      appState.startupView = normalizedPrefs.startupView || 'dashboard';
      appState.language = normalizedPrefs.language;
      appState.notificationLevel = normalizedPrefs.notificationLevel;
      appState.adminModePolicy = normalizedPrefs.adminModePolicy;
      appState.autoRepairLevel = normalizedPrefs.autoRepairLevel;
      appState.maxHostRamPercent = normalizedPrefs.maxHostRamPercent;
      appState.maxHostCpuPercent = normalizedPrefs.maxHostCpuPercent;
      appState.vmDefaultPreset = normalizedPrefs.vmDefaultPreset;
      appState.credentialStorage = normalizedPrefs.credentialStorage;
      appState.telemetryEnabled = normalizedPrefs.telemetryEnabled === true;
      appState.trustedPaths = normalizedPrefs.trustedPaths || '';
      appState.logLevel = normalizedPrefs.logLevel || 'info';
      appState.logRetentionDays = normalizedPrefs.logRetentionDays || 14;
      const selectedAccountType = appState.accountType === 'user' ? 'user' : 'guest';
      appState.username = selectedAccountType === 'user' ? normalizedPrefs.defaultUserUsername : normalizedPrefs.guestUsername;
      appState.password = selectedAccountType === 'user' ? normalizedPrefs.defaultUserPassword : normalizedPrefs.guestPassword;
      _applyLanguagePreference(normalizedPrefs.language);
      _clampSetupResourcesToPolicy(appState);
      applyVisualEffectsModeFromSettings();

      const saved = await window.vmInstaller.saveUiPrefs(normalizedPrefs);
      if (!saved?.success) {
        _notify(`Settings saved locally, but disk sync failed: ${saved?.error || 'Unknown error'}`, 'error');
        return;
      }
      _trackTelemetry('settings_saved', {
        scope: 'global',
        credentialStorage: normalizedPrefs.credentialStorage,
        notificationLevel: normalizedPrefs.notificationLevel,
        language: normalizedPrefs.language
      });
      _notify('VM Xposed settings saved.', 'success');
    } catch (err) {
      _notify(`Failed to save VM Xposed settings: ${err?.message || 'Unknown error'}`, 'error');
    } finally {
      isSavingGlobal = false;
      saveGlobalBtn.disabled = false;
      saveGlobalBtn.textContent = 'Save VM Xposed Settings';
    }
  });

  document.getElementById('setVmFixAll')?.addEventListener('click', async () => {
    const vm = findSelectedVm();
    if (!vm) {
      _notify('Select a V Os first.', 'error');
      return;
    }
    if (typeof Dashboard !== 'undefined' && typeof Dashboard._runOneClickRepair === 'function') {
      await Dashboard._runOneClickRepair(vm, app);
      await loadVmList(vm.name);
      return;
    }
    _notify('Fix All is unavailable right now.', 'error');
  });

  document.getElementById('setVmManage')?.addEventListener('click', async () => {
    const vm = findSelectedVm();
    if (!vm) return;
    if (typeof Dashboard !== 'undefined' && typeof Dashboard._openGuestIntegrationModal === 'function') {
      await Dashboard._openGuestIntegrationModal(vm, app);
      await loadVmList(vm.name);
      return;
    }
    _notify('Guest Setup modal is unavailable right now.', 'error');
  });

  document.getElementById('setVmAccounts')?.addEventListener('click', async () => {
    const vm = findSelectedVm();
    if (!vm) return;
    if (typeof Dashboard !== 'undefined' && typeof Dashboard._openAccountsModal === 'function') {
      await Dashboard._openAccountsModal(vm);
      return;
    }
    _notify('Account management modal is unavailable right now.', 'error');
  });

  document.getElementById('setVmBootFix')?.addEventListener('click', async () => {
    const vm = findSelectedVm();
    if (!vm) return;
    const result = await window.vmInstaller.bootFixVM(vm.name);
    if (!result?.success) {
      _notify(result?.error || 'Boot diagnostics failed.', 'error');
      return;
    }
    _notify('Boot diagnostics completed.', 'success');
  });

  document.getElementById('setVmOpenStorage')?.addEventListener('click', async () => {
    const vm = findSelectedVm();
    if (!vm) return;
    const result = await window.vmInstaller.showVMInExplorer(vm.name);
    if (!result?.success) {
      _notify(result?.error || 'Could not open V Os folder.', 'error');
      return;
    }
  });

  saveVmBtn?.addEventListener('click', async () => {
    if (isSavingVm) return;
    const vm = findSelectedVm();
    if (!vm) {
      _notify('Select a V Os first.', 'error');
      return;
    }

    isSavingVm = true;
    saveVmBtn.disabled = true;
    saveVmBtn.textContent = 'Saving...';
    try {
      const sharedPath = document.getElementById('setVmSharedPath')?.value?.trim() || '';
      const payload = {
        ram: clamp(document.getElementById('setVmRam')?.value, 512, 1048576, vm.ram || 2048),
        cpus: clamp(document.getElementById('setVmCpus')?.value, 1, 64, vm.cpus || 2),
        vram: clamp(document.getElementById('setVmVram')?.value, 16, 1024, vm.vram || 128),
        graphicsController: document.getElementById('setVmGraphics')?.value || 'vmsvga',
        audioController: document.getElementById('setVmAudioController')?.value || 'hda',
        bootOrder: [
          document.getElementById('setVmBoot1')?.value || 'disk',
          document.getElementById('setVmBoot2')?.value || 'dvd',
          document.getElementById('setVmBoot3')?.value || 'none',
          document.getElementById('setVmBoot4')?.value || 'none'
        ],
        clipboardMode: document.getElementById('setVmClipboard')?.value || 'bidirectional',
        dragAndDrop: document.getElementById('setVmDnD')?.value || 'bidirectional',
        fullscreenEnabled: !!document.getElementById('setVmDisplayFit')?.checked,
        audioEnabled: !!document.getElementById('setVmAudio')?.checked,
        usbEnabled: !!document.getElementById('setVmUsb')?.checked,
        accelerate3d: !!document.getElementById('setVm3d')?.checked,
        efiEnabled: (document.getElementById('setVmFirmware')?.value || 'bios') === 'efi',
        nestedVirtualization: !!document.getElementById('setVmNested')?.checked,
        networkMode: document.getElementById('setVmNetworkMode')?.value || 'nat',
        sharedFolders: sharedPath ? [{ name: 'shared', hostPath: sharedPath, autoMount: true }] : []
      };

      const result = await window.vmInstaller.editVM(vm.name, payload);
      if (!result?.success) {
        _notify(result?.error || 'Failed to save V Os settings.', 'error');
        return;
      }
      const warnings = Array.isArray(result?.warnings) ? result.warnings.filter(Boolean) : [];
      if (warnings.length > 0) {
        const firstWarning = String(warnings[0]);
        const extra = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : '';
        const warningType = /wayland|xorg|requires|failed|outside trusted paths/i.test(firstWarning) ? 'error' : 'info';
        _notify(`V Os settings saved with note: ${firstWarning}${extra}`, warningType);
      } else {
        _notify('V Os settings saved.', 'success');
      }
      await loadVmList(vm.name);
    } catch (err) {
      _notify(`Failed to save V Os settings: ${err?.message || 'Unknown error'}`, 'error');
    } finally {
      isSavingVm = false;
      saveVmBtn.disabled = false;
      saveVmBtn.textContent = 'Save V Os Settings';
    }
  });

  setScope(settingsState.scope || 'global');
  renderUpdateState(appState.updateInfo || {});
  window.vmInstaller.getAppVersion?.().then((versionResult) => {
    if (versionResult?.success) {
      appState.updateInfo = {
        ...(appState.updateInfo || {}),
        currentVersion: _normalizeVersionText(versionResult.version || '')
      };
      renderUpdateState(appState.updateInfo);
    }
  }).catch(() => {
    console.warn('[Settings] Failed to read current app version.');
  });
  if (!appState.updateInfo?.checkedAt) {
    refreshUpdateState({ force: false, notifyOnError: false }).catch(() => {
      console.warn('[Settings] Initial update check failed.');
    });
  }
  loadVmList(settingsState.selectedVmName).catch(() => {
    _notify('Could not load V Os list for settings.', 'error');
  });
}

// ─── View Routing ──────────────────────────────────────────────────────

const app = {
  showDashboard() {
    if (typeof Dashboard !== 'undefined' && Dashboard.stopLiveSync) {
      Dashboard.stopLiveSync();
    }
    _clearRealtimePanelTimer();
    appState.currentView = 'dashboard';
    appState.isRunning = false;

    _setActiveNav('dashboard');
    _setPrimaryCta('dashboard');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = _renderOverview();
    _initOverview();
    _saveSessionState(_captureSessionState(appState));
  },

  showMachines() {
    _clearRealtimePanelTimer();
    appState.currentView = 'machines';
    appState.isRunning = false;

    _setActiveNav('machines');
    _setPrimaryCta('machines');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = Dashboard.render(appState);
    Dashboard.init(appState, app);
    _saveSessionState(_captureSessionState(appState));
  },

  showVmBootstrap(message = 'No V Os found. Set up or import one to continue.') {
    if (typeof Dashboard !== 'undefined' && Dashboard.stopLiveSync) {
      Dashboard.stopLiveSync();
    }
    _clearRealtimePanelTimer();

    _setActiveNav('machines');
    appState.vmBootstrapFlow.panel = 'empty';
    appState.vmBootstrapFlow.panelEnter = '';
    _showVmBootstrapPanel(message);
    _saveSessionState(_captureSessionState(appState));
  },

  showWizard(options = {}) {
    if (typeof Dashboard !== 'undefined' && Dashboard.stopLiveSync) {
      Dashboard.stopLiveSync();
    }
    _clearRealtimePanelTimer();
    appState.currentView = 'wizard';
    const requestedStep = Number(options?.startStep);
    appState.currentStep = Number.isFinite(requestedStep)
      ? Math.max(0, Math.min(STEPS.length - 1, Math.round(requestedStep)))
      : 0;
    const openingFreshWizard = appState.currentStep === 0 && options?.preserveConfig !== true;
    if (openingFreshWizard && !appState.useExistingVm) {
      _applyVmPresetDefaults(appState);
    } else {
      _clampSetupResourcesToPolicy(appState);
    }

    _setActiveNav('wizard');
    _setPrimaryCta('wizard');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'flex';

    window.vmInstaller.listVMs()
      .then((result) => {
        if (result?.success) {
          appState.existingVMs = result.vms || [];
          if (appState.existingVmName && !appState.existingVMs.some((vm) => vm.name === appState.existingVmName)) {
            appState.existingVmName = appState.existingVMs[0]?.name || '';
          }
        }
      })
      .catch(() => {});

    renderStep(Number.isFinite(Number(appState.currentStep)) ? Number(appState.currentStep) : 0);
    _saveSessionState(_captureSessionState(appState));
  },

  showLibrary() {
    if (typeof Dashboard !== 'undefined' && Dashboard.stopLiveSync) {
      Dashboard.stopLiveSync();
    }
    _clearRealtimePanelTimer();
    appState.currentView = 'library';
    appState.isRunning = false;

    _setActiveNav('library');
    _setPrimaryCta('library');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = _renderLibrary(appState);
    _initLibrary();
    _saveSessionState(_captureSessionState(appState));
  },

  showSnapshots() {
    if (typeof Dashboard !== 'undefined' && Dashboard.stopLiveSync) {
      Dashboard.stopLiveSync();
    }
    _clearRealtimePanelTimer();
    appState.currentView = 'snapshots';
    appState.isRunning = false;

    _setActiveNav('snapshots');
    _setPrimaryCta('snapshots');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = _renderSnapshots();
    _initSnapshots();
    _saveSessionState(_captureSessionState(appState));
  },

  showStorage() {
    if (typeof Dashboard !== 'undefined' && Dashboard.stopLiveSync) {
      Dashboard.stopLiveSync();
    }
    _clearRealtimePanelTimer();
    appState.currentView = 'storage';
    appState.isRunning = false;

    _setActiveNav('storage');
    _setPrimaryCta('storage');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = _renderStorage();
    _initStorage();
    _saveSessionState(_captureSessionState(appState));
  },

  showNetwork() {
    if (typeof Dashboard !== 'undefined' && Dashboard.stopLiveSync) {
      Dashboard.stopLiveSync();
    }
    _clearRealtimePanelTimer();
    appState.currentView = 'network';
    appState.isRunning = false;

    _setActiveNav('network');
    _setPrimaryCta('network');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = _renderNetwork();
    _initNetwork();
    _saveSessionState(_captureSessionState(appState));
  },

  showSettings(options = {}) {
    const previousView = appState.currentView;
    if (previousView && previousView !== 'settings') {
      appState.settingsReturnView = previousView;
    }
    if (typeof Dashboard !== 'undefined' && Dashboard.stopLiveSync) {
      Dashboard.stopLiveSync();
    }
    _clearRealtimePanelTimer();
    appState.currentView = 'settings';
    appState.isRunning = false;

    _setActiveNav('settings');
    _setPrimaryCta('settings');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = _renderSettings(options || {});
    _initSettings(options || {});
    _saveSessionState(_captureSessionState(appState));
  },

  showDownload() {
    if (typeof Dashboard !== 'undefined' && Dashboard.stopLiveSync) {
      Dashboard.stopLiveSync();
    }
    _clearRealtimePanelTimer();
    appState.currentView = 'download';
    appState.isRunning = false;

    _setActiveNav('download');
    _setPrimaryCta('download');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = _renderDownload();
    _initDownload();
    _saveSessionState(_captureSessionState(appState));
  },

  showCredits() {
    if (typeof Dashboard !== 'undefined' && Dashboard.stopLiveSync) {
      Dashboard.stopLiveSync();
    }
    _clearRealtimePanelTimer();
    appState.currentView = 'credits';
    appState.isRunning = false;

    _setActiveNav('credits');
    _setPrimaryCta('credits');
    const stepIndicator = document.getElementById('stepIndicator');
    if (stepIndicator) stepIndicator.style.display = 'none';

    const container = document.getElementById('wizardContainer');
    container.innerHTML = _renderCredits();
    _initCredits();
    _saveSessionState(_captureSessionState(appState));
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
      installPath: savedConfig.installPath ?? appState.installPath,
      ram: savedConfig.ram || appState.ram,
      cpus: savedConfig.cpus || appState.cpus,
      disk: savedConfig.disk || appState.disk,
      osName: savedConfig.osName || appState.osName,
      ubuntuVersion: savedConfig.ubuntuVersion || appState.ubuntuVersion,
      isoSource: savedConfig.isoSource || appState.isoSource,
      customIsoPath: savedConfig.customIsoPath || appState.customIsoPath,
      network: savedConfig.network || appState.network,
      downloadPath: savedConfig.downloadPath ?? appState.downloadPath,
      clipboardMode: savedConfig.clipboardMode || appState.clipboardMode,
      dragAndDrop: savedConfig.dragAndDrop || appState.dragAndDrop,
      startFullscreen: savedConfig.startFullscreen !== false,
      accelerate3d: savedConfig.accelerate3d === true,
      enableSharedFolder: !!savedConfig.enableSharedFolder,
      accountType: savedConfig.accountType || appState.accountType,
      sharedFolderPath: savedConfig.sharedFolderPath ?? appState.sharedFolderPath,
      username: savedConfig.username || appState.username,
      password: savedConfig.password || appState.password,
      useExistingVm: !!savedConfig.useExistingVm,
      existingVmName: savedConfig.existingVmName || appState.existingVmName,
      existingVmFolder: savedConfig.existingVmFolder || appState.existingVmFolder
    });

    appState.currentStep = 2; // Jump to install step
    startSetupWithResume(resumeFrom);
  },

  async startFresh() {
    await window.vmInstaller.clearSavedState();
    appState.resumeInfo = null;
    appState.accelerate3d = false;
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

  _saveSessionState(_captureSessionState(appState));

  const btnNext = document.getElementById('btnNext');
  const btnBack = document.getElementById('btnBack');

  btnNext?.addEventListener('click', () => {
    const activeStep = STEPS[appState.currentStep];
    if (activeStep?.validate) {
      const result = activeStep.validate(appState);
      if (!result.valid) {
        _notify(result.message || 'Please complete required fields.', 'error');
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

async function _ensureAdminForTask(taskName = 'this work') {
  try {
    if (!window.vmInstaller?.isAdmin) {
      return true;
    }

    const isAdmin = await _refreshAdminFloatingCta({ force: true });
    if (isAdmin) return true;

    _focusAdminFloatingCta(`"${taskName}" requires administrator mode.`);
    _notify(`"${taskName}" requires administrator mode. Use Continue with Admin Privilege.`, 'info');
    return false;
  } catch (err) {
    _notify(err?.message || 'Could not verify administrator mode.', 'error');
    return false;
  }
}

// ─── Setup Execution ──────────────────────────────────────────────────

function startSetup() {
  _runSetup(null);
}

function startSetupWithResume(resumeFrom) {
  _runSetup(resumeFrom);
}

async function _runSetup(resumeFrom) {
  const adminReady = await _ensureAdminForTask('V Os setup and operating system configuration');
  if (!adminReady) return;

  _clampSetupResourcesToPolicy(appState);
  if (appState.enableSharedFolder && String(appState.sharedFolderPath || '').trim()) {
    const selectedSharePath = String(appState.sharedFolderPath || '').trim();
    if (!_isPathTrustedByPolicy(selectedSharePath, appState.trustedPaths)) {
      const mergedTrustedPaths = _mergeTrustedPaths(appState.trustedPaths, [selectedSharePath]);
      appState.trustedPaths = mergedTrustedPaths;
      try {
        await _persistUiPrefsPatch({ trustedPaths: mergedTrustedPaths });
      } catch (err) {
        console.warn('Could not persist trusted path patch before setup:', err);
      }
    }
    const trusted = _isPathTrustedByPolicy(selectedSharePath, appState.trustedPaths);
    if (!trusted) {
      _notify('Selected shared folder path is outside Trusted Paths. Update Security & Privacy settings first.', 'error');
      return;
    }
  }

  if (appState.currentView !== 'vm-bootstrap') {
    appState.vmBootstrapFlow.launchedFromBootstrap = false;
  }

  appState.isRunning = true;
  appState.cancelRequested = false;
  appState.pauseRequested = false;
  appState.currentStep = 2;

  // Hide step indicator and nav during setup
  const stepIndicator = document.getElementById('stepIndicator');
  if (stepIndicator) stepIndicator.style.display = 'none';

  // Show progress panel
  const container = document.getElementById('wizardContainer');
  container.innerHTML = ProgressPanel.render({
    vmName: appState.vmName || 'My V Os',
    osName: appState.osName,
    ubuntuVersion: appState.ubuntuVersion
  });
  let setupPhases = [];
  try {
    setupPhases = await window.vmInstaller.getPhases?.();
  } catch {
    setupPhases = [];
  }
  ProgressPanel.initializePhases(Array.isArray(setupPhases) ? setupPhases : []);

  let activeSetupPhase = '';
  const pauseableDownloadPhases = new Set(['download_iso', 'download_vbox']);
  const syncPauseSetupButton = () => {
    const pauseBtn = document.getElementById('btnPauseSetup');
    if (!pauseBtn) return;
    const canPause = appState.isRunning
      && !appState.cancelRequested
      && !appState.pauseRequested
      && pauseableDownloadPhases.has(activeSetupPhase);
    pauseBtn.disabled = !canPause;
  };

  document.getElementById('btnBackToDash')?.addEventListener('click', () => {
    if (!appState.isRunning) app.backToDashboard();
  });

  document.getElementById('btnPauseSetup')?.addEventListener('click', async () => {
    if (!appState.isRunning || appState.cancelRequested || appState.pauseRequested) return;
    if (!pauseableDownloadPhases.has(activeSetupPhase)) {
      _notify('Pause is available only while a download is active.', 'info');
      return;
    }

    if (!window.vmInstaller?.pauseSetup) {
      _notify('Pause is not available in this build.', 'error');
      return;
    }

    appState.pauseRequested = true;
    const pauseBtn = document.getElementById('btnPauseSetup');
    const cancelBtn = document.getElementById('btnCancelSetup');
    if (pauseBtn) {
      pauseBtn.disabled = true;
      pauseBtn.textContent = 'Pausing...';
    }
    if (cancelBtn) cancelBtn.disabled = true;

    ProgressPanel.updateInstallPhase({ id: 'pause', label: 'Pausing Download', status: 'active', message: 'Saving progress and pausing current download...' });
    const paused = await window.vmInstaller.pauseSetup();
    if (!paused?.paused) {
      appState.pauseRequested = false;
      if (pauseBtn) pauseBtn.textContent = 'Pause Download';
      if (cancelBtn && !appState.cancelRequested) cancelBtn.disabled = false;
      syncPauseSetupButton();
      _notify(paused?.error || 'Pause is only available while a download is active.', 'error');
    }
  });

  document.getElementById('btnCancelSetup')?.addEventListener('click', async () => {
    if (!appState.isRunning) return;
    const confirmed = window.confirm('Cancel setup? Current progress will be saved for resume.');
    if (!confirmed) return;

    appState.cancelRequested = true;
    appState.pauseRequested = false;
    const pauseBtn = document.getElementById('btnPauseSetup');
    if (pauseBtn) {
      pauseBtn.disabled = true;
      pauseBtn.textContent = 'Pause Download';
    }
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
    if (data?.id) {
      if (data?.status === 'active') {
        activeSetupPhase = data.id;
      } else if (data.id === activeSetupPhase && ['complete', 'error', 'skipped'].includes(data.status)) {
        activeSetupPhase = '';
      }
    }
    syncPauseSetupButton();
    ProgressPanel.updateInstallPhase(data);
    ProgressPanel.updatePhase(data);
  });

  window.vmInstaller.onProgress((data) => {
    if (data?.phase) {
      activeSetupPhase = data.phase;
    }
    syncPauseSetupButton();
    ProgressPanel.updateInstallProgress(data);
    ProgressPanel.updateProgress({ ...data, id: data.id || data.phase });
  });

  syncPauseSetupButton();

  window.vmInstaller.onLog((entry) => {
    ProgressPanel.addLog(entry);
  });

  window.vmInstaller.onComplete((data) => {
    _trackTelemetry('setup_completed', {
      vmName: data?.vmName || appState.vmName || '',
      guestConfigured: data?.guestConfigured === true
    });
    showComplete(data);
  });

  let setupErrorHandledByStream = false;
  window.vmInstaller.onError((data) => {
    _trackTelemetry('setup_error', {
      phase: data?.phase || '',
      message: data?.message || ''
    });
    setupErrorHandledByStream = true;
    showError(data);
  });

  // Build config
  const config = {
    vmName: appState.vmName || 'My V Os',
    installPath: appState.installPath,
    ram: appState.ram,
    cpus: appState.cpus,
    disk: appState.disk,
    osName: appState.osName,
    ubuntuVersion: appState.ubuntuVersion,
    customIsoPath: appState.customIsoPath,
    isoSource: appState.isoSource,
    network: appState.network,
    downloadPath: appState.downloadPath,
    clipboardMode: appState.clipboardMode,
    dragAndDrop: appState.dragAndDrop,
    startFullscreen: appState.startFullscreen !== false,
    accelerate3d: appState.accelerate3d === true,
    autoStartVm: false,
    enableSharedFolder: !!appState.enableSharedFolder,
    accountType: appState.accountType || 'guest',
    sharedFolderPath: appState.sharedFolderPath,
    username: appState.username,
    password: appState.password,
    useExistingVm: !!appState.useExistingVm,
    existingVmName: appState.existingVmName || '',
    existingVmFolder: appState.existingVmFolder || ''
  };
  _trackTelemetry('setup_started', {
    vmDefaultPreset: appState.vmDefaultPreset,
    ram: config.ram,
    cpus: config.cpus,
    accountType: config.accountType
  });

  if (resumeFrom) {
    config._resumeFrom = resumeFrom;
  }

  if (config.isoSource !== 'custom') {
    config.customIsoPath = '';
  }

  const result = await window.vmInstaller.startSetup(config);

  if (result && !result.success && result.error && !setupErrorHandledByStream) {
    showError({
      message: result.error,
      paused: appState.pauseRequested,
      cancelled: appState.cancelRequested
    });
  }
}

// ─── Completion & Error Views ──────────────────────────────────────────

function showComplete(data) {
  const summaryMessage = data?.message || 'Setup complete.';
  ProgressPanel.updateInstallProgress({ percent: 100, message: summaryMessage });
  ProgressPanel.updateInstallPhase({
    id: 'complete',
    label: 'Complete',
    status: 'complete',
    message: data?.autoStartVm === true ? 'V Os ready' : 'Manual start required'
  });

  const container = document.getElementById('wizardContainer');
  container.innerHTML = ProgressPanel.renderComplete(data);

  document.getElementById('btnLaunchVm')?.addEventListener('click', async () => {
    const launchBtn = document.getElementById('btnLaunchVm');
    const launchLabel = launchBtn?.textContent || 'Launch VM';
    const vmName = data?.vmName || appState.vmName;
    if (!vmName) {
      _notify('No VM name found to launch.', 'error');
      return;
    }

    if (launchBtn) {
      launchBtn.disabled = true;
      launchBtn.textContent = 'Launching...';
    }

    try {
      const launched = await window.vmInstaller.startVM(vmName);
      if (!launched?.success) {
        _notify(launched?.error || 'Could not launch virtual machine.', 'error');
        if (launchBtn) {
          launchBtn.disabled = false;
          launchBtn.textContent = launchLabel;
        }
        return;
      }
      _notify(`Virtual machine "${vmName}" launched.`, 'success');
      app.showMachines();
    } catch (err) {
      _notify(err?.message || 'Could not launch virtual machine.', 'error');
      if (launchBtn) {
        launchBtn.disabled = false;
        launchBtn.textContent = launchLabel;
      }
    }
  });

  document.getElementById('btnBackToDash')?.addEventListener('click', () => {
    app.backToDashboard();
  });

  appState.isRunning = false;
  appState.cancelRequested = false;
  appState.pauseRequested = false;
  appState.vmBootstrapFlow.launchedFromBootstrap = false;
  window.vmInstaller.removeAllListeners();
}

async function _resumeSetupFromCheckpoint() {
  try {
    appState.resumeInfo = await window.vmInstaller.checkForResume();
  } catch (err) {
    console.warn('Resume lookup failed:', err);
    appState.resumeInfo = null;
  }

  if (appState.resumeInfo?.resumeFrom) {
    app.resumeSetup();
    return;
  }

  _notify('No resumable setup was found. Opening customization wizard.', 'info');
  app.showWizard();
}

function showError(error) {
  const errorPayload = typeof error === 'string' ? { message: error } : (error || {});
  const message = String(errorPayload.message || 'Setup failed');
  const paused = !!errorPayload.paused || appState.pauseRequested || /pause/i.test(message);
  const cancelled = !paused && (!!errorPayload.cancelled || appState.cancelRequested || /cancel/i.test(message));

  if (cancelled && appState.vmBootstrapFlow.launchedFromBootstrap) {
    appState.isRunning = false;
    appState.cancelRequested = false;
    appState.pauseRequested = false;
    appState.vmBootstrapFlow.launchedFromBootstrap = false;
    window.vmInstaller.removeAllListeners();
    appState.vmBootstrapFlow.panel = 'empty';
    appState.vmBootstrapFlow.panelEnter = 'from-left';
    appState.vmBootstrapFlow.statusMessage = 'Setup was canceled. You can continue anytime.';
    _showVmBootstrapPanel(appState.vmBootstrapFlow.statusMessage);
    return;
  }

  if (paused) {
    ProgressPanel.updateInstallPhase({ id: 'pause', label: 'Setup Paused', status: 'skipped', message: 'Download paused. Resume when you are ready.' });
  } else {
    ProgressPanel.updateInstallPhase({ id: 'error', label: 'Installation Failed', status: 'error', message: typeof error === 'string' ? error : 'Setup failed' });
  }

  const container = document.getElementById('wizardContainer');
  container.innerHTML = (cancelled || paused)
    ? ProgressPanel.renderCancelled(paused ? 'Download paused. Your progress is saved, and you can resume later.' : message)
    : ProgressPanel.renderError(error);

  document.getElementById('btnRetry')?.addEventListener('click', async () => {
    appState.isRunning = false;
    window.vmInstaller.removeAllListeners();
    await _resumeSetupFromCheckpoint();
  });

  document.getElementById('btnBackToDash')?.addEventListener('click', () => {
    app.backToDashboard();
  });

  appState.isRunning = false;
  appState.cancelRequested = false;
  appState.pauseRequested = false;
  appState.vmBootstrapFlow.launchedFromBootstrap = false;
  window.vmInstaller.removeAllListeners();
}

// ─── Initialization ────────────────────────────────────────────────────

async function initApp() {
  try {
    _initBrandingAssets();
    _bindVBoxEnsureProgressListener();
    _ensureAdminFloatingCtaMounted();

    // Load defaults from main process
    appState.defaults = await window.vmInstaller.getDefaults();
    appState.installPath = appState.defaults.defaultInstallPath;
    appState.downloadPath = appState.defaults.defaultDownloadDir;
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

    let savedPrefs = _loadUiPrefs();
    try {
      const diskPrefs = await window.vmInstaller.getUiPrefs();
      if (diskPrefs?.success && diskPrefs.prefs && typeof diskPrefs.prefs === 'object') {
        const mergedPrefs = _normalizeUiPrefs({ ...savedPrefs, ...diskPrefs.prefs });
        _saveUiPrefs(mergedPrefs);
        savedPrefs = _loadUiPrefs();
      }
    } catch (err) {
      console.warn('Disk UI prefs load failed:', err);
    }

    const savedCatalogMeta = _loadCatalogRefreshMeta();
    const savedSession = _loadSessionState();
    const savedBootstrapPrefs = _loadVmBootstrapPrefs();
    if (savedPrefs.installPath !== undefined) appState.installPath = savedPrefs.installPath;
    if (savedPrefs.downloadPath !== undefined) appState.downloadPath = savedPrefs.downloadPath;
    if (savedPrefs.sharedFolderPath !== undefined) appState.sharedFolderPath = savedPrefs.sharedFolderPath;
    appState.startFullscreen = savedPrefs.startFullscreen !== false;
    appState.accelerate3d = savedPrefs.accelerate3d === true;
    appState.startupView = savedPrefs.startupView || 'dashboard';
    appState.language = savedPrefs.language || 'en';
    appState.notificationLevel = savedPrefs.notificationLevel || 'important';
    appState.adminModePolicy = savedPrefs.adminModePolicy || 'manual';
    appState.autoRepairLevel = savedPrefs.autoRepairLevel || 'safe';
    appState.maxHostRamPercent = savedPrefs.maxHostRamPercent || 75;
    appState.maxHostCpuPercent = savedPrefs.maxHostCpuPercent || 75;
    appState.vmDefaultPreset = savedPrefs.vmDefaultPreset || 'balanced';
    appState.credentialStorage = savedPrefs.credentialStorage || 'keychain';
    appState.telemetryEnabled = savedPrefs.telemetryEnabled === true;
    appState.trustedPaths = String(savedPrefs.trustedPaths || '');
    appState.logLevel = savedPrefs.logLevel || 'info';
    appState.logRetentionDays = savedPrefs.logRetentionDays || 14;
    if (savedPrefs.enableSharedFolder !== undefined) appState.enableSharedFolder = !!savedPrefs.enableSharedFolder;
    appState.defaultUserUsername = String(savedPrefs.defaultUserUsername || appState.defaultUserUsername || 'user').trim() || 'user';
    appState.defaultUserPassword = String(savedPrefs.defaultUserPassword ?? appState.defaultUserPassword ?? 'user');
    appState.guestUsername = String(savedPrefs.guestUsername || savedPrefs.username || appState.guestUsername || appState.username || 'guest').trim() || 'guest';
    appState.guestPassword = String(savedPrefs.guestPassword ?? savedPrefs.password ?? appState.guestPassword ?? appState.password ?? 'guest');
    if (!appState.defaultUserPassword) appState.defaultUserPassword = 'user';
    if (!appState.guestPassword) appState.guestPassword = 'guest';
    const activeAccountType = appState.accountType === 'user' ? 'user' : 'guest';
    appState.username = activeAccountType === 'user' ? appState.defaultUserUsername : appState.guestUsername;
    appState.password = activeAccountType === 'user' ? appState.defaultUserPassword : appState.guestPassword;
    _applyLanguagePreference(appState.language);
    _clampSetupResourcesToPolicy(appState);
    appState.catalogRefreshMeta = savedCatalogMeta;
    appState.vmBootstrapFlow.selectedOption = savedBootstrapPrefs.lastOption || appState.vmBootstrapFlow.selectedOption;
    appState.vmBootstrapFlow.selectedVmType = savedBootstrapPrefs.selectedVmType || appState.osName;
    appState.vmBootstrapFlow.downloadFolder = savedBootstrapPrefs.downloadFolder || appState.installPath;
    appState.vmBootstrapFlow.importFolder = savedBootstrapPrefs.importFolder || '';

    try {
      const vmListResult = await window.vmInstaller.listVMs();
      if (vmListResult?.success) {
        appState.existingVMs = vmListResult.vms || [];
        if (!appState.existingVmName && appState.existingVMs.length > 0) {
          appState.existingVmName = appState.existingVMs[0].name;
        }
      }
    } catch (err) {
      console.warn('Existing V Os detection failed:', err);
      appState.existingVMs = [];
    }

    _applySessionState(appState, savedSession);

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
    document.getElementById('navSnapshots')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showSnapshots();
    });
    document.getElementById('navStorage')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showStorage();
    });
    document.getElementById('navNetwork')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showNetwork();
    });

    document.getElementById('navDownload')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showDownload();
    });

    document.getElementById('navSettings')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showSettings({ scope: 'global', section: 'general', lockScope: true });
    });

    document.getElementById('navCredits')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showCredits();
    });

    document.getElementById('btnTopNewVM')?.addEventListener('click', () => {
      if (!appState.isRunning) app.showWizard();
    });
    document.getElementById('btnTopImportVM')?.addEventListener('click', () => {
      if (!appState.isRunning) _openImportWizard();
    });

    window.addEventListener('focus', () => {
      _refreshAdminFloatingCta();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) _refreshAdminFloatingCta();
    });

    const startViewPreference = String(
      appState.startupView
      || savedSession?.lastView
      || appState.currentView
      || 'dashboard'
    );
    const startView = startViewPreference.toLowerCase();
    if (startView === 'machines') app.showMachines();
    else if (startView === 'wizard') app.showWizard();
    else if (startView === 'library') app.showLibrary();
    else if (startView === 'snapshots') app.showSnapshots();
    else if (startView === 'storage') app.showStorage();
    else if (startView === 'network') app.showNetwork();
    else if (startView === 'settings') app.showSettings({ scope: 'global', section: 'general', lockScope: true });
    else if (startView === 'download') app.showDownload();
    else if (startView === 'credits') app.showCredits();
    else app.showDashboard();

    window.vmxAdminAccess = {
      refresh: (force = false) => _refreshAdminFloatingCta({ force: !!force }),
      focus: (reason = '') => _focusAdminFloatingCta(reason)
    };
    _refreshAdminFloatingCta({ force: true });

    window.setTimeout(() => {
      _checkForAppUpdates({
        force: true,
        notifyOnUpdate: true,
        notifyOnNoUpdate: false,
        notifyOnError: false
      }).catch(() => {
        console.warn('[Updater] Startup update check failed.');
      });
    }, 2200);

    // Check VirtualBox at startup and wait for explicit user confirmation before installing.
    _ensureVirtualBoxOnStartup();

    // Keep OS options fresh without blocking app startup.
    _refreshCatalogInBackground();
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

const LAYOUT_BASE_WIDTH = 1366;
const LAYOUT_BASE_HEIGHT = 768;
const LAYOUT_MIN_SCALE = 0.74;

function _applyViewportScale() {
  const widthScale = window.innerWidth / LAYOUT_BASE_WIDTH;
  const heightScale = window.innerHeight / LAYOUT_BASE_HEIGHT;
  const nextScale = Math.min(1, widthScale, heightScale);
  const safeScale = Number.isFinite(nextScale) ? Math.max(LAYOUT_MIN_SCALE, nextScale) : 1;
  document.documentElement.style.setProperty('--layout-scale', safeScale.toFixed(4));
}

// Start the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  _applyLanguagePreference(_loadUiPrefs().language || 'en');
  _applyVisualEffectsMode(_resolveVisualEffectsMode());
  _applyViewportScale();
  _ensureMotionSystemMounted();
  _validateMotionVisibility();
  _setSystemFlowActivity();
  initApp();
});

window.addEventListener('beforeunload', () => {
  _saveSessionState(_captureSessionState(appState));
});

const pointerState = {
  x: window.innerWidth * 0.5,
  y: window.innerHeight * 0.5,
  rafId: null,
  cards: [],
  canAnimate: true
};

function refreshPointerTargets() {
  pointerState.cards = Array.from(document.querySelectorAll('.vm-card, .onboard-panel, .onboard-option-card, .onboard-illustration'));
}

function resolveMotionPreference() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const supportsHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  pointerState.canAnimate = !_isLiteVisualMode() && !reduceMotion && supportsHover;
}

function applyPointerEffects() {
  if (!pointerState.canAnimate) {
    pointerState.rafId = null;
    return;
  }

  const { innerWidth, innerHeight } = window;
  const x = (pointerState.x / innerWidth - 0.5) * 2;
  const y = (pointerState.y / innerHeight - 0.5) * 2;

  pointerState.cards.forEach((card) => {
    const rx = y * -6;
    const ry = x * 6;
    card.style.setProperty('--rx', `${rx}deg`);
    card.style.setProperty('--ry', `${ry}deg`);
    card.style.setProperty('--onboard-rx', `${rx * 0.35}deg`);
    card.style.setProperty('--onboard-ry', `${ry * 0.35}deg`);
    card.style.setProperty('--shadowX', `${x * 20}px`);
    card.style.setProperty('--shadowY', `${y * 20}px`);
  });

  const light = document.querySelector('.cursor-light');
  if (light) {
    light.style.setProperty('--cursor-x', `${pointerState.x}px`);
    light.style.setProperty('--cursor-y', `${pointerState.y}px`);
  }

  pointerState.rafId = null;
}

function resetPointerEffects() {
  pointerState.cards.forEach((card) => {
    card.style.removeProperty('--rx');
    card.style.removeProperty('--ry');
    card.style.removeProperty('--onboard-rx');
    card.style.removeProperty('--onboard-ry');
    card.style.removeProperty('--shadowX');
    card.style.removeProperty('--shadowY');
  });
}

resolveMotionPreference();
refreshPointerTargets();

if (!_isLiteVisualMode()) {
  const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  motionMedia.addEventListener('change', () => {
    resolveMotionPreference();
    if (!pointerState.canAnimate) {
      resetPointerEffects();
    }
  });

  const pointerTargetObserver = new MutationObserver(() => {
    refreshPointerTargets();
  });

  pointerTargetObserver.observe(document.body, {
    subtree: true,
    childList: true
  });

  document.addEventListener('mousemove', (e) => {
    if (!pointerState.canAnimate) {
      return;
    }

    pointerState.x = e.clientX;
    pointerState.y = e.clientY;

    if (pointerState.rafId === null) {
      pointerState.rafId = requestAnimationFrame(applyPointerEffects);
    }
  }, { passive: true });

  document.addEventListener('mouseleave', () => {
    if (!pointerState.canAnimate) {
      return;
    }

    resetPointerEffects();
  });
}

window.addEventListener('resize', () => {
  resolveMotionPreference();
  _applyViewportScale();
}, { passive: true });
