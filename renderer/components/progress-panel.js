/**
 * renderer/components/progress-panel.js — Progress Dashboard
 * 
 * Shows setup progress with real-time phase updates,
 * progress bars, and a live log viewer.
 * 
 * Uses SVG icons — no emojis.
 */

const ProgressPanel = {
  _defaultPhaseCatalog: {
    system_check: 'System Requirements Check',
    download_vbox: 'Download VirtualBox',
    install_vbox: 'Install VirtualBox',
    download_iso: 'Download OS ISO',
    verify_iso: 'Verify ISO Integrity',
    create_vm: 'Create & Configure V Os',
    install_os: 'Install Operating System',
    wait_boot: 'Waiting for OS Boot',
    guest_config: 'Configuring Guest Integration',
    complete: 'Setup Complete'
  },
  _excludedOverallPhases: new Set(['pause', 'cancel', 'error']),

  /**
   * Render the progress dashboard.
   */
  render(config = {}) {
    if (this._installPercentRaf) {
      cancelAnimationFrame(this._installPercentRaf);
      this._installPercentRaf = null;
    }
    this._installPercentValue = 0;
    this._resetInstallTracking();
    return `
      <div class="progress-dashboard">
        <div class="installing-panel glass-card">
          <div class="installing-header">
            <h3 class="installing-title">Installing V Os</h3>
            <span class="installing-percent" id="installPercent">0%</span>
          </div>
          <div class="installing-meta">
            <div><span>V Os</span><strong id="installVmName">${config.vmName || 'My V Os'}</strong></div>
            <div><span>OS</span><strong id="installOs">${config.osName || config.ubuntuVersion || 'Selected OS'}</strong></div>
            <div><span>State</span><strong id="installState">Initializing</strong></div>
          </div>
          <div class="installing-progress-track">
            <div class="installing-progress-fill" id="installProgressFill" style="width: 0%"></div>
          </div>
          <div class="installing-phase" id="installPhaseLabel">Preparing setup workflow...</div>
          <div class="installing-subprogress" id="installSubProgress"></div>
        </div>

        <div class="glass-card" style="padding: var(--space-xl)">
          <h2 class="step-title">Setup in Progress</h2>
          <p class="step-description">
            Sit back and relax — everything is automated. You can see every step below.
          </p>

          <div class="phase-list" id="phaseList"></div>

          <div id="cancelRow" class="btn-row" style="justify-content:center; border-top:none; padding-top:0">
            <button class="btn btn-ghost btn-icon-text" id="btnBackToDash" style="margin-right: var(--space-md)">
              ${Icons.arrowLeft} Dashboard
            </button>
            <button class="btn btn-warn btn-icon-text" id="btnPauseSetup">
              ${Icons.pause} Pause Download
            </button>
            <button class="btn btn-danger btn-icon-text" id="btnCancelSetup">
              ${Icons.xCircle} Cancel Setup
            </button>
          </div>
        </div>

        <!-- Live Log Viewer -->
        <div class="log-viewer" style="margin-top: var(--space-lg)">
          <div class="log-header">
            <div class="log-title">
              <span class="log-dot" id="logDot"></span>
              Live Log
            </div>
            <span style="font-size: 11px; color: var(--text-muted)">All operations are visible</span>
          </div>
          <div class="log-content" id="logContent"></div>
        </div>
      </div>
    `;
  },

  /**
   * Render the completion screen.
   */
  renderComplete(result) {
    const autoStarted = result?.autoStartVm === true;
    const integrationReady = result?.guestConfigured === true;
    const title = autoStarted ? 'V Os Setup Completed' : 'V Os Prepared Successfully';
    const message = result?.message
      || (autoStarted
        ? 'Your V Os has been created and configured.'
        : 'Auto-start is disabled to keep your PC responsive. Start the V Os manually when ready.');
    const launchLabel = autoStarted ? 'Open V Os' : 'Start V Os';
    const passIcon = `<div class="check-icon pass">${Icons.sized(Icons.check, 16)}</div>`;
    const pendingIcon = `<div class="check-icon" style="color: var(--warn)">${Icons.sized(Icons.warning, 16)}</div>`;

    return `
      <div class="glass-card completion-card">
        <div class="completion-icon completion-icon-ok">
          <svg class="onboard-success-check" viewBox="0 0 56 56" fill="none" aria-hidden="true">
            <circle cx="28" cy="28" r="23"></circle>
            <path class="onboard-success-check-path" d="M17 29.5L24.5 37L40 21"></path>
          </svg>
        </div>
        <h2 class="completion-title">${title}</h2>
        <p class="completion-message">${message}</p>

        <div class="credentials-box">
          <div class="credential-row">
            <span class="credential-label">V Os Name</span>
            <span class="credential-value">${result.vmName || 'My V Os'}</span>
          </div>
          <div class="credential-row">
            <span class="credential-label">Username</span>
            <span class="credential-value">${result.credentials?.username || 'user'}</span>
          </div>
          <div class="credential-row">
            <span class="credential-label">Password</span>
            <span class="credential-value">${result.credentials?.password || 'password'}</span>
          </div>
          ${result.sharedFolder ? `
          <div class="credential-row">
            <span class="credential-label">Shared Folder</span>
            <span class="credential-value">${result.sharedFolder.guestMountPoint || '/media/sf_shared'}</span>
          </div>
          ` : ''}
        </div>

        <div class="check-list" style="margin-top: var(--space-xl); text-align:left">
          <div class="check-item">
            ${passIcon}
            <div class="check-details">
              <div class="check-name">V Os Configuration</div>
              <div class="check-value">Core hardware, storage, network, and integration preferences applied</div>
            </div>
          </div>
          <div class="check-item">
            ${autoStarted ? passIcon : pendingIcon}
            <div class="check-details">
              <div class="check-name">OS Installation</div>
              <div class="check-value">${autoStarted ? 'Installation was started automatically.' : 'Pending manual start to begin installation.'}</div>
            </div>
          </div>
          <div class="check-item">
            ${integrationReady ? passIcon : pendingIcon}
            <div class="check-details">
              <div class="check-name">Guest Integration</div>
              <div class="check-value">${integrationReady ? 'Clipboard, drag & drop, display, and services are active.' : 'Can be finished from Guest Setup after first boot/login.'}</div>
            </div>
          </div>
        </div>

        <div class="btn-row" style="justify-content: center; border-top: none; gap: 12px;">
          <button class="btn btn-primary btn-icon-text launch-vm-btn" id="btnLaunchVm">
            ${Icons.play} ${launchLabel}
          </button>
          <button class="btn btn-secondary btn-icon-text" id="btnBackToDash">
            ${Icons.arrowLeft} Dashboard
          </button>
        </div>
      </div>
    `;
  },

  /**
   * Render error state.
   */
  renderError(error) {
    const message = typeof error === 'string' ? error : (error.message || 'An unexpected error occurred.');
    const normalized = String(message || '').toLowerCase();
    const suggestions = [];

    if (/constructmedia|0x80004005|vboxmanagemisc\.cpp/i.test(normalized)) {
      suggestions.push('Use a different VM install folder (e.g., D:\\VM Xposed\\V Os) and avoid protected/system folders');
      suggestions.push('Delete any partial VM with the same name from VirtualBox, then retry setup');
      suggestions.push('Use a simple VM name without special characters');
    }

    if (/vboxdrvstub|supr3hardenedwinrespawn|status_object_name_not_found|verr_open_failed/i.test(normalized)) {
      suggestions.push('Reboot Windows, then run VM Xposed as administrator and try again');
      suggestions.push('Repair/reinstall VirtualBox (run installer as administrator), then reboot');
      suggestions.push('From Dashboard warning banner, run Prepare Host to auto-check host blockers before retrying setup');
      suggestions.push('If Windows Memory Integrity/Core Isolation is ON, temporarily disable it and reinstall VirtualBox');
    }

    if (suggestions.length === 0) {
      suggestions.push('Enable virtualization (VT-x/AMD-V) in your BIOS');
      suggestions.push('Free up disk space');
      suggestions.push('Run the app as administrator');
      suggestions.push('Check your internet connection');
    }

    return `
      <div class="glass-card completion-card">
        <div class="completion-icon" style="background: rgba(255,107,107,0.1); border-color: rgba(255,107,107,0.3); color: var(--error)">
          ${Icons.sized(Icons.xCircle, 40)}
        </div>
        <h2 class="completion-title" style="color: var(--error)">Setup Failed</h2>
        <p class="completion-message">${message}</p>

        <div class="info-box" style="border-color: rgba(255,107,107,0.2); background: rgba(255,107,107,0.06)">
          <span class="info-box-icon">${Icons.settings}</span>
          <span>
            <strong>What to do:</strong> Check the error message above. Common fixes:<br>
            ${suggestions.map((item) => `&bull; ${item}`).join('<br>')}
          </span>
        </div>

        <div class="btn-row" style="justify-content: center; border-top: none; gap: var(--space-md)">
          <button class="btn btn-primary btn-icon-text" id="btnRetry">
            ${Icons.refresh} Try Again
          </button>
          <button class="btn btn-ghost btn-icon-text" id="btnBackToDash">
            ${Icons.arrowLeft} Dashboard
          </button>
        </div>
      </div>
    `;
  },

  renderCancelled(message = 'Setup cancelled by user. Progress is saved and you can resume later.') {
    const isPaused = /pause/i.test(String(message || ''));
    const title = isPaused ? 'Setup Paused' : 'Setup Cancelled';
    const actionLabel = isPaused ? 'Resume Setup' : 'Resume / Retry';
    const guidance = isPaused
      ? 'Your current state is preserved. Press resume to continue from the same setup phase.'
      : 'Your current state is preserved. You can return to Create V Os and resume from the previous progress point.';
    return `
      <div class="glass-card completion-card">
        <div class="completion-icon" style="background: rgba(210,153,34,0.12); border-color: rgba(210,153,34,0.35); color: var(--warn)">
          ${Icons.sized(Icons.warning, 40)}
        </div>
        <h2 class="completion-title" style="color: var(--warn)">${title}</h2>
        <p class="completion-message">${message}</p>

        <div class="info-box" style="border-color: rgba(210,153,34,0.25); background: rgba(210,153,34,0.07)">
          <span class="info-box-icon">${Icons.info}</span>
          <span>
            ${guidance}
          </span>
        </div>

        <div class="btn-row" style="justify-content: center; border-top: none; gap: var(--space-md)">
          <button class="btn btn-primary btn-icon-text" id="btnRetry">
            ${Icons.refresh} ${actionLabel}
          </button>
          <button class="btn btn-ghost btn-icon-text" id="btnBackToDash">
            ${Icons.arrowLeft} Dashboard
          </button>
        </div>
      </div>
    `;
  },

  initializePhases(phases = []) {
    const phaseList = Array.isArray(phases) ? phases : [];
    const phaseCatalog = { ...this._defaultPhaseCatalog };
    const phaseOrder = [];

    phaseList.forEach((phase) => {
      const id = String(phase?.id || '').trim();
      if (!id) return;
      if (!phaseOrder.includes(id)) phaseOrder.push(id);
      phaseCatalog[id] = phase?.label || phaseCatalog[id] || id;
    });

    if (!phaseOrder.includes('complete')) phaseOrder.push('complete');

    this._phaseCatalog = phaseCatalog;
    this._phaseOrder = phaseOrder.length > 0 ? phaseOrder : Object.keys(this._defaultPhaseCatalog);
    this._phaseProgress = {};
    this._phaseOrder.forEach((id) => {
      this._phaseProgress[id] = {
        label: this._phaseCatalog[id] || id,
        status: 'pending',
        percent: 0,
        message: ''
      };
    });
    this._renderInstallSubProgress();
    this._refreshInstallHeader({ message: this._currentInstallMessage || 'Preparing setup workflow...' });
  },

  _resetInstallTracking() {
    this._phaseCatalog = { ...this._defaultPhaseCatalog };
    this._phaseOrder = Object.keys(this._defaultPhaseCatalog);
    this._phaseProgress = {};
    this._phaseOrder.forEach((id) => {
      this._phaseProgress[id] = {
        label: this._phaseCatalog[id] || id,
        status: 'pending',
        percent: 0,
        message: ''
      };
    });
    this._currentInstallMessage = 'Preparing setup workflow...';
    this._manualOverallPercent = 0;
  },

  _normalizePercent(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(100, Math.round(parsed)));
  },

  _ensurePhaseRecord(phaseId, label = '') {
    const id = String(phaseId || '').trim();
    if (!id) return null;

    if (!this._phaseCatalog[id]) {
      this._phaseCatalog[id] = label || id;
    } else if (label) {
      this._phaseCatalog[id] = label;
    }

    if (!Array.isArray(this._phaseOrder)) {
      this._phaseOrder = [];
    }
    if (!this._phaseOrder.includes(id)) {
      this._phaseOrder.push(id);
    }

    if (!this._phaseProgress) {
      this._phaseProgress = {};
    }
    if (!this._phaseProgress[id]) {
      this._phaseProgress[id] = {
        label: this._phaseCatalog[id] || id,
        status: 'pending',
        percent: 0,
        message: ''
      };
    }

    const record = this._phaseProgress[id];
    record.label = label || this._phaseCatalog[id] || id;
    return record;
  },

  _resolvePhasePercent(record) {
    if (!record) return 0;
    if (record.status === 'complete' || record.status === 'skipped') return 100;
    return this._normalizePercent(record.percent);
  },

  _renderInstallSubProgress() {
    const container = document.getElementById('installSubProgress');
    if (!container) return;

    const phaseOrder = Array.isArray(this._phaseOrder) ? this._phaseOrder : [];
    const rows = phaseOrder
      .filter((id) => !this._excludedOverallPhases.has(id))
      .map((id) => {
        const record = this._phaseProgress?.[id] || this._ensurePhaseRecord(id, this._phaseCatalog?.[id] || id);
        const status = String(record?.status || 'pending').toLowerCase();
        const percent = this._resolvePhasePercent(record);
        const statusLabel = status === 'complete'
          ? 'Complete'
          : status === 'skipped'
            ? 'Skipped'
            : status === 'error'
              ? 'Error'
              : status === 'active'
                ? 'Active'
                : 'Pending';

        return `
          <div class="install-sub-row is-${status}">
            <span class="install-sub-name">${record?.label || id}</span>
            <span class="install-sub-percent">${percent}%</span>
            <span class="install-sub-status">${statusLabel}</span>
          </div>
        `;
      });

    container.innerHTML = rows.join('');
  },

  _refreshInstallHeader(options = {}) {
    const phaseOrder = Array.isArray(this._phaseOrder) ? this._phaseOrder : [];
    let total = 0;
    let count = 0;
    let hasActive = false;
    let hasError = false;

    phaseOrder.forEach((id) => {
      if (this._excludedOverallPhases.has(id)) return;
      const record = this._phaseProgress?.[id];
      if (!record) return;
      total += this._resolvePhasePercent(record);
      count += 1;
      if (record.status === 'active') hasActive = true;
      if (record.status === 'error') hasError = true;
    });

    const computedPercent = count > 0 ? Math.round(total / count) : this._normalizePercent(options.fallbackPercent);
    const fallbackPercent = this._normalizePercent(options.fallbackPercent);
    const manualOverall = this._normalizePercent(this._manualOverallPercent);
    const overallPercent = Math.max(computedPercent, fallbackPercent, manualOverall);

    const percentEl = document.getElementById('installPercent');
    const fillEl = document.getElementById('installProgressFill');
    const phaseLabel = document.getElementById('installPhaseLabel');
    const state = document.getElementById('installState');

    if (percentEl) {
      percentEl.textContent = `${overallPercent}%`;
      percentEl.dataset.value = String(overallPercent);
      this._installPercentValue = overallPercent;
    }
    if (fillEl) fillEl.style.width = `${overallPercent}%`;

    if (options.message) {
      this._currentInstallMessage = options.message;
    }
    if (phaseLabel) {
      phaseLabel.textContent = this._currentInstallMessage || 'Preparing setup workflow...';
    }

    if (state) {
      if (hasError) state.textContent = 'Error';
      else if (overallPercent >= 100) state.textContent = 'Finalizing';
      else if (hasActive) state.textContent = 'Installing';
      else state.textContent = 'Preparing';
    }

    this._renderInstallSubProgress();
  },

  // ─── Phase Update Methods ───────────────────────────────────────

  /**
   * Update a phase from an event data object.
   * data = { id, label, status, icon?, message? }
   */
  updatePhase(data) {
    if (!data || !data.id) return;
    const phaseId = data.id;
    const status = data.status || 'active';
    const phaseRecord = this._ensurePhaseRecord(phaseId, data.label || phaseId);
    if (!phaseRecord) return;
    phaseRecord.status = status;
    if (status === 'complete' || status === 'skipped') {
      phaseRecord.percent = 100;
    }
    if (data.message) {
      phaseRecord.message = data.message;
    }

    // Create phase element if it doesn't exist
    let phaseEl = document.getElementById(`phase-${phaseId}`);
    if (!phaseEl) {
      const list = document.getElementById('phaseList');
      if (!list) return;
      phaseEl = document.createElement('div');
      phaseEl.className = 'phase-item';
      phaseEl.id = `phase-${phaseId}`;
      phaseEl.innerHTML = `
        <div class="phase-icon" id="phase-icon-${phaseId}">${Icons.sized(Icons.spinner, 18)}</div>
        <div class="phase-content">
          <div class="phase-label">${data.label || phaseId}</div>
          <div class="phase-message" id="phase-msg-${phaseId}">Starting...</div>
          <div class="phase-progress-bar" id="phase-bar-${phaseId}" style="display:none">
            <div class="phase-progress-fill" id="phase-fill-${phaseId}" style="width:0%"></div>
          </div>
          <div class="download-stats" id="phase-stats-${phaseId}" style="display:none"></div>
        </div>
        <div class="phase-status-icon" id="phase-status-${phaseId}"></div>
      `;
      list.appendChild(phaseEl);
    }

    const iconEl = document.getElementById(`phase-icon-${phaseId}`);
    const statusEl = document.getElementById(`phase-status-${phaseId}`);
    const msgEl = document.getElementById(`phase-msg-${phaseId}`);

    // Remove old status
    phaseEl.classList.remove('active', 'complete', 'error', 'skipped');

    phaseEl.classList.add(status);

    if (data.message && msgEl) {
      msgEl.textContent = data.message;
    }

    switch (status) {
      case 'active':
        if (iconEl) { iconEl.classList.add('spinning'); iconEl.innerHTML = Icons.sized(Icons.spinner, 18); }
        if (msgEl && !data.message) msgEl.textContent = 'In progress...';
        break;
      case 'complete':
        if (iconEl) { iconEl.classList.remove('spinning'); iconEl.innerHTML = Icons.sized(Icons.checkCircle, 18); }
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--success)">${Icons.sized(Icons.check, 14)}</span>`;
        break;
      case 'error':
        if (iconEl) { iconEl.classList.remove('spinning'); iconEl.innerHTML = Icons.sized(Icons.xCircle, 18); }
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--error)">${Icons.sized(Icons.xCircle, 14)}</span>`;
        break;
      case 'skipped':
        if (iconEl) { iconEl.classList.remove('spinning'); iconEl.innerHTML = Icons.sized(Icons.arrowRight, 18); }
        if (msgEl && !data.message) msgEl.textContent = 'Skipped (not needed)';
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--skip)">${Icons.sized(Icons.arrowRight, 14)}</span>`;
        break;
    }

    const composedMessage = data.message
      ? `${phaseRecord.label} · ${data.message}`
      : `${phaseRecord.label}`;
    this._refreshInstallHeader({ message: composedMessage });
  },

  /**
   * Update progress for a phase.
   * data = { id, message, percent, downloadProgress? }
   */
  updateProgress(data) {
    if (!data || !data.id) return;
    const phaseId = data.id;
    const record = this._ensurePhaseRecord(phaseId, data.label || phaseId);
    if (!record) return;

    const msgEl = document.getElementById(`phase-msg-${phaseId}`);
    const barEl = document.getElementById(`phase-bar-${phaseId}`);
    const fillEl = document.getElementById(`phase-fill-${phaseId}`);
    const statsEl = document.getElementById(`phase-stats-${phaseId}`);

    if (data.message) {
      record.message = data.message;
      this._currentInstallMessage = data.message;
      if (msgEl) msgEl.textContent = data.message;
    }

    if (data.percent !== null && data.percent !== undefined && barEl && fillEl) {
      const percent = this._normalizePercent(data.percent);
      record.percent = percent;
      if (!['complete', 'error', 'skipped'].includes(String(record.status || '').toLowerCase())) {
        record.status = 'active';
      }
      barEl.style.display = 'block';
      fillEl.style.width = `${percent}%`;
    }

    if (data.downloadProgress && statsEl) {
      statsEl.style.display = 'flex';
      const dp = data.downloadProgress;
      statsEl.innerHTML = `
        <span>${dp.downloadedFormatted || ''} / ${dp.totalFormatted || ''}</span>
        <span>${dp.speedFormatted || ''}</span>
        <span>ETA: ${dp.etaFormatted || ''}</span>
      `;
    }

    this._refreshInstallHeader({
      message: this._currentInstallMessage,
      fallbackPercent: data.percent
    });
  },

  /**
   * Add a log entry to the live log viewer.
   */
  addLog(entry) {
    const logContent = document.getElementById('logContent');
    if (!logContent) return;

    const time = new Date(entry.timestamp || Date.now()).toLocaleTimeString();
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-level ${entry.level}">${entry.level}</span>
      <span class="log-module">[${entry.module}]</span>
      <span class="log-msg">${entry.message}</span>
    `;

    logContent.appendChild(div);
    logContent.scrollTop = logContent.scrollHeight;

    while (logContent.children.length > 500) {
      logContent.removeChild(logContent.firstChild);
    }
  }
  ,

  updateInstallPhase(data) {
    const status = data?.status || 'active';
    const label = data?.label || data?.id || 'Working';
    const phaseId = data?.id || '';
    if (phaseId) {
      const record = this._ensurePhaseRecord(phaseId, label);
      if (record) {
        record.status = status;
        if (status === 'complete' || status === 'skipped') {
          record.percent = 100;
        }
        if (data?.message) {
          record.message = data.message;
        }
      }
    }

    const composedMessage = `${label}${data?.message ? ` · ${data.message}` : ''}`;
    this._refreshInstallHeader({ message: composedMessage });
  },

  updateInstallProgress(data) {
    if (!data) return;
    const phaseId = String(data.id || data.phase || '').trim();
    if (phaseId) {
      const phaseLabel = data.label || data.phaseLabel || phaseId;
      const record = this._ensurePhaseRecord(phaseId, phaseLabel);
      if (record) {
        if (data.percent !== null && data.percent !== undefined) {
          record.percent = this._normalizePercent(data.percent);
        }
        if (!['complete', 'error', 'skipped'].includes(String(record.status || '').toLowerCase())) {
          record.status = 'active';
        }
        if (data.message) {
          record.message = data.message;
        }
      }
      this._manualOverallPercent = 0;
    } else if (data.percent !== null && data.percent !== undefined) {
      this._manualOverallPercent = this._normalizePercent(data.percent);
    }

    this._refreshInstallHeader({
      message: data.message || this._currentInstallMessage || 'Preparing setup workflow...',
      fallbackPercent: data.percent
    });
  }
};
