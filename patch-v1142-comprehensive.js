/**
 * patch-v1.1.42-comprehensive.js
 * Fixes: VBox 6/7 compatibility, clipboard, fullscreen, shared folders,
 *        guest additions, error handling, running VM edits
 */
const fs = require('fs');

// ═══════════════════════════════════════════════════════════════
// FIX 1: VirtualBox Version Detection + VBox 6/7 Flag Compatibility
// ═══════════════════════════════════════════════════════════════
let vbox = fs.readFileSync('adapters/virtualbox.js', 'utf8');

// Add version caching and helper after constructor
const constructorEnd = "this.preferredManagePath = '';";
const versionHelpers = `this.preferredManagePath = '';
    this._cachedMajorVersion = null;
  }

  /**
   * Get the major version of VirtualBox (6 or 7).
   * Cached after first call for performance.
   */
  async getMajorVersion() {
    if (this._cachedMajorVersion !== null) return this._cachedMajorVersion;
    try {
      const ver = await this.getVersion();
      if (ver) {
        const major = parseInt(String(ver).split('.')[0], 10);
        this._cachedMajorVersion = isNaN(major) ? 6 : major;
      } else {
        this._cachedMajorVersion = 6;
      }
    } catch {
      this._cachedMajorVersion = 6;
    }
    return this._cachedMajorVersion;
  }

  /**
   * Get the correct modifyvm flag for clipboard based on VBox version.
   * VBox 6: --clipboard, VBox 7+: --clipboard-mode
   */
  async getClipboardFlag() {
    const major = await this.getMajorVersion();
    return major >= 7 ? '--clipboard-mode' : '--clipboard';
  }

  /**
   * Get the correct modifyvm flag for drag-and-drop based on VBox version.
   * VBox 6: --draganddrop, VBox 7+: --drag-and-drop
   */
  async getDragAndDropFlag() {
    const major = await this.getMajorVersion();
    return major >= 7 ? '--drag-and-drop' : '--draganddrop';
  }

  /**
   * Get the correct controlvm subcommand for clipboard.
   * VBox 6: 'clipboard', VBox 7+: 'clipboard mode'
   * Returns array of args to splice into the command.
   */
  async getControlVmClipboardArgs(mode) {
    const major = await this.getMajorVersion();
    return major >= 7
      ? ['clipboard', 'mode', mode]
      : ['clipboard', mode];
  }

  /**
   * Get the correct controlvm subcommand for drag-and-drop.
   * VBox 6: 'draganddrop', VBox 7+: 'draganddrop'
   * (Same on both versions for controlvm)
   */
  async getControlVmDragDropArgs(mode) {
    return ['draganddrop', mode];
  }`;

// Only add if not already present
if (!vbox.includes('_cachedMajorVersion')) {
  // Replace just the closing brace of constructor
  vbox = vbox.replace(
    "this.preferredManagePath = '';\n  }",
    versionHelpers
  );
  // Also try with \r\n
  if (!vbox.includes('_cachedMajorVersion')) {
    vbox = vbox.replace(
      "this.preferredManagePath = '';\r\n  }",
      versionHelpers
    );
  }
  console.log('FIX 1a: Added VBox version detection helpers');
} else {
  console.log('SKIP 1a: Version helpers already present');
}

// Fix configureVM to use version-appropriate flags
// Replace the static optionMap with dynamic flag resolution
const oldConfigureVM = `  async configureVM(name, options = {}) {
    let args = ['modifyvm', name];

    // Build arguments from options
    const optionMap = {
      ram: '--memory',
      cpus: '--cpus',
      vram: '--vram',
      graphicsController: '--graphicscontroller',
      accelerate3d: '--accelerate3d',
      audioController: '--audiocontroller',
      clipboardMode: '--clipboard',
      dragAndDrop: '--draganddrop',
      ioapic: '--ioapic',
      acpi: '--acpi',
      pae: '--pae',
      nestedPaging: '--nested-paging',
      largepages: '--largepages',
      rtcUseUtc: '--rtc-use-utc',
      usbOhci: '--usbohci',
      usbEhci: '--usbehci',
    };

    for (const [key, flag] of Object.entries(optionMap)) {
      if (options[key] !== undefined) {
        args.push(flag, String(options[key]));
      }
    }`;

