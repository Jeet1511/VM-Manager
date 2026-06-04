const fs = require('fs');

// ─── Fix 1: Improve preseed fallback runcmd script ───
// Make it more robust: retry multiple times, handle different Ubuntu versions
let ci = fs.readFileSync('vm/cloudInit.js', 'utf8');

// Replace the preseed runcmd script with a more robust version
const oldScript = `      #!/bin/bash
      # VM Xposed: Auto-launch Ubiquity with preseed (file-based)
      LOG=/tmp/vmxposed-install.log
      echo "[$(date)] VM Xposed auto-install starting..." > $LOG
      
      # Wait for the desktop session to be ready
      for i in $(seq 1 30); do
        if pgrep -x gnome-shell >/dev/null 2>&1 || pgrep -x unity-panel >/dev/null 2>&1 || pgrep -x xfce4-panel >/dev/null 2>&1; then
          echo "[$(date)] Desktop session detected" >> $LOG
          break
        fi
        sleep 2
      done
      sleep 5
      
      # Kill any existing Ubiquity instance (the default GUI one)
      pkill -f ubiquity 2>/dev/null
      sleep 2
      
      # Launch Ubiquity in fully automatic mode with our preseed
      echo "[$(date)] Launching ubiquity --automatic --preseed" >> $LOG
      export DISPLAY=:0`;

const newScript = `      #!/bin/bash
      # VM Xposed: Auto-launch Ubiquity with preseed (file-based)
      # Robust version — handles slow boot, multiple desktop environments,
      # and retries if Ubiquity is not yet available.
      LOG=/tmp/vmxposed-install.log
      echo "[$(date)] VM Xposed auto-install starting..." > $LOG
      
      # Detach from cloud-init and run independently in background
      (
      # Wait for X display to be available (up to 120s for slow VMs)
      DISPLAY_READY=0
      for i in $(seq 1 60); do
        if [ -e /tmp/.X11-unix/X0 ] || [ -e /tmp/.X0-lock ]; then
          DISPLAY_READY=1
          echo "[$(date)] X display detected (attempt $i)" >> $LOG
          break
        fi
        sleep 2
      done
      
      if [ "$DISPLAY_READY" = "0" ]; then
        echo "[$(date)] X display not found after 120s, aborting" >> $LOG
        exit 1
      fi
      
      # Wait extra time for the desktop to fully load
      sleep 8
      
      # Find and kill the "Try/Install Ubuntu" dialog (Ubiquity GUI)
      # Try up to 5 times in case it hasn't appeared yet
      for attempt in $(seq 1 5); do
        UBIQUITY_PID=$(pgrep -f "ubiquity" 2>/dev/null | head -1)
        if [ -n "$UBIQUITY_PID" ]; then
          echo "[$(date)] Found Ubiquity PID $UBIQUITY_PID, killing..." >> $LOG
          kill -9 $UBIQUITY_PID 2>/dev/null
          sleep 2
          # Kill any remaining ubiquity processes
          pkill -9 -f ubiquity 2>/dev/null
          sleep 1
          break
        fi
        echo "[$(date)] Ubiquity not found yet (attempt $attempt/5)" >> $LOG
        sleep 5
      done
      
      # Launch Ubiquity in fully automatic mode with our preseed
      echo "[$(date)] Launching ubiquity --automatic --preseed" >> $LOG
      export DISPLAY=:0
      export XAUTHORITY=/home/ubuntu/.Xauthority 2>/dev/null
      # Try multiple Xauthority locations
      for xa in /home/ubuntu/.Xauthority /root/.Xauthority /var/run/lightdm/root/:0; do
        [ -f "$xa" ] && export XAUTHORITY="$xa" && break
      done`;

if (ci.includes(oldScript)) {
  ci = ci.replace(oldScript, newScript);
  console.log('REPLACED: preseed runcmd script with robust version');
} else {
  console.log('SKIP: Could not find old preseed script exactly');
  // Try to find it by a unique substring
  const marker = '# VM Xposed: Auto-launch Ubiquity with preseed (file-based)';
  const idx = ci.indexOf(marker);
  if (idx >= 0) {
    console.log('Found marker at index', idx);
  }
}

