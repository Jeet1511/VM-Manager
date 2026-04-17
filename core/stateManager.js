/**
 * core/stateManager.js — Setup State Persistence & Recovery
 * 
 * Design Decision: After EVERY phase completes, we save state to disk.
 * When the app reopens, we check this state file and resume from
 * wherever we left off — no need to redo completed phases.
 * 
 * Only starts from scratch if:
 * - No state file exists (first run)
 * - State file is corrupted
 * - User explicitly chooses "Start Fresh"
 * - Critical resources are missing (VM deleted, ISO gone, etc.)
 * 
 * State is saved as JSON in the app data directory.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { getAppDataPath } = require('./config');

const STATE_FILE = 'setup-state.json';

/**
 * All possible phase statuses.
 * Phases progress: pending → active → complete | error | skipped
 */
const PHASE_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPLETE: 'complete',
  ERROR: 'error',
  SKIPPED: 'skipped'
};

class StateManager {
  constructor() {
    this.statePath = null;
    this.state = null;
  }

  /**
   * Initialize the state manager — creates app data dir if needed.
   */
  async init() {
    const appDataDir = getAppDataPath();
    await fs.promises.mkdir(appDataDir, { recursive: true });
    this.statePath = path.join(appDataDir, STATE_FILE);
    logger.info('StateManager', `State file: ${this.statePath}`);
  }

  /**
   * Load saved state from disk.
   * Returns null if no state exists or state is corrupted.
   */
  async loadState() {
    try {
      if (!this.statePath) await this.init();

      if (!fs.existsSync(this.statePath)) {
        logger.info('StateManager', 'No previous state found — fresh start');
        return null;
      }

      const raw = await fs.promises.readFile(this.statePath, 'utf8');
      const state = JSON.parse(raw);

      // Validate state structure
      if (!state || !state.config || !state.phases || !state.startedAt) {
        logger.warn('StateManager', 'State file is corrupted — will start fresh');
        return null;
      }

      logger.info('StateManager', `Found previous state from: ${state.lastUpdated}`);
      logger.info('StateManager', `VM: ${state.config.vmName}, Last phase: ${state.lastCompletedPhase}`);

      this.state = state;
      return state;
    } catch (err) {
      logger.warn('StateManager', `Failed to load state: ${err.message}`);
      return null;
    }
  }

  /**
   * Create a new state for a fresh setup.
   * 
   * @param {object} config - User configuration from wizard
   * @returns {object} New state object
   */
  createNewState(config) {
    this.state = {
      version: 1,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      lastCompletedPhase: null,
      config: { ...config },
      phases: {
        system_check: PHASE_STATUS.PENDING,
        download_vbox: PHASE_STATUS.PENDING,
        install_vbox: PHASE_STATUS.PENDING,
        download_iso: PHASE_STATUS.PENDING,
        verify_iso: PHASE_STATUS.PENDING,
        create_vm: PHASE_STATUS.PENDING,
        install_os: PHASE_STATUS.PENDING,
        wait_boot: PHASE_STATUS.PENDING,
        guest_config: PHASE_STATUS.PENDING,
        complete: PHASE_STATUS.PENDING
      },
      // Track important artifacts for recovery validation
      artifacts: {
        vboxInstallerPath: null,
        isoPath: null,
        vmCreated: false,
        vmStarted: false,
        guestConfigured: false
      },
      errors: []
    };

    this._save();
    logger.info('StateManager', 'New state created');
    return this.state;
  }

  /**
   * Mark a phase as complete and save to disk.
   */
  async completePhase(phaseId, artifacts = {}) {
    if (!this.state) return;

    this.state.phases[phaseId] = PHASE_STATUS.COMPLETE;
    this.state.lastCompletedPhase = phaseId;
    this.state.lastUpdated = new Date().toISOString();

    // Merge any artifact data (file paths, flags, etc.)
    Object.assign(this.state.artifacts, artifacts);

    await this._save();
    logger.debug('StateManager', `Phase "${phaseId}" marked complete`);
  }

  /**
   * Mark a phase as skipped.
   */
  async skipPhase(phaseId) {
    if (!this.state) return;
    this.state.phases[phaseId] = PHASE_STATUS.SKIPPED;
    this.state.lastUpdated = new Date().toISOString();
    await this._save();
  }

  /**
   * Mark a phase as failed with an error.
   */
  async failPhase(phaseId, errorMessage) {
    if (!this.state) return;
    this.state.phases[phaseId] = PHASE_STATUS.ERROR;
    this.state.lastUpdated = new Date().toISOString();
    this.state.errors.push({
      phase: phaseId,
      message: errorMessage,
      timestamp: new Date().toISOString()
    });
    await this._save();
  }

  /**
   * Mark setup as fully complete and clean up state file.
   */
  async markComplete() {
    if (!this.state) return;
    this.state.phases.complete = PHASE_STATUS.COMPLETE;
    this.state.lastCompletedPhase = 'complete';
    this.state.completedAt = new Date().toISOString();
    this.state.lastUpdated = new Date().toISOString();
    await this._save();
    logger.success('StateManager', 'Setup marked as complete');
  }

  /**
   * Delete saved state (for "Start Fresh" or after successful completion).
   */
  async clearState() {
    try {
      if (this.statePath && fs.existsSync(this.statePath)) {
        await fs.promises.unlink(this.statePath);
        logger.info('StateManager', 'State file cleared');
      }
      this.state = null;
    } catch (err) {
      logger.warn('StateManager', `Failed to clear state: ${err.message}`);
    }
  }