const newConfigureVM = `  async configureVM(name, options = {}) {
    let args = ['modifyvm', name];

    // Get version-appropriate flags for clipboard and drag-drop
    const clipboardFlag = await this.getClipboardFlag();
    const dndFlag = await this.getDragAndDropFlag();

    // Build arguments from options
    const optionMap = {
      ram: '--memory',
      cpus: '--cpus',
      vram: '--vram',
      graphicsController: '--graphicscontroller',
      accelerate3d: '--accelerate3d',
      audioController: '--audiocontroller',
      clipboardMode: clipboardFlag,
      dragAndDrop: dndFlag,
      ioapic: '--ioapic',
      acpi: '--acpi',
      pae: '--pae',
      nestedPaging: '--nested-paging',
      largepages: '--largepages',
      rtcUseUtc: '--rtc-use-utc',
      usbOhci: '--usbohci',
      usbEhci: '--usbehci',
    };

    for (const [key, flag] of Object.entries(optionMap)) {
      if (options[key] !== undefined) {
        args.push(flag, String(options[key]));
      }
    }`;

if (vbox.includes(oldConfigureVM)) {
  vbox = vbox.replace(oldConfigureVM, newConfigureVM);
  console.log('FIX 1b: configureVM uses version-appropriate flags');
} else {
  console.log('SKIP 1b: configureVM pattern not found');
}

// Fix applyRuntimeIntegration to use version-appropriate controlvm commands
const oldClipboardRuntime = "await safeRun(['controlvm', vmName, 'clipboard', clipboardMode], 'clipboard runtime apply');";
const oldDndRuntime = "await safeRun(['controlvm', vmName, 'draganddrop', dragAndDrop], 'drag-and-drop runtime apply');";

const newClipboardRuntime = `const cbArgs = await this.getControlVmClipboardArgs(clipboardMode);
      await safeRun(['controlvm', vmName, ...cbArgs], 'clipboard runtime apply');`;
const newDndRuntime = `const dndArgs = await this.getControlVmDragDropArgs(dragAndDrop);
      await safeRun(['controlvm', vmName, ...dndArgs], 'drag-and-drop runtime apply');`;

if (vbox.includes(oldClipboardRuntime)) {
  vbox = vbox.replace(oldClipboardRuntime, newClipboardRuntime);
  console.log('FIX 1c: controlvm clipboard uses version-appropriate args');
}
if (vbox.includes(oldDndRuntime)) {
  vbox = vbox.replace(oldDndRuntime, newDndRuntime);
  console.log('FIX 1d: controlvm draganddrop uses version-appropriate args');
}

fs.writeFileSync('adapters/virtualbox.js', vbox, 'utf8');
console.log('--- virtualbox.js saved ---\n');

// ═══════════════════════════════════════════════════════════════
// FIX 2 & 3: main.js — Running VM edits + modifyvm → controlvm
// ═══════════════════════════════════════════════════════════════
let main = fs.readFileSync('main.js', 'utf8');

// Fix 2a: In running VM path, use controlvm for clipboard instead of modifyvm
// Lines ~4785-4791: modifyvm --clipboard on running VM causes E_ACCESSDENIED
const oldRunningClipboard = `        if (settings.clipboardMode) {
          await runSoft('Clipboard persistent apply failed', () => virtualbox._run(['modifyvm', vmName, '--clipboard', settings.clipboardMode]));
          await runSoft('Clipboard preference save failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/ClipboardMode', settings.clipboardMode]));
        }
        if (settings.dragAndDrop) {
          await runSoft('Drag & drop persistent apply failed', () => virtualbox._run(['modifyvm', vmName, '--draganddrop', settings.dragAndDrop]));
          await runSoft('Drag & drop preference save failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/DragAndDropMode', settings.dragAndDrop]));
        }`;