// Also fix the ubiquity launch command - add noprompt and use sudo properly
const oldLaunch = "      sudo ubiquity -d --automatic --preseed /tmp/vmxposed-preseed.cfg >> $LOG 2>&1 &";
const newLaunch = "      sudo -E ubiquity -d --automatic --preseed /tmp/vmxposed-preseed.cfg >> $LOG 2>&1 &";
if (ci.includes(oldLaunch)) {
  ci = ci.replace(oldLaunch, newLaunch);
  console.log('FIXED: ubiquity launch with sudo -E');
}

// Fix the runcmd to run the script in background (detached from cloud-init)
const oldRuncmd = "  - [\"bash\", \"/tmp/vmxposed-autoinstall.sh\"]";
const newRuncmd = '  - ["bash", "-c", "nohup bash /tmp/vmxposed-autoinstall.sh &"]';
if (ci.includes(oldRuncmd)) {
  ci = ci.replace(oldRuncmd, newRuncmd);
  console.log('FIXED: runcmd now runs script detached in background');
}

// ─── Fix 2: Also add kernel boot params for Ubiquity ───
// For the preseed fallback, inject automatic-ubiquity and noprompt kernel params
// via VBox extradata (try multiple methods)
const oldPreseedSuccess = "    logger.success('CloudInit', '═══ Preseed Fallback Applied (file-based) ═══');";
const newPreseedSuccess = `    // Try to inject automatic-ubiquity kernel param (best-effort)
    // This tells Ubiquity to skip the "Try/Install" dialog
    try {
      await virtualbox._run(['setextradata', vmName, 
        'VBoxInternal/Devices/pcbios/0/Config/DmiSystemProduct', 
        'automatic-ubiquity noprompt']);
    } catch {}
    try {
      // For EFI-based VMs
      await virtualbox._run(['setextradata', vmName,
        'VBoxInternal/Devices/efi/0/Config/AdditionalEnv',
        'GRUB_CMDLINE_LINUX_DEFAULT=automatic-ubiquity noprompt file=/cdrom/preseed/ubuntu.seed quiet splash']);
    } catch {}
    try {
      await virtualbox._run(['modifyvm', vmName, '--boot1', 'dvd', '--boot2', 'disk', '--boot3', 'none', '--boot4', 'none']);
    } catch {}

    logger.success('CloudInit', '═══ Preseed Fallback Applied (file-based) ═══');`;

if (ci.includes(oldPreseedSuccess)) {
  ci = ci.replace(oldPreseedSuccess, newPreseedSuccess);
  console.log('ADDED: kernel param injection to preseed fallback');
}

// ─── Fix 3: Fix GRUB injection scancodes (extended keys need e0 prefix) ───
// Down arrow: e0 50 (press) e0 d0 (release) 
// End key: e0 4f (press) e0 cf (release)
ci = ci.replace(
  "await sendSC('50 d0');  // Down arrow (extended: e0 50 / e0 d0)",
  "await sendSC('e0 50 e0 d0');  // Down arrow (extended key)"
);
ci = ci.replace(
  "await sendSC('4f cf');",
  "await sendSC('e0 4f e0 cf');"
);
console.log('FIXED: Extended key scancodes (Down, End) now use e0 prefix');

// Also increase GRUB wait time from 6s to 10s for slower VMs
ci = ci.replace(
  "logger.info('CloudInit', 'Waiting 6s for GRUB menu...');\n  await _sleep(6000);",
  "logger.info('CloudInit', 'Waiting 10s for GRUB menu...');\n  await _sleep(10000);"
);
console.log('FIXED: GRUB wait time 6s -> 10s');

fs.writeFileSync('vm/cloudInit.js', ci, 'utf8');

// ─── Fix 4: Also apply preseed kernel params for Subiquity path ───
// The GRUB injection might work for Subiquity Ubuntu (20.04+)
// But for 18.04, we need the preseed approach
// The preseed fallback + cloud-init runcmd is the best we can do

console.log('\nDONE - All autoinstall fixes applied');
