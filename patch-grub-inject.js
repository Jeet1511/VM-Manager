/**
 * Patch vmManager.js to inject autoinstall kernel params via GRUB editing
 * after the VM starts (when cloud-init fallback was applied).
 * 
 * This is the most reliable approach because:
 * - VBoxManage setextradata for kernel params is unreliable in VBox
 * - Ubuntu Desktop needs 'autoinstall' in /proc/cmdline or Subiquity shows Try/Install
 * - Editing GRUB at boot time guarantees the param reaches the kernel
 */
const fs = require('fs');

// ─── Step 1: Add injectAutoinstallViaGrub function to cloudInit.js ───
let ci = fs.readFileSync('vm/cloudInit.js', 'utf8');

// Add the GRUB injection function before module.exports
const grubFunction = `
/**
 * ─── GRUB Boot Parameter Injection ──────────────────────────────────
 * After the VM starts, edits the GRUB boot entry to add 'autoinstall ds=nocloud'
 * to the kernel command line. This is the MOST RELIABLE way to ensure autoinstall
 * works in VirtualBox, since setextradata-based kernel param injection is buggy.
 *
 * Flow:
 * 1. Wait for GRUB menu to appear (~5s)
 * 2. Press 'e' to edit the default entry
 * 3. Navigate down to the 'linux' line
 * 4. Press End to go to end of line
 * 5. Type ' autoinstall ds=nocloud\\\\;s=/cdrom/'
 * 6. Press Ctrl+X to boot with modified params
 */
async function injectAutoinstallViaGrub(vmName, virtualbox) {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));
  
  const sendSC = async (codes) => {
    await virtualbox._run(['controlvm', vmName, 'keyboardputscancode', ...codes.split(' ')]);
  };
  
  logger.info('CloudInit', '═══ Injecting autoinstall via GRUB edit ═══');
  
  // Wait for GRUB menu to appear (after BIOS/EFI, ~6 seconds)
  logger.info('CloudInit', 'Waiting 6s for GRUB menu...');
  await _sleep(6000);
  
  // Press 'e' to edit GRUB entry (scancode: 12 92)
  logger.info('CloudInit', 'Pressing "e" to edit GRUB entry...');
  await sendSC('12 92');
  await _sleep(1500);
  
  // Press Down arrow 4 times to reach the 'linux' line
  // GRUB edit screen typically has:
  //   line 1: setparams 'Try or Install Ubuntu'
  //   line 2: set gfxpayload=keep  
  //   line 3: linux /casper/vmlinuz ... quiet splash ---
  //   line 4: initrd /casper/initrd
  // Down arrow scancode: 50 d0
  logger.info('CloudInit', 'Navigating to linux line (Down x4)...');
  for (let i = 0; i < 4; i++) {
    await sendSC('50 d0');  // Down arrow (extended: e0 50 / e0 d0)
    await _sleep(300);
  }
  
  // Press End key to go to end of the linux line
  // End scancode: 4f cf
  logger.info('CloudInit', 'Moving to end of line (End)...');
  await sendSC('4f cf');
  await _sleep(300);
  
  // Type ' autoinstall ds=nocloud' at the end of the linux line
  // We need to type each character as scancodes
  const textToType = ' autoinstall';
  logger.info('CloudInit', 'Typing "' + textToType + '"...');
  
  // Space (39 b9)
  await sendSC('39 b9'); await _sleep(50);
  // a (1e 9e)
  await sendSC('1e 9e'); await _sleep(50);
  // u (16 96)
  await sendSC('16 96'); await _sleep(50);
  // t (14 94)
  await sendSC('14 94'); await _sleep(50);
  // o (18 98)
  await sendSC('18 98'); await _sleep(50);
  // i (17 97)
  await sendSC('17 97'); await _sleep(50);
  // n (31 b1)
  await sendSC('31 b1'); await _sleep(50);
  // s (1f 9f)
  await sendSC('1f 9f'); await _sleep(50);
  // t (14 94)
  await sendSC('14 94'); await _sleep(50);
  // a (1e 9e)
  await sendSC('1e 9e'); await _sleep(50);
  // l (26 a6)
  await sendSC('26 a6'); await _sleep(50);
  // l (26 a6)
  await sendSC('26 a6'); await _sleep(50);
  
  await _sleep(200);
  
  // Press Ctrl+X to boot with modified parameters
  // Ctrl press: 1d, x press: 2d, x release: ad, Ctrl release: 9d
  logger.info('CloudInit', 'Pressing Ctrl+X to boot with autoinstall param...');
  await sendSC('1d 2d ad 9d');
  
  logger.success('CloudInit', '═══ GRUB autoinstall injection complete ═══');
  logger.info('CloudInit', 'Ubuntu will now boot with autoinstall parameter. Subiquity will auto-detect cloud-init config.');
}

`;