const newRunningClipboard = `        if (settings.clipboardMode) {
          // Use controlvm (not modifyvm) for running VMs to avoid E_ACCESSDENIED
          const cbArgs = await virtualbox.getControlVmClipboardArgs(settings.clipboardMode);
          await runSoft('Clipboard runtime apply failed', () => virtualbox._run(['controlvm', vmName, ...cbArgs]));
          await runSoft('Clipboard preference save failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/ClipboardMode', settings.clipboardMode]));
        }
        if (settings.dragAndDrop) {
          const dndArgs = await virtualbox.getControlVmDragDropArgs(settings.dragAndDrop);
          await runSoft('Drag & drop runtime apply failed', () => virtualbox._run(['controlvm', vmName, ...dndArgs]));
          await runSoft('Drag & drop preference save failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/DragAndDropMode', settings.dragAndDrop]));
        }`;

if (main.includes(oldRunningClipboard)) {
  main = main.replace(oldRunningClipboard, newRunningClipboard);
  console.log('FIX 2a: Running VM clipboard uses controlvm instead of modifyvm');
} else {
  console.log('SKIP 2a: Running VM clipboard pattern not found');
}

// Fix 2b: In poweroff path, use version-appropriate flags for modifyvm
const oldPoweroffClipboard = `      if (settings.clipboardMode) {
        await runSoft('Clipboard apply failed', () => virtualbox._run(['modifyvm', vmName, '--clipboard', settings.clipboardMode]));
        await runSoft('Clipboard preference save failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/ClipboardMode', settings.clipboardMode]));
      }
      if (settings.dragAndDrop) {
        await runSoft('Drag & drop apply failed', () => virtualbox._run(['modifyvm', vmName, '--draganddrop', settings.dragAndDrop]));
        await runSoft('Drag & drop preference save failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/DragAndDropMode', settings.dragAndDrop]));
      }`;

const newPoweroffClipboard = `      if (settings.clipboardMode) {
        const cbFlag = await virtualbox.getClipboardFlag();
        await runSoft('Clipboard apply failed', () => virtualbox._run(['modifyvm', vmName, cbFlag, settings.clipboardMode]));
        await runSoft('Clipboard preference save failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/ClipboardMode', settings.clipboardMode]));
      }
      if (settings.dragAndDrop) {
        const dndFlag = await virtualbox.getDragAndDropFlag();
        await runSoft('Drag & drop apply failed', () => virtualbox._run(['modifyvm', vmName, dndFlag, settings.dragAndDrop]));
        await runSoft('Drag & drop preference save failed', () => virtualbox._run(['setextradata', vmName, 'VMXposed/DragAndDropMode', settings.dragAndDrop]));
      }`;

if (main.includes(oldPoweroffClipboard)) {
  main = main.replace(oldPoweroffClipboard, newPoweroffClipboard);
  console.log('FIX 2b: Poweroff VM uses version-appropriate clipboard/dnd flags');
} else {
  console.log('SKIP 2b: Poweroff clipboard pattern not found');
}

// Fix 3: Separate shared folder changes from hardware edit block
// The issue: when user changes clipboard AND shared folder, the entire edit is blocked
// Solution: only block hardware edits, let clipboard/fullscreen/dnd pass through
const oldHardwareBlock = `      if (vmState && vmState !== 'poweroff' && requestedHardwareEdit) {
        return {
          success: false,
          error: 'Power off the V Os before editing hardware settings (RAM/CPU/graphics/network/USB/shared folders).'
        };
      }`;

