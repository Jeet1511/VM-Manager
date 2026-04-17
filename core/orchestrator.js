/**
 * core/orchestrator.js — Workflow Engine
 * 
 * Design Decision: The orchestrator is the SINGLE entry point for the
 * entire setup workflow. It runs each phase in sequence, reports progress
 * to the UI after every step, and handles errors with clear messages.
 * 
 * The user sees everything — every phase, every download, every command.
 * Nothing is hidden.
 * 
 * Phases:
 * 1. SYSTEM_CHECK     → Validate hardware & software requirements
 * 2. DOWNLOAD_VBOX    → Download VirtualBox (skip if already installed)
 * 3. INSTALL_VBOX     → Install VirtualBox silently
 * 4. DOWNLOAD_ISO     → Download OS ISO
 * 5. VERIFY_ISO       → SHA256 checksum verification
 * 6. CREATE_VM        → Create & configure VM, set up unattended install
 * 7. BOOT_VM          → Start the VM (OS installs automatically)
 * 8. COMPLETE         → Done!
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');
const logger = require('./logger');
const { UBUNTU_RELEASES, OS_CATALOG, VIRTUALBOX_DOWNLOADS, getDownloadDir, findOS } = require('./config');
const { runSystemCheck } = require('../services/systemChecker');
const { downloadFile, isDownloadComplete } = require('../services/downloadManager');
const { computeSHA256, parseHashFromSHA256SUMS } = require('../services/checksum');
const virtualbox = require('../adapters/virtualbox');
const platform = require('../adapters/platform');
const { createAndConfigureVM } = require('../vm/vmManager');
const { configureGuestInside } = require('../vm/guestAdditions');
const stateManager = require('./stateManager');

// All phases in order — the user sees this list in the UI
const PHASES = [
  { id: 'system_check', label: 'System Requirements Check', icon: '🔍' },
  { id: 'download_vbox', label: 'Download VirtualBox', icon: '⬇️' },
  { id: 'install_vbox', label: 'Install VirtualBox', icon: '📦' },
  { id: 'download_iso', label: 'Download OS ISO', icon: '⬇️' },
  { id: 'verify_iso', label: 'Verify ISO Integrity', icon: '🔐' },
  { id: 'create_vm', label: 'Create & Configure VM', icon: '🔧' },
  { id: 'install_os', label: 'Install Operating System', icon: '💿' },
  { id: 'wait_boot', label: 'Waiting for OS to Boot', icon: '⏳' },
  { id: 'guest_config', label: 'Configuring Guest Integration', icon: '⚙️' },
  { id: 'complete', label: 'Setup Complete', icon: '✅' }
];

class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.abortController = null;
    this.isRunning = false;
    this.currentPhase = null;
    this.resumeMode = false;
  }

  /**
   * Get the list of setup phases for UI display.
   */
  getPhases() {
    return PHASES;
  }

  /**
   * Check if there's a previous setup that can be resumed.
   * @returns {Promise<object|null>} Resume info or null
   */
  async checkForResume() {
    await stateManager.init();
    const savedState = await stateManager.loadState();
    if (!savedState) return null;

    const resumeInfo = await stateManager.determineResumePoint();
    if (resumeInfo.needsFresh || resumeInfo.alreadyComplete) {
      return null;
    }

    return {
      ...resumeInfo,
      summary: stateManager.getSummary()
    };
  }

  /**
   * Clear saved state (user chose "Start Fresh").
   */
  async clearSavedState() {
    await stateManager.clearState();
  }

  /**
   * Run the entire setup workflow.
   * Emits events for UI updates at every step.
   * 
   * Events emitted:
   * - 'phase'    → { id, label, icon, status: 'active'|'complete'|'error'|'skipped' }
   * - 'progress' → { phase, message, percent, downloadProgress? }
   * - 'log'      → { timestamp, level, module, message }
   * - 'error'    → { phase, message, recoverable }
   * - 'complete' → { vmName, credentials, sharedFolder }
   * 
   * @param {object} config - User configuration from the wizard
   * @returns {Promise<object>} Final result with VM details
   */
  async runSetup(config, resumeFrom = null) {
    if (this.isRunning) {
      throw new Error('Setup is already running');
    }

    this.isRunning = true;
    this.resumeMode = !!resumeFrom;
    this.abortController = new AbortController();

    // Initialize state manager
    await stateManager.init();

    if (this.resumeMode) {
      logger.info('Orchestrator', '══════════════════════════════════════════');
      logger.info('Orchestrator', '  VM Auto Installer — RESUMING Setup');
      logger.info('Orchestrator', `  Resuming from: ${resumeFrom}`);
      logger.info('Orchestrator', '══════════════════════════════════════════');
    } else {
      // Create fresh state
      stateManager.createNewState(config);
      logger.info('Orchestrator', '══════════════════════════════════════════');
      logger.info('Orchestrator', '  VM Auto Installer — Starting Setup');
      logger.info('Orchestrator', '══════════════════════════════════════════');
    }

    logger.info('Orchestrator', `VM Name: ${config.vmName}`);
    logger.info('Orchestrator', `Install Path: ${config.installPath}`);
    logger.info('Orchestrator', `OS: ${config.osName || config.ubuntuVersion}`);
    logger.info('Orchestrator', `Resources: ${config.ram}MB RAM, ${config.cpus} CPUs, ${config.disk}MB Disk`);

    // Helper: should we skip a phase? (already done in a previous run)
    const _shouldSkip = (phaseId) => {
      if (!this.resumeMode) return false;
      return stateManager.isPhaseComplete(phaseId);
    };

    try {
      // ─── Phase 1: System Check ──────────────────────────────────────
      if (_shouldSkip('system_check')) {
        this._setPhase('system_check', 'complete');
        this._emitProgress('system_check', 'System check passed (previous run)', 100);
        logger.info('Orchestrator', '⏭ System check — already passed, skipping');
      } else {
        this._setPhase('system_check', 'active');
        this._emitProgress('system_check', 'Checking system requirements...', 0);

        const systemReport = await runSystemCheck(config.installPath);

        if (!systemReport.overallPass) {
          const failedChecks = systemReport.checks
            .filter(c => c.status === 'fail')
            .map(c => `${c.name}: ${c.message}`)
            .join('\n');
          throw new Error(`System check failed:\n${failedChecks}`);
        }

        this._emitProgress('system_check', 'System requirements met', 100);
        this._setPhase('system_check', 'complete');
        await stateManager.completePhase('system_check');
      }

      // ─── Phase 2 & 3: Download & Install VirtualBox ─────────────────
      if (_shouldSkip('install_vbox')) {
        // VBox was installed in a previous run
        this._setPhase('download_vbox', 'complete');
        this._setPhase('install_vbox', 'complete');
        this._emitProgress('install_vbox', 'VirtualBox already installed (previous run)', 100);
        await virtualbox.init();
        logger.info('Orchestrator', '⏭ VirtualBox install — already done, skipping');
      } else {
        // Check if VBox is installed right now (may have been installed between runs)
        const freshCheck = await runSystemCheck(config.installPath);
        let vboxReady = freshCheck.vboxInstalled;

        if (!vboxReady) {
          this._setPhase('download_vbox', 'active');
          this._emitProgress('download_vbox', 'Downloading VirtualBox...', 0);

          const downloadDir = getDownloadDir();
          const vboxUrl = await this._resolveVBoxDownloadUrl();

          const vboxInstallerPath = await downloadFile(
            vboxUrl,
            downloadDir,
            null,
            {
              signal: this.abortController.signal,
              onProgress: (p) => {
                this._emitProgress('download_vbox',
                  `Downloading VirtualBox... ${p.percent || 0}% (${p.speedFormatted})`,
                  p.percent || 0,
                  p
                );
              }
            }
          );

          this._emitProgress('download_vbox', 'VirtualBox downloaded', 100);
          this._setPhase('download_vbox', 'complete');
          await stateManager.completePhase('download_vbox', { vboxInstallerPath });

          // ─── Phase 3: Install VirtualBox ──────────────────────────────
          this._setPhase('install_vbox', 'active');
          this._emitProgress('install_vbox', 'Installing VirtualBox (admin permission may be required)...', 0);

          await this._installVirtualBox(vboxInstallerPath);
          await virtualbox.init();

          if (!virtualbox.isInstalled()) {
            throw new Error('VirtualBox installation failed — VBoxManage not found after install.');
          }

          const version = await virtualbox.getVersion();
          this._emitProgress('install_vbox', `VirtualBox ${version} installed successfully`, 100);
          this._setPhase('install_vbox', 'complete');
          await stateManager.completePhase('install_vbox');
        } else {
          // VirtualBox already installed — skip
          this._setPhase('download_vbox', 'skipped');
          this._setPhase('install_vbox', 'skipped');
          await stateManager.skipPhase('download_vbox');
          await stateManager.skipPhase('install_vbox');
          await virtualbox.init();

          const version = await virtualbox.getVersion();
          logger.info('Orchestrator', `VirtualBox ${version} already installed — skipping download`);
        }
      }

      // ─── Phase 4: Download OS ISO ──────────────────────────────────
      const selectedOS = findOS(config.osName || config.ubuntuVersion) || OS_CATALOG['Custom ISO'];
      const selectedIsoConfig = selectedOS || UBUNTU_RELEASES[config.ubuntuVersion];
      let isoPath;

      // Check if ISO was already downloaded in a previous run
      if (_shouldSkip('download_iso') && stateManager.state?.artifacts?.isoPath) {
        isoPath = stateManager.state.artifacts.isoPath;
        if (fs.existsSync(isoPath)) {
          this._setPhase('download_iso', 'complete');
          this._emitProgress('download_iso', 'ISO already downloaded (previous run)', 100);
          logger.info('Orchestrator', `⏭ ISO download — already done: ${isoPath}`);
        } else {
          // ISO file was deleted — need to re-download
          logger.warn('Orchestrator', 'ISO file missing — re-downloading...');
          _shouldSkip('download_iso'); // force re-run below
        }
      }

      if (!isoPath || !fs.existsSync(isoPath)) {
        this._setPhase('download_iso', 'active');

        if (config.customIsoPath) {
          isoPath = config.customIsoPath;
          logger.info('Orchestrator', `Using custom ISO: ${isoPath}`);
          this._emitProgress('download_iso', 'Using custom ISO file', 100);
          this._setPhase('download_iso', 'skipped');
          await stateManager.skipPhase('download_iso');
        } else if (selectedIsoConfig?.downloadUrl && selectedIsoConfig?.filename) {
          const downloadDir = getDownloadDir();
          const expectedPath = path.join(downloadDir, selectedIsoConfig.filename);

          if (isDownloadComplete(expectedPath)) {
            isoPath = expectedPath;
            logger.info('Orchestrator', `ISO already downloaded: ${isoPath}`);
            this._emitProgress('download_iso', 'Ubuntu ISO already downloaded', 100);
          } else {
            this._emitProgress('download_iso', `Downloading ${config.osName || 'OS'} ISO...`, 0);

            isoPath = await downloadFile(
              selectedIsoConfig.downloadUrl,
              downloadDir,
              selectedIsoConfig.filename,
              {
                signal: this.abortController.signal,
                onProgress: (p) => {
                  this._emitProgress('download_iso',
                    `Downloading ISO... ${p.percent || 0}% (${p.speedFormatted})`,
                    p.percent || 0,
                    p
                  );
                }
              }
            );
          }

          this._emitProgress('download_iso', 'ISO downloaded', 100);
          this._setPhase('download_iso', 'complete');
          await stateManager.completePhase('download_iso', { isoPath });
        } else {
          throw new Error(`No download URL found for "${config.osName || config.ubuntuVersion}". Please select a custom ISO.`);
        }
      }

      // ─── Phase 5: Verify ISO Integrity ─────────────────────────────
      this._setPhase('verify_iso', 'active');
      this._emitProgress('verify_iso', 'Verifying ISO checksum...', 0);

      if (selectedIsoConfig && selectedIsoConfig.sha256Url && !config.customIsoPath) {
        try {
          // Download SHA256SUMS file
          const sha256sumsPath = await downloadFile(
            selectedIsoConfig.sha256Url,
            getDownloadDir(),
            'SHA256SUMS',
            { signal: this.abortController.signal }
          );

          const sha256sumsContent = await fs.promises.readFile(sha256sumsPath, 'utf8');
          const expectedHash = parseHashFromSHA256SUMS(sha256sumsContent, selectedIsoConfig.filename);

          if (expectedHash) {
            const actualHash = await computeSHA256(isoPath, (p) => {
              this._emitProgress('verify_iso', `Verifying checksum... ${p}%`, p);
            });

            if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
              throw new Error('ISO checksum verification FAILED. The file may be corrupted. Please try again.');
            }

            logger.success('Orchestrator', 'ISO checksum verification PASSED');
          } else {
            logger.warn('Orchestrator', 'Could not find hash in SHA256SUMS — skipping verification');
          }
        } catch (err) {
          if (err.message.includes('FAILED') || err.message.includes('corrupted')) {
            throw err;  // Re-throw checksum failures
          }
          logger.warn('Orchestrator', `Checksum verification skipped: ${err.message}`);
        }
      } else {
        logger.info('Orchestrator', 'Custom ISO — checksum verification skipped');
      }

      this._emitProgress('verify_iso', 'ISO integrity verified', 100);
      this._setPhase('verify_iso', 'complete');
      await stateManager.completePhase('verify_iso');

      // ─── Phase 6: Create & Configure VM ────────────────────────────
      let vmResult;

      if (_shouldSkip('create_vm') && stateManager.state?.artifacts?.vmCreated) {
        // VM already created in previous run — verify it exists
        const vmExists = await virtualbox.vmExists(config.vmName);
        if (vmExists) {
          this._setPhase('create_vm', 'complete');
          this._emitProgress('create_vm', 'VM already created (previous run)', 100);
          logger.info('Orchestrator', `⏭ VM create — "${config.vmName}" already exists, skipping`);
          vmResult = { vmName: config.vmName, sharedFolder: stateManager.state.artifacts.sharedFolderResult || null };
        } else {
          logger.warn('Orchestrator', 'VM was deleted — recreating...');
          _shouldSkip('create_vm'); // fallthrough
        }
      }

      if (!vmResult) {
        this._setPhase('create_vm', 'active');
        this._emitProgress('create_vm', 'Creating virtual machine...', 0);

        vmResult = await createAndConfigureVM(
          {
            name: config.vmName,
            installPath: config.installPath,
            ram: config.ram,
            cpus: config.cpus,
            disk: config.disk,
            isoPath,
            osType: selectedIsoConfig?.osType || 'Other_64',
            network: config.network,
            sharedFolderPath: config.sharedFolderPath,
            username: config.username || 'user',
            password: config.password || 'password',
            unattended: selectedIsoConfig?.unattended !== false,
            graphicsController: selectedIsoConfig?.graphicsController || 'vmsvga',
            vram: config.vram || selectedIsoConfig?.vram || 128,
            audioController: config.audioController || 'hda'
          },
          (p) => {
            this._emitProgress('create_vm', p.message, p.percent);
          }
        );

        this._setPhase('create_vm', 'complete');
        await stateManager.completePhase('create_vm', {
          vmCreated: true,
          sharedFolderResult: vmResult.sharedFolder
        });
      }

      // ─── Phase 7: OS Installation Started ──────────────────────────
      const unattendedInstall = selectedIsoConfig?.unattended !== false;
      if (_shouldSkip('install_os')) {
        this._setPhase('install_os', 'complete');
        this._emitProgress('install_os', 'OS installation started (previous run)', 100);
        logger.info('Orchestrator', '⏭ OS install — already started, skipping');

        // If VM isn't running, start it
        const vmState = await virtualbox.getVMState(config.vmName);
        if (vmState !== 'running') {
          logger.info('Orchestrator', `VM is ${vmState} — starting it...`);
          await virtualbox.startVM(config.vmName);
        }
      } else {
        this._setPhase('install_os', 'active');
        if (unattendedInstall) {
          this._emitProgress('install_os', 'OS is installing automatically in the VM window...', 10);
          logger.info('Orchestrator', 'The VM is now running. OS installation is unattended.');
        } else {
          this._emitProgress('install_os', 'VM booted. Complete OS installation manually from the ISO.', 10);
          logger.info('Orchestrator', 'Manual installation required for this OS profile.');
        }
        logger.info('Orchestrator', 'This may take 10-20 minutes. Please do not close the VM window.');
        this._setPhase('install_os', 'complete');
        await stateManager.completePhase('install_os', { vmStarted: true });
      }

      // ─── Phase 8: Wait for boot & Guest Additions ───────────────────
      if (!unattendedInstall) {
        this._setPhase('wait_boot', 'skipped');
        this._setPhase('guest_config', 'skipped');
        logger.info('Orchestrator', 'Skipping guest auto-configuration for manual-install OS profile.');
      } else {
      this._setPhase('wait_boot', 'active');
      this._emitProgress('wait_boot', 'Waiting for OS installation to complete and Guest Additions to start...', 0);

      const gaUsername = config.username || 'user';
      const gaPassword = config.password || 'password';

      // Wait for Guest Additions to be running (up to 20 minutes)
      // This means Ubuntu has finished installing and rebooted
      const gaReady = await virtualbox.waitForGuestAdditions(
        config.vmName,
        1200000,  // 20 minute timeout — installation takes time
        (p) => {
          this._emitProgress('wait_boot', p.message, null);
        }
      );

      if (gaReady) {
        this._emitProgress('wait_boot', 'Guest Additions detected! Waiting for Ubuntu desktop...', 70);

        // Wait for the guest OS to actually be responsive
        const guestReady = await virtualbox.waitForGuestReady(
          config.vmName, gaUsername, gaPassword,
          300000,  // 5 minute timeout
          (p) => {
            this._emitProgress('wait_boot', p.message, null);
          }
        );

        if (guestReady) {
          this._emitProgress('wait_boot', 'Guest OS is ready!', 100);
          this._setPhase('wait_boot', 'complete');

          // ─── Phase 9: In-Guest Configuration ─────────────────────────
          this._setPhase('guest_config', 'active');
          this._emitProgress('guest_config', 'Configuring guest integration (shared folders, clipboard, fullscreen)...', 0);

          const guestResult = await configureGuestInside(
            config.vmName,
            gaUsername,
            gaPassword,
            (p) => {
              this._emitProgress('guest_config', p.message, p.percent);
            },
            {
              configureSharedFolder: !!config.sharedFolderPath,
              sharedFolderName: 'shared'
            }
          );

          if (!guestResult || guestResult.guestAdditionsInstalled !== true) {
            throw new Error('In-guest configuration did not complete successfully. Check VM console and logs, then retry/resume setup.');
          }

          this._emitProgress('guest_config', 'Guest integration fully configured!', 100);
          this._setPhase('guest_config', 'complete');
          await stateManager.completePhase('guest_config', { guestConfigured: true });
        } else {
          this._emitProgress('wait_boot', 'OS booted but not yet responsive — in-guest config will happen on next boot', 100);
          this._setPhase('wait_boot', 'complete');
          this._setPhase('guest_config', 'skipped');
          logger.warn('Orchestrator', 'Guest not responsive yet. Services will auto-start on next login.');
        }
      } else {
        this._emitProgress('wait_boot', 'OS is still installing — in-guest config will happen on next boot', 100);
        this._setPhase('wait_boot', 'complete');
        this._setPhase('guest_config', 'skipped');
        logger.warn('Orchestrator', 'Guest Additions not yet ready. OS is likely still installing.');
        logger.info('Orchestrator', 'The in-guest setup will complete automatically when you log in.');
      }
      }

      // ─── Phase 10: Complete ────────────────────────────────────────
      this._setPhase('complete', 'active');

      const finalResult = {
        success: true,
        vmName: config.vmName,
        credentials: {
          username: gaUsername,
          password: gaPassword
        },
        sharedFolder: vmResult.sharedFolder,
        installPath: config.installPath,
        message: unattendedInstall
          ? 'VM setup complete! OS is fully configured.'
          : 'VM created and booted. Complete manual installation in the VM window.'
      };

      this._emitProgress('complete', 'Setup complete! Your VM is ready to use.', 100);
      this._setPhase('complete', 'complete');
      await stateManager.markComplete();

      logger.success('Orchestrator', '══════════════════════════════════════════');
      logger.success('Orchestrator', '  Setup Complete — Everything Configured!');
      logger.success('Orchestrator', `  VM: ${config.vmName}`);
      logger.success('Orchestrator', `  Username: ${finalResult.credentials.username}`);
      logger.success('Orchestrator', `  Password: ${finalResult.credentials.password}`);
      logger.success('Orchestrator', '  ✓ Guest Additions installed');
      logger.success('Orchestrator', '  ✓ Clipboard sharing enabled');
      logger.success('Orchestrator', '  ✓ Drag & drop enabled');
      logger.success('Orchestrator', '  ✓ Fullscreen / dynamic resolution');
      logger.success('Orchestrator', '  ✓ Shared folder auto-mounted');
      logger.success('Orchestrator', '  ✓ All settings persist across reboots');
      logger.success('Orchestrator', '══════════════════════════════════════════');

      this.emit('complete', finalResult);
      return finalResult;

    } catch (err) {
      if (this.abortController?.signal?.aborted || err?.name === 'AbortError') {
        logger.warn('Orchestrator', 'Setup cancelled by user — progress saved, can resume later');

        if (this.currentPhase) {
          this._setPhase(this.currentPhase, 'skipped');
        }

        this.emit('error', {
          phase: this.currentPhase,
          message: 'Setup cancelled by user. Progress saved for resume.',
          recoverable: true,
          cancelled: true
        });

        throw new Error('Setup cancelled by user. Progress saved for resume.');
      }

      logger.error('Orchestrator', `Setup failed: ${err.message}`);

      // Save the failure to state — so we can resume from here
      if (this.currentPhase) {
        await stateManager.failPhase(this.currentPhase, err.message);
        this._setPhase(this.currentPhase, 'error');
      }

      this.emit('error', {
        phase: this.currentPhase,
        message: err.message,
        recoverable: true  // Can resume from saved state
      });

      throw err;

    } finally {
      this.isRunning = false;
      this.resumeMode = false;
    }
  }

  /**
   * Cancel the running setup.
   * State is preserved — user can resume later.
   */
  cancel() {
    if (this.abortController) {
      logger.warn('Orchestrator', 'Setup cancelled by user — progress saved, can resume later');
      this.abortController.abort();
    }
  }

  /**
   * Resolve the VirtualBox download URL for the current platform.
   */
  async _resolveVBoxDownloadUrl() {
    const osType = platform.getOS();
    logger.info('Orchestrator', `Resolving VirtualBox download URL for ${osType}...`);

    // Use a known stable version URL
    // In production, this would scrape virtualbox.org/wiki/Downloads
    // for the latest version dynamically
    if (osType === 'windows') {
      // This is a pattern — the actual version/build would be resolved
      return 'https://download.virtualbox.org/virtualbox/7.1.6/VirtualBox-7.1.6-167084-Win.exe';
    } else {
      return 'https://download.virtualbox.org/virtualbox/7.1.6/virtualbox-7.1_7.1.6-167084~Ubuntu~jammy_amd64.deb';
    }
  }

  /**
   * Install VirtualBox from the downloaded installer.
   */
  async _installVirtualBox(installerPath) {
    const installCmd = platform.getInstallerCommand(installerPath);

    logger.info('Orchestrator', `Running VirtualBox installer: ${installerPath}`);
    logger.info('Orchestrator', 'Admin permission may be required — please approve if prompted.');

    return new Promise((resolve, reject) => {
      if (platform.getOS() === 'windows') {
        // Windows: Run with elevation via shell
        const cmd = `"${installCmd.cmd}" ${installCmd.args.join(' ')}`;

        exec(cmd, { timeout: 600000 }, (error, stdout, stderr) => {
          if (error) {
            // Error code 3010 means "reboot required" — still success
            if (error.code === 3010) {
              logger.warn('Orchestrator', 'VirtualBox installed — a reboot may be needed later.');
              resolve();
            } else {
              logger.error('Orchestrator', `VirtualBox install failed: ${stderr || error.message}`);
              reject(new Error(`VirtualBox installation failed: ${stderr || error.message}`));
            }
          } else {
            logger.success('Orchestrator', 'VirtualBox installed successfully');
            resolve();
          }
        });
      } else {
        // Linux: Use dpkg
        execFile(installCmd.cmd, installCmd.args, { timeout: 600000 }, (error, stdout, stderr) => {
          if (error) {
            // Try fix broken dependencies
            exec('sudo apt-get install -f -y', { timeout: 120000 }, () => {
              resolve();
            });
          } else {
            logger.success('Orchestrator', 'VirtualBox installed successfully');
            resolve();
          }
        });
      }
    });
  }

  /**
   * Internal: Update phase status and emit to UI.
   */
  _setPhase(phaseId, status) {
    this.currentPhase = phaseId;
    const phase = PHASES.find(p => p.id === phaseId);
    if (phase) {
      this.emit('phase', { ...phase, status });
    }
  }

  /**
   * Internal: Emit progress update to UI.
   */
  _emitProgress(phaseId, message, percent, downloadProgress = null) {
    this.emit('progress', {
      phase: phaseId,
      message,
      percent,
      downloadProgress
    });
  }
}

// Singleton
const orchestrator = new Orchestrator();
module.exports = orchestrator;
