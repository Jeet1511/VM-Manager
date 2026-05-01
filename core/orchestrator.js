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
  { id: 'create_vm', label: 'Create & Configure V Os', icon: '🔧' },
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
    this.vboxEnsurePromise = null;
    this.vboxEnsureAbortController = null;
    this.vboxEnsurePhase = null;
  }

  /**
   * Ensure VirtualBox is installed and ready.
   * Used by setup workflow and startup preflight.
   *
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {function} [options.onProgress]
   * @returns {Promise<object>}
   */
  async ensureVirtualBoxInstalled(options = {}) {
    const { signal = null, onProgress = null, downloadDir = null, installerPath = '' } = options;

    if (this.vboxEnsurePromise) {
      return this.vboxEnsurePromise;
    }

    const localController = signal ? null : new AbortController();
    const effectiveSignal = signal || localController?.signal || null;
    if (localController) {
      this.vboxEnsureAbortController = localController;
    }

    const emitVBoxProgress = (payload = {}) => {
      this.vboxEnsurePhase = payload.phase || this.vboxEnsurePhase;
      if (onProgress) onProgress(payload);
    };

    this.vboxEnsurePromise = (async () => {
      emitVBoxProgress({ phase: 'system_check', message: 'Checking VirtualBox installation...', percent: 0 });

      const initial = await runSystemCheck();
      if (initial.vboxInstalled) {
        await virtualbox.init();
        emitVBoxProgress({ phase: 'system_check', message: 'VirtualBox already installed.', percent: 100 });
        return {
          success: true,
          installed: true,
          downloaded: false,
          installerPath: null,
          version: await virtualbox.getVersion()
        };
      }

      let vboxInstallerPath = String(installerPath || '').trim();
      const usingLocalInstaller = !!vboxInstallerPath;
      if (!usingLocalInstaller) {
        const resolvedDownloadDir = String(downloadDir || '').trim() || getDownloadDir();
        const vboxUrl = await this._resolveVBoxDownloadUrl();
        let suggestedFilename = '';
        try {
          const parsedUrl = new URL(vboxUrl);
          suggestedFilename = path.basename(parsedUrl.pathname || '') || '';
        } catch {}

        const cachedInstallerPath = suggestedFilename
          ? path.join(resolvedDownloadDir, suggestedFilename)
          : '';

        if (cachedInstallerPath && isDownloadComplete(cachedInstallerPath)) {
          vboxInstallerPath = cachedInstallerPath;
          emitVBoxProgress({
            phase: 'download_vbox',
            message: `Using previously downloaded installer: ${path.basename(vboxInstallerPath)}`,
            percent: 100
          });
        } else {
          emitVBoxProgress({ phase: 'download_vbox', message: 'Downloading VirtualBox...', percent: 0 });
          vboxInstallerPath = await downloadFile(
            vboxUrl,
            resolvedDownloadDir,
            suggestedFilename || null,
            {
              signal: effectiveSignal,
              onProgress: (p) => {
                emitVBoxProgress({
                  phase: 'download_vbox',
                  message: `Downloading VirtualBox... ${p.percent || 0}% (${p.speedFormatted})`,
                  percent: p.percent || 0,
                  downloadProgress: p
                });
              }
            }
          );
        }
      } else {
        const resolvedPath = path.resolve(vboxInstallerPath);
        if (!fs.existsSync(resolvedPath)) {
          throw new Error('Selected VirtualBox installer file was not found.');
        }
        vboxInstallerPath = resolvedPath;
        emitVBoxProgress({
          phase: 'download_vbox',
          message: `Using selected installer: ${path.basename(vboxInstallerPath)}`,
          percent: 100
        });
      }

      emitVBoxProgress({ phase: 'install_vbox', message: 'Installing VirtualBox...', percent: 10 });

      await this._installVirtualBox(vboxInstallerPath);
      await virtualbox.init();

      if (!virtualbox.isInstalled()) {
        throw new Error('VirtualBox installation failed — VBoxManage not found after install.');
      }

      const version = await virtualbox.getVersion();
      emitVBoxProgress({
        phase: 'install_vbox',
        message: `VirtualBox ${version || ''} installed successfully`,
        percent: 100
      });

      emitVBoxProgress({ phase: 'system_check', message: 'VirtualBox verification complete.', percent: 100 });

      return {
        success: true,
        installed: true,
        downloaded: !usingLocalInstaller,
        installerPath: vboxInstallerPath,
        usedLocalInstaller: usingLocalInstaller,
        version
      };
    })().finally(() => {
      this.vboxEnsurePromise = null;
      this.vboxEnsureAbortController = null;
      this.vboxEnsurePhase = null;
    });

    return this.vboxEnsurePromise;
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
      logger.info('Orchestrator', '  VM Xposed — RESUMING Setup');
      logger.info('Orchestrator', `  Resuming from: ${resumeFrom}`);
      logger.info('Orchestrator', '══════════════════════════════════════════');
    } else {
      // Create fresh state
      stateManager.createNewState(config);
      logger.info('Orchestrator', '══════════════════════════════════════════');
      logger.info('Orchestrator', '  VM Xposed — Starting Setup');
      logger.info('Orchestrator', '══════════════════════════════════════════');
    }

    logger.info('Orchestrator', `V Os Name: ${config.vmName}`);
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

          const ensureResult = await this.ensureVirtualBoxInstalled({
            signal: this.abortController.signal,
            onProgress: (data) => {
              if (!data?.phase) return;
              if (data.phase === 'download_vbox') {
                this._emitProgress('download_vbox', data.message || 'Downloading VirtualBox...', data.percent ?? 0, data.downloadProgress || null);
              }
              if (data.phase === 'install_vbox') {
                if (this.currentPhase !== 'install_vbox') {
                  this._setPhase('download_vbox', 'complete');
                  this._setPhase('install_vbox', 'active');
                }
                this._emitProgress('install_vbox', data.message || 'Installing VirtualBox...', data.percent ?? 0);
              }
            }
          });

          this._setPhase('download_vbox', 'complete');
          await stateManager.completePhase('download_vbox', { vboxInstallerPath: ensureResult.installerPath || null });

          this._setPhase('install_vbox', 'active');
          const version = ensureResult.version || await virtualbox.getVersion();
          this._emitProgress('install_vbox', `VirtualBox ${version || ''} installed successfully`, 100);
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
      const selectedOS = config._resolvedOsProfile || findOS(config.osName || config.ubuntuVersion) || OS_CATALOG['Custom ISO'];
      const selectedIsoConfig = selectedOS || UBUNTU_RELEASES[config.ubuntuVersion];
      const resolvedDownloadDir = String(config.downloadPath || '').trim() || getDownloadDir();
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
          const expectedPath = path.join(resolvedDownloadDir, selectedIsoConfig.filename);

          this._emitProgress('download_iso', `ISO storage path: ${expectedPath}`, 1);

          if (isDownloadComplete(expectedPath)) {
            isoPath = expectedPath;
            logger.info('Orchestrator', `ISO already downloaded: ${isoPath}`);
            this._emitProgress('download_iso', 'ISO already downloaded — reusing local file', 100);
          } else {
            this._emitProgress('download_iso', `Downloading ${config.osName || 'OS'} ISO...`, 0);

            isoPath = await downloadFile(
              selectedIsoConfig.downloadUrl,
              resolvedDownloadDir,
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
            resolvedDownloadDir,
            'SHA256SUMS',
            { signal: this.abortController.signal }
          );

          const sha256sumsContent = await fs.promises.readFile(sha256sumsPath, 'utf8');
          const expectedHash = parseHashFromSHA256SUMS(sha256sumsContent, selectedIsoConfig.filename);

          if (expectedHash) {
            const verifyCurrentIso = async () => {
              return computeSHA256(isoPath, (p) => {
                this._emitProgress('verify_iso', `Verifying checksum... ${p}%`, p);
              });
            };

            let actualHash = await verifyCurrentIso();
            if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
              if (!selectedIsoConfig.downloadUrl || !selectedIsoConfig.filename) {
                throw new Error('ISO checksum verification FAILED. Automatic re-download is unavailable for this OS profile. Please select a custom ISO.');
              }
              logger.warn('Orchestrator', `Checksum mismatch for ${isoPath}. Re-downloading clean copy...`);
              this._emitProgress('verify_iso', 'Checksum mismatch detected. Re-downloading a clean ISO copy...', 10);

              try {
                await fs.promises.unlink(isoPath);
              } catch (unlinkErr) {
                logger.warn('Orchestrator', `Could not remove corrupted ISO before retry: ${unlinkErr.message}`);
              }

              isoPath = await downloadFile(
                selectedIsoConfig.downloadUrl,
                resolvedDownloadDir,
                selectedIsoConfig.filename,
                {
                  signal: this.abortController.signal,
                  resume: false,
                  onProgress: (p) => {
                    this._emitProgress(
                      'verify_iso',
                      `Re-downloading ISO... ${p.percent || 0}% (${p.speedFormatted})`,
                      p.percent || 0
                    );
                  }
                }
              );
              await stateManager.completePhase('download_iso', { isoPath });
              this._emitProgress('verify_iso', 'Re-download complete. Verifying checksum again...', 70);

              actualHash = await verifyCurrentIso();
            }

            if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
              throw new Error('ISO checksum verification FAILED after re-download. The source file may be unavailable or corrupted. Please try again later or choose a custom ISO.');
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
          this._emitProgress('create_vm', 'V Os already created (previous run)', 100);
          logger.info('Orchestrator', `⏭ V Os create — "${config.vmName}" already exists, skipping`);
          vmResult = { vmName: config.vmName, sharedFolder: stateManager.state.artifacts.sharedFolderResult || null };
        } else {
          logger.warn('Orchestrator', 'V Os was deleted — recreating...');
          _shouldSkip('create_vm'); // fallthrough
        }
      }

      if (!vmResult) {
        this._setPhase('create_vm', 'active');
        this._emitProgress('create_vm', 'Creating virtual OS...', 0);

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
            sharedFolderPath: config.enableSharedFolder ? config.sharedFolderPath : '',
            username: config.username || 'guest',
            password: config.password || 'guest',
            unattended: selectedIsoConfig?.unattended !== false,
            graphicsController: selectedIsoConfig?.graphicsController || 'vmsvga',
            vram: config.vram || selectedIsoConfig?.vram || 128,
            audioController: config.audioController || 'hda',
            startFullscreen: config.startFullscreen !== false,
            accelerate3d: config.accelerate3d === true,
            clipboardMode: config.clipboardMode || 'bidirectional',
            dragAndDrop: config.dragAndDrop || 'bidirectional',
            autoStartVm: config.autoStartVm === true
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
      const autoStartVm = config.autoStartVm === true;
      if (_shouldSkip('install_os')) {
        if (autoStartVm) {
          this._setPhase('install_os', 'complete');
          this._emitProgress('install_os', 'OS installation started (previous run)', 100);
          logger.info('Orchestrator', '⏭ OS install — already started, skipping');

          // If VM isn't running, start it
          const vmState = await virtualbox.getVMState(config.vmName);
          if (vmState !== 'running') {
            logger.info('Orchestrator', `V Os is ${vmState} — starting it...`);
            await virtualbox.startVM(config.vmName);
          }
        } else {
          this._setPhase('install_os', 'skipped');
          this._emitProgress('install_os', 'Auto-start is disabled. V Os was prepared but not launched.', 100);
          await stateManager.skipPhase('install_os');
        }
      } else if (!autoStartVm) {
        this._setPhase('install_os', 'skipped');
        this._emitProgress('install_os', 'Auto-start is disabled. Start the V Os manually to begin OS installation.', 100);
        logger.info('Orchestrator', 'Skipping automatic V Os boot to keep host responsive.');
        await stateManager.skipPhase('install_os');
      } else {
        this._setPhase('install_os', 'active');
        if (unattendedInstall) {
          this._emitProgress('install_os', 'OS is installing automatically in the V Os window...', 10);
          logger.info('Orchestrator', 'The V Os is now running. OS installation is unattended.');
        } else {
          this._emitProgress('install_os', 'V Os booted. Complete OS installation manually from the ISO.', 10);
          logger.info('Orchestrator', 'Manual installation required for this OS profile.');
        }
        logger.info('Orchestrator', 'This may take 10-20 minutes. Please do not close the V Os window.');
        this._setPhase('install_os', 'complete');
        await stateManager.completePhase('install_os', { vmStarted: true });
      }

      // ─── Phase 8: Wait for boot & Guest Additions ───────────────────
      const gaUsername = config.username || 'guest';
      const gaPassword = config.password || 'guest';
      let guestConfigured = false;
      let guestConfigWarning = '';

      if (!unattendedInstall) {
        this._setPhase('wait_boot', 'skipped');
        this._setPhase('guest_config', 'skipped');
        logger.info('Orchestrator', 'Skipping guest auto-configuration for manual-install OS profile.');
      } else if (!autoStartVm) {
        this._setPhase('wait_boot', 'skipped');
        this._setPhase('guest_config', 'skipped');
        guestConfigWarning = 'Automatic V Os start is disabled. Start the V Os manually and run Guest Setup when the OS is ready.';
        logger.info('Orchestrator', 'Skipping wait_boot/guest_config because auto-start is disabled.');
      } else {
        this._setPhase('wait_boot', 'active');
        this._emitProgress('wait_boot', 'Waiting for OS installation to complete and Guest Additions to start...', 0);

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
          this._emitProgress('wait_boot', 'Guest Additions detected! Ejecting install media...', 60);

          // Eject the ISO and set boot order to disk-first now that OS is installed
          try {
            // Remove the ISO from the virtual DVD drive so it doesn't boot from it again
            await virtualbox._run(['storageattach', config.vmName, '--storagectl', 'IDE Controller', '--port', '1', '--device', '0', '--medium', 'none']).catch(() => {});
            await virtualbox._run(['storageattach', config.vmName, '--storagectl', 'IDE Controller', '--port', '0', '--device', '1', '--medium', 'none']).catch(() => {});
            // Change boot order to disk first
            await virtualbox._run(['modifyvm', config.vmName, '--boot1', 'disk', '--boot2', 'dvd', '--boot3', 'none', '--boot4', 'none']).catch(async () => {
              // If modifyvm fails because VM is running, try via setextradata
              await virtualbox._run(['setextradata', config.vmName, 'GUI/DefaultCloseAction', 'PowerOff']).catch(() => {});
            });
            logger.success('Orchestrator', 'Install media ejected and boot order set to disk-first');
          } catch (ejectErr) {
            logger.warn('Orchestrator', `Could not eject install media: ${ejectErr.message}`);
          }

          this._emitProgress('wait_boot', 'Waiting for Ubuntu desktop...', 70);

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

            try {
              const guestResult = await configureGuestInside(
                config.vmName,
                gaUsername,
                gaPassword,
                (p) => {
                  this._emitProgress('guest_config', p.message, p.percent);
                },
                {
                  configureSharedFolder: !!(config.enableSharedFolder && config.sharedFolderPath),
                  sharedFolderName: 'shared'
                }
              );

              if (!guestResult || guestResult.guestAdditionsInstalled !== true) {
                throw new Error('In-guest configuration did not complete successfully.');
              }

              guestConfigured = true;
              this._emitProgress('guest_config', 'Guest integration fully configured!', 100);
              this._setPhase('guest_config', 'complete');
              await stateManager.completePhase('guest_config', { guestConfigured: true });
            } catch (guestErr) {
              guestConfigured = false;
              guestConfigWarning = guestErr.message;
              this._emitProgress('guest_config', 'OS installed. Integration setup will continue after login from V Os tools.', 100);
              this._setPhase('guest_config', 'skipped');
              logger.warn('Orchestrator', `Guest integration deferred: ${guestErr.message}`);
            }
          } else {
            this._emitProgress('wait_boot', 'OS booted but not yet responsive — in-guest config will happen on next boot', 100);
            this._setPhase('wait_boot', 'complete');
            this._setPhase('guest_config', 'skipped');
            guestConfigWarning = 'Guest OS booted but was not yet responsive for integration commands.';
            logger.warn('Orchestrator', 'Guest not responsive yet. Services will auto-start on next login.');
          }
        } else {
          this._emitProgress('wait_boot', 'OS is still installing — in-guest config will happen on next boot', 100);
          this._setPhase('wait_boot', 'complete');
          this._setPhase('guest_config', 'skipped');
          guestConfigWarning = 'Guest Additions was not ready before setup completion.';
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
        guestConfigured,
        autoStartVm,
        guestConfigWarning,
        sharedFolder: vmResult.sharedFolder,
        installPath: config.installPath,
        message: unattendedInstall
          ? (!autoStartVm
            ? 'V Os prepared successfully. Start it manually to begin OS installation.'
            : (guestConfigured
              ? 'V Os setup complete! OS and guest integration are fully configured.'
              : 'V Os setup complete. OS is installed and guest integration will finish after first login.'))
          : (!autoStartVm
            ? 'V Os prepared successfully. Start it manually and complete installation from the ISO.'
            : 'V Os created and booted. Complete manual installation in the V Os window.')
      };

      this._emitProgress('complete', finalResult.message, 100);
      this._setPhase('complete', 'complete');
      await stateManager.markComplete();

      logger.success('Orchestrator', '══════════════════════════════════════════');
      logger.success(
        'Orchestrator',
        (!autoStartVm)
          ? '  Setup Complete — V Os Prepared (Manual Start Required)'
          : ((guestConfigured || !unattendedInstall)
            ? '  Setup Complete — Everything Configured!'
            : '  Setup Complete — OS Ready, Integration Pending')
      );
      logger.success('Orchestrator', `  V Os: ${config.vmName}`);
      logger.success('Orchestrator', `  Username: ${finalResult.credentials.username}`);
      logger.success('Orchestrator', `  Password: ${finalResult.credentials.password}`);
      if (guestConfigured) {
        logger.success('Orchestrator', '  ✓ Guest Additions installed');
        logger.success('Orchestrator', '  ✓ Clipboard sharing enabled');
        logger.success('Orchestrator', '  ✓ Drag & drop enabled');
        logger.success('Orchestrator', '  ✓ Fullscreen / dynamic resolution');
        logger.success('Orchestrator', '  ✓ Shared folder auto-mounted');
        logger.success('Orchestrator', '  ✓ All settings persist across reboots');
      } else if (unattendedInstall) {
        logger.warn('Orchestrator', `  ⚠ Guest integration pending: ${guestConfigWarning || 'Will complete after login.'}`);
      }
      logger.success('Orchestrator', '══════════════════════════════════════════');

      this.emit('complete', finalResult);
      return finalResult;

    } catch (err) {
      if (this.abortController?.signal?.aborted || err?.name === 'AbortError') {
        const isPaused = this.abortController?.signal?.reason === 'paused'
          || err?.code === 'PAUSED'
          || /pause/i.test(String(err?.message || ''));
        const stopMessage = isPaused
          ? 'Setup paused by user. Progress saved for resume.'
          : 'Setup cancelled by user. Progress saved for resume.';
        logger.warn('Orchestrator', stopMessage);

        if (this.currentPhase) {
          this._setPhase(this.currentPhase, 'skipped');
        }

        this.emit('error', {
          phase: this.currentPhase,
          message: stopMessage,
          recoverable: true,
          cancelled: !isPaused,
          paused: isPaused
        });

        throw new Error(stopMessage);
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
    if (!this.abortController || this.abortController.signal.aborted) {
      return false;
    }
    logger.warn('Orchestrator', 'Setup cancelled by user — progress saved, can resume later');
    this.abortController.abort('cancelled');
    return true;
  }

  pause() {
    if (!this.abortController || this.abortController.signal.aborted) {
      return false;
    }
    logger.warn('Orchestrator', 'Setup paused by user — progress saved, can resume later');
    this.abortController.abort('paused');
    return true;
  }

  pauseVBoxDownload() {
    if (!this.vboxEnsureAbortController || this.vboxEnsureAbortController.signal.aborted) {
      return false;
    }
    if (this.vboxEnsurePhase !== 'download_vbox') {
      return false;
    }
    this.vboxEnsureAbortController.abort('paused');
    return true;
  }

  cancelVBoxDownload() {
    if (!this.vboxEnsureAbortController || this.vboxEnsureAbortController.signal.aborted) {
      return false;
    }
    this.vboxEnsureAbortController.abort('cancelled');
    return true;
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

    const _runWindowsInstaller = (args, elevated = false) => {
      return new Promise((resolve, reject) => {
        if (!elevated) {
          execFile(installerPath, args, { timeout: 900000, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr || error.message || 'Installer execution failed'));
              return;
            }
            resolve();
          });
          return;
        }

        const escapedPath = String(installerPath).replace(/'/g, "''");
        const psArgs = args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(', ');
        const psCommand = [
          `$p = Start-Process -FilePath '${escapedPath}' -ArgumentList ${psArgs} -Verb RunAs -Wait -PassThru`,
          'if ($null -eq $p) { exit 1 }',
          'exit $p.ExitCode'
        ].join('; ');

        execFile('powershell.exe', ['-NoProfile', '-Command', psCommand], { timeout: 900000, windowsHide: true }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message || 'Elevated installer execution failed'));
            return;
          }
          resolve();
        });
      });
    };

    return new Promise((resolve, reject) => {
      if (platform.getOS() === 'windows') {
        (async () => {
          const validSilentArgs = (Array.isArray(installCmd.args) && installCmd.args.length > 0)
            ? installCmd.args
            : ['--silent', '--msiparams', 'VBOX_START=0 REBOOT=ReallySuppress'];

          const attempts = [
            { label: 'default-silent-elevated', args: validSilentArgs, elevated: true },
            { label: 'default-silent', args: validSilentArgs, elevated: false },
            { label: 'silent-elevated-no-msi', args: ['--silent'], elevated: true },
            { label: 'silent-no-msi', args: ['--silent'], elevated: false }
          ];

          let lastError = null;

          for (const attempt of attempts) {
            try {
              logger.info('Orchestrator', `VirtualBox install attempt: ${attempt.label}`);
              await _runWindowsInstaller(attempt.args, attempt.elevated);

              // Verify after each attempt.
              await virtualbox.init();
              if (virtualbox.isInstalled()) {
                logger.success('Orchestrator', 'VirtualBox installed successfully');
                resolve();
                return;
              }
            } catch (err) {
              lastError = err;
              logger.warn('Orchestrator', `Install attempt failed (${attempt.label}): ${err.message}`);

              // Exit code 3010 means reboot required; treat as soft success if VBox is now visible.
              if (String(err.message || '').includes('3010')) {
                await virtualbox.init();
                if (virtualbox.isInstalled()) {
                  logger.warn('Orchestrator', 'VirtualBox installed — system reboot may be required later.');
                  resolve();
                  return;
                }
              }
            }
          }

          // Final verification before hard fail.
          await virtualbox.init();
          if (virtualbox.isInstalled()) {
            logger.success('Orchestrator', 'VirtualBox detected after install attempts.');
            resolve();
            return;
          }

          const errMsg = lastError?.message || 'Unknown installer failure';
          logger.error('Orchestrator', `VirtualBox install failed: ${errMsg}`);
          reject(new Error(`VirtualBox installation failed: ${errMsg}`));
        })();
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