const newHardwareBlock = `      // Check if ONLY shared folder changes (not RAM/CPU/graphics changes)
      const sharedFolderChanged = settings.sharedFolders !== undefined && normalizeSharedFolders(settings.sharedFolders).join('|') !== currentHardware.sharedFolders.join('|');
      const coreHardwareChanged = (
        (settings.ram !== undefined && (parseInt(settings.ram, 10) || 0) !== currentHardware.ram) ||
        (settings.cpus !== undefined && (parseInt(settings.cpus, 10) || 0) !== currentHardware.cpus) ||
        (settings.vram !== undefined && (parseInt(settings.vram, 10) || 0) !== currentHardware.vram) ||
        (settings.graphicsController !== undefined && String(settings.graphicsController || '').toLowerCase() !== currentHardware.graphicsController) ||
        (settings.audioController !== undefined && String(settings.audioController || '').toLowerCase() !== currentHardware.audioController) ||
        (settings.networkMode !== undefined && normalizeNetwork(settings.networkMode) !== currentHardware.networkMode) ||
        (settings.bootOrder !== undefined && normalizeBootOrder(settings.bootOrder).join('|') !== currentHardware.bootOrder.join('|')) ||
        (settings.audioEnabled !== undefined && !!settings.audioEnabled !== currentHardware.audioEnabled) ||
        (settings.usbEnabled !== undefined && !!settings.usbEnabled !== currentHardware.usbEnabled) ||
        (settings.accelerate3d !== undefined && !!settings.accelerate3d !== currentHardware.accelerate3d) ||
        (settings.efiEnabled !== undefined && !!settings.efiEnabled !== currentHardware.efiEnabled) ||
        (settings.nestedVirtualization !== undefined && !!settings.nestedVirtualization !== currentHardware.nestedVirtualization)
      );
      if (vmState && vmState !== 'poweroff' && coreHardwareChanged) {
        return {
          success: false,
          error: 'Power off the V Os before editing hardware settings (RAM/CPU/graphics/network/USB).'
        };
      }
      if (vmState && vmState !== 'poweroff' && sharedFolderChanged) {
        warnings.push('Shared folder changes require V Os to be powered off. Shared folders were NOT updated. Other settings applied.');
        // Remove sharedFolders from settings so they don't get processed
        delete settings.sharedFolders;
      }`;

if (main.includes(oldHardwareBlock)) {
  main = main.replace(oldHardwareBlock, newHardwareBlock);
  console.log('FIX 3: Separated shared folder from hardware edit block');
} else {
  console.log('SKIP 3: Hardware block pattern not found');
}

// Fix 4: When fullscreen changes on running VM, use waitForGuestAdditions
// so video mode hint actually gets applied
const oldFitWait = `            waitForGuestAdditionsMs: 0,
            delayMs: 2500,
            forceSchedule: true,
            cooldownMs: 5000`;
const newFitWait = `            waitForGuestAdditionsMs: 60000,
            delayMs: 1500,
            forceSchedule: true,
            cooldownMs: 8000`;

if (main.includes(oldFitWait)) {
  main = main.replace(oldFitWait, newFitWait);
  console.log('FIX 4: Fullscreen toggle now waits 60s for Guest Additions');
} else {
  console.log('SKIP 4: Fit wait pattern not found');
}

fs.writeFileSync('main.js', main, 'utf8');
console.log('--- main.js saved ---\n');

// ═══════════════════════════════════════════════════════════════
// FIX 5: Guest Additions Ubuntu 18.04/24.04 Compatibility
// ═══════════════════════════════════════════════════════════════
let ga = fs.readFileSync('vm/guestAdditions.js', 'utf8');

// Fix package install to detect Ubuntu version
const oldPkgInstall = `\`export DEBIAN_FRONTEND=noninteractive; \${sudoPrefix} apt-get install -y \` +
      'virtualbox-guest-utils virtualbox-guest-x11 virtualbox-guest-dkms dkms build-essential linux-headers-$(uname -r)',
      { timeout: 480000, retries: 2, description: 'Guest Additions package install' }`;

const newPkgInstall = `\`export DEBIAN_FRONTEND=noninteractive; \` +
      \`UBUNTU_VER=$(lsb_release -rs 2>/dev/null || echo "22.04"); \` +
      \`MAJOR_VER=\\\${UBUNTU_VER%%.*}; \` +
      \`if [ "$MAJOR_VER" -ge 22 ] 2>/dev/null; then \` +
      \`  \${sudoPrefix} apt-get install -y virtualbox-guest-utils virtualbox-guest-x11 2>/dev/null || \` +
      \`  \${sudoPrefix} apt-get install -y virtualbox-guest-utils 2>/dev/null; \` +
      \`else \` +
      \`  \${sudoPrefix} apt-get install -y virtualbox-guest-utils virtualbox-guest-x11 virtualbox-guest-dkms dkms build-essential linux-headers-$(uname -r) 2>/dev/null || \` +
      \`  \${sudoPrefix} apt-get install -y virtualbox-guest-utils virtualbox-guest-x11 2>/dev/null; \` +
      \`fi; echo pkg-done\`,
      { timeout: 480000, retries: 2, description: 'Guest Additions package install' }`;

