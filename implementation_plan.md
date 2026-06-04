# Fix: Ubuntu 18.04 Installer Showing After Download

## Problem

When downloading Ubuntu 18.04, VM Xposed shows the Ubiquity installer GUI (keyboard layout, etc.) instead of a ready-to-use OS. The user has to manually complete the installer — **this should never happen**.

## Root Cause Analysis

The installation flow has 3 automation tiers:

| Tier | Method | Ubuntu 20.04+ | Ubuntu 18.04 | Status |
|---|---|---|---|---|
| 1 | `VBoxManage unattended install` | ✅ Works | ❌ Fails | Error caught too broadly |
| 2 | Cloud-init ISO (autoinstall) | ✅ Works | ❌ N/A (Subiquity only) | Working |
| 3 | Preseed ISO | N/A | ❌ Attached but ignored | **Broken** — needs boot params |

**Why Tier 1 fails for 18.04:** The `_isConstructMediaError()` function matches `msg.includes('unattended')` and `msg.includes('vboxmanage')` — this catches **ALL VBox errors**, even fixable ones. So the real VBox unattended error is never surfaced.

**Why Tier 3 doesn't work:** The preseed.cfg gets placed on a separate ISO but the Ubiquity installer **doesn't know to use it**. The preseed needs to be injected via kernel boot parameters (`preseed/file=...` or `auto=true`). Currently, the `install.sh` script that launches `ubiquity --automatic --preseed` was designed to be run via **keyboard automation** (typing it into a terminal), which we removed.

## Proposed Changes

### Fix 1: Make VBox Unattended Actually Work for 18.04

#### [MODIFY] [vmManager.js](file:///c:/Users/Jeet/Documents/Github/VM-Manager/vm/vmManager.js)

- **Tighten `_isConstructMediaError()`** — Remove the overly broad `msg.includes('unattended')` and `msg.includes('vboxmanage')` patterns. Only catch actual media construction failures.
- This will allow VBox's own preseed injection to work (it modifies boot parameters internally).

#### [MODIFY] [virtualbox.js](file:///c:/Users/Jeet/Documents/Github/VM-Manager/adapters/virtualbox.js)

- Add `--start-vm=none` to the `unattended install` command — this tells VBox to set up the automation config WITHOUT starting the VM (we start it ourselves later).
- Add `--time-zone` parameter for proper timezone config.

---

### Fix 2: Preseed Boot Injection for Genuine VBox Failures

For cases where VBox unattended genuinely can't work (corrupt ISO, unknown OS type, etc.):

#### [MODIFY] [cloudInit.js](file:///c:/Users/Jeet/Documents/Github/VM-Manager/vm/cloudInit.js)

- **New approach: Create a preseed floppy image** that VBox boots from
- The floppy contains an `isolinux.cfg` / grub entry that passes preseed kernel parameters to the Ubuntu ISO boot
- VBox extradata `VBoxInternal/Devices/pcbios/0/Config/DmiBIOSFWMajor` won't work — instead use VBox's "floppy" boot with a preseed kickstart

Actually, the most reliable approach for Ubiquity is:

**Approach A: Use a preseed late_command autoexec** — Modify the preseed to auto-execute during the Ubiquity live session by placing it in casper's autorun scripts

**Approach B (Recommended): Auto-launch ubiquity via a custom autostart .desktop file on the preseed ISO**:
1. Create the preseed ISO with:
   - `preseed.cfg` (full preseed config)
   - An autostart `.desktop` file that auto-mounts and runs `ubiquity --automatic --preseed`
2. Boot from the Ubuntu ISO normally
3. The live session's desktop auto-starts and finds our `.desktop` file
4. Ubiquity launches with `--automatic --preseed` pointing to our preseed.cfg

Wait — the autostart approach won't work because the preseed ISO isn't in the right location for desktop autostart.

**Approach C (Most Reliable): Create a "cidata" ISO that Ubuntu's Casper live system recognizes**:
The Casper live system in Ubuntu 18.04 supports `preseed/file=` if it's passed as a kernel parameter. We can't easily modify kernel parameters, but we CAN:

1. Create a small script that auto-runs when the desktop loads
2. Place it at a well-known location that Casper checks

**Actually the best approach is Approach D:**

**Approach D: Use VBox extradata to inject kernel boot parameters**:
```
VBoxManage setextradata vmName "VBoxInternal/Devices/pcnet/0/LUN#0/Config/BootFile" ...
```
This doesn't work for kernel params.

**Approach E (Final, most practical):**

The preseed ISO already has `install.sh` that runs `ubiquity --automatic --preseed`. The problem is nobody runs it. We need to make it **auto-execute** when the Ubuntu live desktop starts.

Solution: Create an **autorun mechanism** using Casper's autostart:
1. Place an autostart `.desktop` file at `/etc/xdg/autostart/` inside the preseed ISO — won't work, different filesystem
2. Use VBox's `VBoxManage guestproperty set` to trigger a script — doesn't work before GA are installed

**The ACTUAL reliable solution**: Since the preseed ISO is attached as a second CD-ROM, we can make it auto-execute by:
1. Making the preseed ISO also contain a `udev` rule or `systemd` service that auto-mounts and auto-runs
2. Actually, in the Casper live session, the user's desktop starts and `/etc/xdg/autostart/*.desktop` files auto-run

Wait — the preseed ISO is separate from the Ubuntu ISO. The autostart files on the preseed ISO won't be in `/etc/xdg/autostart/`.

**The simplest fix:** Keep keyboard automation as the LAST resort for Ubuntu 18.04 (the user said "extreme exceptional cases"). Ubuntu 18.04 IS an extreme exceptional case — it's the only version where no file-based method works for the desktop ISO.

BUT FIRST: Let's make VBox's own unattended install work (Fix 1). It should handle 18.04 properly if we don't swallow the error.

---

### Fix 3: Clean Up Dead Code

#### [MODIFY] [cloudInit.js](file:///c:/Users/Jeet/Documents/Github/VM-Manager/vm/cloudInit.js)

- Keep `sendAutomatedInstallKeystrokes` but only as an **extreme fallback** for pre-20.04 Ubuntu where VBox unattended genuinely fails
- Add clear logging: "Using keyboard automation as last resort for legacy Ubuntu"

## Verification Plan

1. Run `node --check` on all modified files
2. Run `check-syntax.js` 
3. Test with Ubuntu 18.04 Desktop ISO — should install without showing installer GUI

> [!IMPORTANT]
> The key fix is **Fix 1**: tightening `_isConstructMediaError()` so VBox's own unattended install (which handles preseed injection + boot parameter modification internally) actually works for Ubuntu 18.04.
