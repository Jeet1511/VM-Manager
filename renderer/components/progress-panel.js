/**
 * renderer/components/progress-panel.js — Progress Dashboard
 * 
 * Shows setup progress with real-time phase updates,
 * progress bars, and a live log viewer.
 * 
 * Uses SVG icons — no emojis.
 */

const ProgressPanel = {

  /**
   * Render the progress dashboard.
   */
  render(config = {}) {
    return `
      <div class="progress-dashboard">
        <div class="installing-panel glass-card">
          <div class="installing-header">
            <h3 class="installing-title">Installing Virtual Machine</h3>
            <span class="installing-percent" id="installPercent">0%</span>
          </div>
          <div class="installing-meta">
            <div><span>VM</span><strong id="installVmName">${config.vmName || 'My VM'}</strong></div>
            <div><span>OS</span><strong id="installOs">${config.osName || config.ubuntuVersion || 'Selected OS'}</strong></div>
            <div><span>State</span><strong id="installState">Initializing</strong></div>
          </div>
          <div class="installing-progress-track">
            <div class="installing-progress-fill" id="installProgressFill" style="width: 0%"></div>
          </div>
          <div class="installing-phase" id="installPhaseLabel">Preparing setup workflow...</div>
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
    return `
      <div class="glass-card completion-card">
        <div class="completion-icon completion-icon-ok">${Icons.sized(Icons.checkCircle, 40)}</div>
        <h2 class="completion-title">Setup Complete!</h2>
        <p class="completion-message">
          Your virtual machine is fully set up and configured.<br>
          Everything works out of the box — no manual steps needed.
        </p>

        <div class="credentials-box">
          <div class="credential-row">
            <span class="credential-label">VM Name</span>
            <span class="credential-value">${result.vmName || 'My VM'}</span>
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
            <div class="check-icon pass">${Icons.sized(Icons.check, 16)}</div>
            <div class="check-details">
              <div class="check-name">Guest Additions Installed</div>
              <div class="check-value">Packages installed and guest integration enabled</div>
            </div>
          </div>
          <div class="check-item">
            <div class="check-icon pass">${Icons.sized(Icons.check, 16)}</div>
            <div class="check-details">
              <div class="check-name">Clipboard Sharing</div>
              <div class="check-value">Bidirectional — copy/paste between host and VM</div>
            </div>
          </div>
          <div class="check-item">
            <div class="check-icon pass">${Icons.sized(Icons.check, 16)}</div>
            <div class="check-details">
              <div class="check-name">Drag & Drop</div>
              <div class="check-value">Bidirectional — drag files between host and VM</div>
            </div>
          </div>
          <div class="check-item">
            <div class="check-icon pass">${Icons.sized(Icons.check, 16)}</div>
            <div class="check-details">
              <div class="check-name">Fullscreen & Dynamic Resolution</div>
              <div class="check-value">VMSVGA + auto-resize enabled</div>
            </div>
          </div>
          <div class="check-item">
            <div class="check-icon pass">${Icons.sized(Icons.check, 16)}</div>
            <div class="check-details">
              <div class="check-name">Shared Folder</div>
              <div class="check-value">Auto-mounted at /media/sf_shared — persists across reboots</div>
            </div>
          </div>
          <div class="check-item">
            <div class="check-icon pass">${Icons.sized(Icons.check, 16)}</div>
            <div class="check-details">
              <div class="check-name">Persistence</div>
              <div class="check-value">All services auto-start on every boot — no manual setup ever</div>
            </div>
          </div>
        </div>

        <div class="btn-row" style="justify-content: center; border-top: none">
          <button class="btn btn-primary btn-icon-text" id="btnBackToDash">
            ${Icons.arrowLeft} Back to Dashboard
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
            &bull; Enable virtualization (VT-x/AMD-V) in your BIOS<br>
            &bull; Free up disk space<br>
            &bull; Run the app as administrator<br>
            &bull; Check your internet connection
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
    return `
      <div class="glass-card completion-card">
        <div class="completion-icon" style="background: rgba(210,153,34,0.12); border-color: rgba(210,153,34,0.35); color: var(--warn)">
          ${Icons.sized(Icons.warning, 40)}
        </div>
        <h2 class="completion-title" style="color: var(--warn)">Setup Cancelled</h2>
        <p class="completion-message">${message}</p>

        <div class="info-box" style="border-color: rgba(210,153,34,0.25); background: rgba(210,153,34,0.07)">
          <span class="info-box-icon">${Icons.info}</span>
          <span>
            Your current state is preserved. You can return to Create VM and resume from the previous progress point.
          </span>
        </div>

        <div class="btn-row" style="justify-content: center; border-top: none; gap: var(--space-md)">
          <button class="btn btn-primary btn-icon-text" id="btnRetry">
            ${Icons.refresh} Resume / Retry
          </button>
          <button class="btn btn-ghost btn-icon-text" id="btnBackToDash">
            ${Icons.arrowLeft} Dashboard
          </button>
        </div>
      </div>
    `;
  },

  // ─── Phase Update Methods ───────────────────────────────────────

  /**
   * Update a phase from an event data object.
   * data = { id, label, status, icon?, message? }
   */
  updatePhase(data) {
    if (!data || !data.id) return;
    const phaseId = data.id;

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

    const status = data.status || 'active';
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
  },

  /**
   * Update progress for a phase.
   * data = { id, message, percent, downloadProgress? }
   */
  updateProgress(data) {
    if (!data || !data.id) return;
    const phaseId = data.id;

    const msgEl = document.getElementById(`phase-msg-${phaseId}`);
    const barEl = document.getElementById(`phase-bar-${phaseId}`);
    const fillEl = document.getElementById(`phase-fill-${phaseId}`);
    const statsEl = document.getElementById(`phase-stats-${phaseId}`);

    if (data.message && msgEl) msgEl.textContent = data.message;

    if (data.percent !== null && data.percent !== undefined && barEl && fillEl) {
      barEl.style.display = 'block';
      fillEl.style.width = `${data.percent}%`;
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
    const phaseLabel = document.getElementById('installPhaseLabel');
    const state = document.getElementById('installState');
    if (!phaseLabel || !state) return;

    const status = data?.status || 'active';
    const label = data?.label || data?.id || 'Working';
    phaseLabel.textContent = `${label}${data?.message ? ` · ${data.message}` : ''}`;

    if (status === 'complete') state.textContent = 'Completing';
    else if (status === 'error') state.textContent = 'Error';
    else if (status === 'skipped') state.textContent = 'Skipped';
    else state.textContent = 'Installing';
  },

  updateInstallProgress(data) {
    if (!data) return;
    const percent = Math.max(0, Math.min(100, Number(data.percent || 0)));
    const percentEl = document.getElementById('installPercent');
    const fillEl = document.getElementById('installProgressFill');
    const phaseLabel = document.getElementById('installPhaseLabel');

    if (percentEl) percentEl.textContent = `${percent}%`;
    if (fillEl) fillEl.style.width = `${percent}%`;
    if (phaseLabel && data.message) phaseLabel.textContent = data.message;

    const state = document.getElementById('installState');
    if (state) {
      state.textContent = percent >= 100 ? 'Finalizing' : 'Installing';
    }
  }
};