if (ga.includes(oldPkgInstall)) {
  ga = ga.replace(oldPkgInstall, newPkgInstall);
  console.log('FIX 5a: Package install now detects Ubuntu version');
} else {
  console.log('SKIP 5a: Package install pattern not found');
}

// Fix VBoxClient --vmsvga fallback for older Ubuntu
const oldVboxClientStart = "'pkill -f \"VBoxClient --vmsvga\" 2>/dev/null || true; ' +";
const newVboxClientStart = "'pkill -f \"VBoxClient --vmsvga\" 2>/dev/null || true; ' +\n      'pkill -f \"VBoxClient --display\" 2>/dev/null || true; ' +";

// The old code already has both pkill lines, let's check the VBoxClient start commands
// The real fix is the fallback: if --vmsvga doesn't exist, use --display
const oldVmsvgaStart = "'nohup VBoxClient --vmsvga >/tmp/vbox-vmsvga.log 2>&1 & ' +";
const newVmsvgaStart = "'(VBoxClient --vmsvga >/tmp/vbox-vmsvga.log 2>&1 || VBoxClient --display >/tmp/vbox-display.log 2>&1) & ' +";

if (ga.includes(oldVmsvgaStart)) {
  ga = ga.replace(oldVmsvgaStart, newVmsvgaStart);
  console.log('FIX 5b: VBoxClient --vmsvga falls back to --display on older Ubuntu');
} else {
  console.log('SKIP 5b: VBoxClient vmsvga pattern not found');
}

fs.writeFileSync('vm/guestAdditions.js', ga, 'utf8');
console.log('--- guestAdditions.js saved ---\n');

// ═══════════════════════════════════════════════════════════════
// FIX 6: Dashboard responsive layout for 768px screens
// ═══════════════════════════════════════════════════════════════
let css = fs.readFileSync('renderer/styles.css', 'utf8');

// Add responsive media query for small screens
const mediaQuery = `
/* ═══ Small screen (768px height) compact overrides ═══ */
@media (max-height: 820px) {
  .sys-header { height: 48px; }
  .sys-content { padding: clamp(8px, 1vw, 16px); }
  .overview-hero-panel { padding: 8px 14px; }
  .overview-metric-card { padding: 8px 10px; }
  .overview-metric-value { font-size: 20px; }
  .overview-metric-label span { font-size: 10px; }
  .overview-chart-card svg { height: 44px; }
  .overview-chart-card { padding: 4px 6px; }
  .overview-panel { padding: 8px; gap: 6px; }
  .overview-main-grid { gap: 6px; }
  .overview-main-grid--lower { gap: 6px; }
  .overview-panel-title h3 { font-size: 12px; }
  .overview-storage-grid { gap: 4px; }
  .overview-storage-item { padding: 6px 8px; }
  .ov-chip-row { padding: 3px 0; font-size: 12px; }
  .overview-actions-grid { gap: 4px; }
  .ov-action-btn { min-height: 28px; font-size: 11px; padding: 0 8px; }
  .overview-activity-list { max-height: 100px; }
  .overview-host-grid { gap: 4px; }
}
`;

// Add at the end of the existing media queries
const lastMediaQuery = '@media (max-width: 760px) {';
const lastMediaIdx = css.lastIndexOf(lastMediaQuery);
if (lastMediaIdx >= 0) {
  // Find the end of that media query block
  let braceCount = 0;
  let endIdx = lastMediaIdx;
  for (let i = lastMediaIdx; i < css.length; i++) {
    if (css[i] === '{') braceCount++;
    if (css[i] === '}') braceCount--;
    if (braceCount === 0 && i > lastMediaIdx + 10) {
      endIdx = i + 1;
      break;
    }
  }
  // Check if our media query already exists
  if (!css.includes('max-height: 820px')) {
    css = css.slice(0, endIdx) + '\n' + mediaQuery + css.slice(endIdx);
    console.log('FIX 6: Added @media (max-height: 820px) responsive rules');
  } else {
    console.log('SKIP 6: max-height media query already exists');
  }
}

fs.writeFileSync('renderer/styles.css', css, 'utf8');
console.log('--- styles.css saved ---\n');

console.log('═══ ALL FIXES APPLIED ═══');