  /**
   * Check if a phase was already completed successfully or skipped.
   */
  isPhaseComplete(phaseId) {
    if (!this.state) return false;
    const status = this.state.phases[phaseId];
    return status === PHASE_STATUS.COMPLETE || status === PHASE_STATUS.SKIPPED;
  }

  /**
   * Determine which phase to resume from.
   * Validates that artifacts from completed phases still exist.
   * 
   * @returns {object} { resumeFrom: phaseId, validatedState, needsFresh }
   */
  async determineResumePoint() {
    if (!this.state) {
      return { resumeFrom: null, needsFresh: true };
    }

    const phaseOrder = [
      'system_check', 'download_vbox', 'install_vbox',
      'download_iso', 'verify_iso', 'create_vm',
      'install_os', 'wait_boot', 'guest_config', 'complete'
    ];

    // If already fully complete, no need to resume
    if (this.state.phases.complete === PHASE_STATUS.COMPLETE) {
      return { resumeFrom: null, needsFresh: false, alreadyComplete: true };
    }

    // Validate artifacts for completed phases
    const validationIssues = [];

    // Check if VirtualBox is still installed
    if (this.isPhaseComplete('install_vbox') || this.isPhaseComplete('download_vbox')) {
      const platform = require('../adapters/platform');
      const vboxPath = await platform.findVBoxManage();
      if (!vboxPath && !this.isPhaseComplete('install_vbox') === false) {
        // VBox was supposed to be skipped (already installed) but now it's gone
        validationIssues.push('VirtualBox no longer detected');
      }
    }

    // Check if ISO still exists
    if (this.isPhaseComplete('download_iso') && this.state.artifacts.isoPath) {
      if (!fs.existsSync(this.state.artifacts.isoPath)) {
        logger.warn('StateManager', `ISO file missing: ${this.state.artifacts.isoPath}`);
        validationIssues.push('ISO file missing');
        // Reset from download_iso phase
        this.state.phases.download_iso = PHASE_STATUS.PENDING;
        this.state.phases.verify_iso = PHASE_STATUS.PENDING;
      }
    }

    // Check if VM still exists
    if (this.isPhaseComplete('create_vm') && this.state.config.vmName) {
      try {
        const virtualbox = require('../adapters/virtualbox');
        await virtualbox.init();
        const exists = await virtualbox.vmExists(this.state.config.vmName);
        if (!exists) {
          logger.warn('StateManager', `VM "${this.state.config.vmName}" no longer exists`);
          validationIssues.push('VM was deleted');
          // Reset from create_vm phase onward
          this.state.phases.create_vm = PHASE_STATUS.PENDING;
          this.state.phases.install_os = PHASE_STATUS.PENDING;
          this.state.phases.wait_boot = PHASE_STATUS.PENDING;
          this.state.phases.guest_config = PHASE_STATUS.PENDING;
        }
      } catch (err) {
        // VBoxManage not available — may need to reinstall
      }
    }

    // If too many issues, start fresh
    if (validationIssues.length >= 3) {
      logger.warn('StateManager', `Too many validation issues (${validationIssues.length}) — recommending fresh start`);
      return { resumeFrom: null, needsFresh: true, issues: validationIssues };
    }

    // Find the first incomplete phase
    let resumeFrom = null;
    for (const phase of phaseOrder) {
      if (!this.isPhaseComplete(phase)) {
        resumeFrom = phase;
        break;
      }
    }

    if (validationIssues.length > 0) {
      logger.warn('StateManager', `Validation issues found: ${validationIssues.join(', ')}`);
    }

    // Save the validated state
    await this._save();

    const completedCount = phaseOrder.filter(p => this.isPhaseComplete(p)).length;

    logger.info('StateManager', `Resume point: "${resumeFrom}" (${completedCount}/${phaseOrder.length} phases complete)`);

    return {
      resumeFrom,
      needsFresh: false,
      completedCount,
      totalCount: phaseOrder.length,
      issues: validationIssues,
      config: this.state.config
    };
  }

  /**
   * Get a human-readable summary of the current state.
   */
  getSummary() {
    if (!this.state) return null;

    const phaseLabels = {
      system_check: 'System Check',
      download_vbox: 'Download VirtualBox',
      install_vbox: 'Install VirtualBox',
      download_iso: 'Download Ubuntu ISO',
      verify_iso: 'Verify ISO',
      create_vm: 'Create VM',
      install_os: 'Install Ubuntu',
      wait_boot: 'Wait for Boot',
      guest_config: 'Guest Configuration',
      complete: 'Complete'
    };

    const completed = Object.entries(this.state.phases)
      .filter(([, status]) => status === PHASE_STATUS.COMPLETE || status === PHASE_STATUS.SKIPPED)
      .map(([id]) => phaseLabels[id] || id);

    return {
      vmName: this.state.config?.vmName,
      startedAt: this.state.startedAt,
      lastUpdated: this.state.lastUpdated,
      completedPhases: completed,
      completedCount: completed.length,
      totalPhases: Object.keys(this.state.phases).length,
      lastError: this.state.errors?.length > 0 
        ? this.state.errors[this.state.errors.length - 1] 
        : null
    };
  }

  /**
   * Save current state to disk.
   */
  async _save() {
    if (!this.state || !this.statePath) return;

    try {
      const json = JSON.stringify(this.state, null, 2);
      await fs.promises.writeFile(this.statePath, json, 'utf8');
    } catch (err) {
      logger.error('StateManager', `Failed to save state: ${err.message}`);
    }
  }
}

// Singleton
const stateManager = new StateManager();
module.exports = stateManager;