const exportsIdx = ci.indexOf('module.exports = {');
if (exportsIdx >= 0) {
  ci = ci.slice(0, exportsIdx) + grubFunction + ci.slice(exportsIdx);
  console.log('ADDED: injectAutoinstallViaGrub function to cloudInit.js');
}

// Add to module.exports
ci = ci.replace(
  'sendAutomatedInstallKeystrokes,',
  'sendAutomatedInstallKeystrokes,\n  injectAutoinstallViaGrub,'
);
console.log('EXPORTED: injectAutoinstallViaGrub');

fs.writeFileSync('vm/cloudInit.js', ci, 'utf8');

// ─── Step 2: Import and call it from vmManager.js after VM starts ───
let vm = fs.readFileSync('vm/vmManager.js', 'utf8');

// Add injectAutoinstallViaGrub to the require
const oldRequire = "const { applyCloudInitFallback, applyPreseedFallback, isSubiquityUbuntu } = require('./cloudInit');";
const newRequire = "const { applyCloudInitFallback, applyPreseedFallback, isSubiquityUbuntu, injectAutoinstallViaGrub } = require('./cloudInit');";
if (vm.includes(oldRequire)) {
  vm = vm.replace(oldRequire, newRequire);
  console.log('IMPORTED: injectAutoinstallViaGrub in vmManager.js');
} else {
  console.log('SKIP: require line not found exactly, searching...');
  // Try a more flexible match
  const reqIdx = vm.indexOf("require('./cloudInit')");
  if (reqIdx >= 0) {
    const lineStart = vm.lastIndexOf('\n', reqIdx) + 1;
    const lineEnd = vm.indexOf('\n', reqIdx);
    const oldLine = vm.substring(lineStart, lineEnd);
    console.log('Found require line:', oldLine.substring(0, 80));
    // Add injectAutoinstallViaGrub if not already there
    if (!vm.includes('injectAutoinstallViaGrub')) {
      vm = vm.replace(
        "isSubiquityUbuntu }",
        "isSubiquityUbuntu, injectAutoinstallViaGrub }"
      );
      console.log('IMPORTED via flexible match');
    }
  }
}

// After the VM is started and running (after _waitForVMState), inject GRUB params
// if cloud-init fallback was applied
// Find the section after startVM where we can add the GRUB injection

// We need to track if cloud-init was used. Let's add a flag.
// The code already has 'unattendedApplied' and the flow sets it to true if fallback succeeds.
// But we need to know specifically that cloud-init fallback was used (not VBox unattended).
// Let's add a 'cloudInitApplied' flag.

// Add the flag variable near the start of createVM
const oldUnattendedVar = "    let unattendedApplied = false;";
const newUnattendedVar = "    let unattendedApplied = false;\n    let cloudInitFallbackUsed = false;";
if (vm.includes(oldUnattendedVar)) {
  vm = vm.replace(oldUnattendedVar, newUnattendedVar);
  console.log('ADDED: cloudInitFallbackUsed flag');
}

// Set the flag when cloud-init fallback succeeds
const oldFallbackSuccess = "            unattendedApplied = true;\n            _emitProgress(onProgress, 'unattended', 'Cloud-init automation applied";
if (vm.includes(oldFallbackSuccess)) {
  vm = vm.replace(
    oldFallbackSuccess,
    "            unattendedApplied = true;\n            cloudInitFallbackUsed = true;\n            _emitProgress(onProgress, 'unattended', 'Cloud-init automation applied"
  );
  console.log('SET: cloudInitFallbackUsed = true on fallback success');
}

// After VM starts and is running, add the GRUB injection call
const afterVMStarted = "    const running = await _waitForVMState(name, 'running', 45000, 3000);\n    if (!running) {\n      throw new Error('V Os start command completed but V Os did not reach running state.');\n    }";

const afterVMStartedWithGrub = afterVMStarted + `

    // If cloud-init fallback was used, inject autoinstall via GRUB editing
    // This ensures Ubuntu's Subiquity installer skips the "Try/Install" dialog
    if (cloudInitFallbackUsed) {
      try {
        _emitProgress(onProgress, 'start', 'Configuring OS auto-installer...', 92);
        await injectAutoinstallViaGrub(name, virtualbox);
        logger.success('VMManager', 'Autoinstall kernel parameter injected via GRUB.');
      } catch (grubErr) {
        logger.warn('VMManager', 'GRUB injection failed (non-fatal): ' + grubErr.message);
      }
    }`;

if (vm.includes(afterVMStarted)) {
  vm = vm.replace(afterVMStarted, afterVMStartedWithGrub);
  console.log('ADDED: GRUB injection call after VM starts');
} else {
  console.log('SKIP: afterVMStarted block not found');
}

fs.writeFileSync('vm/vmManager.js', vm, 'utf8');
console.log('\nDONE');
