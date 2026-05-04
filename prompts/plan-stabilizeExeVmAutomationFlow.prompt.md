## Plan: Stabilize EXE VM Automation Flow (Hardened + Deterministic)

Your issue is real and reproducible from the code paths. The main gaps are:

1. Legacy Ubuntu versions like 10.04/11.04 are manual-only in current architecture, so they cannot deliver true no-touch automation.
2. Manual-install completion is not reliably promoted to installed-disk state, so the VM can keep booting installer media.
3. Dashboard badges currently emphasize configured intent, which can look like everything is ON even when runtime guest readiness is missing.
4. State and boot decisions are currently fragmented across multiple modules, leading to conflicting behavior and installer loops.

Recommended direction for your goal (user does nothing after start): enforce automatic-capable OS profiles in installed .exe flow, introduce a single source of truth for VM state, and make install/boot decisions deterministic and verifiable.

---

## Core Architecture Upgrades (New)

### 1. Unified VM State Model (Single Source of Truth)

All modules must read from a single VM state object. Only orchestrator writes.

```js
vm.state = {
  phase: "preinstall | installing | postinstall | ready | degraded",
  installConfirmed: false,
  bootSource: "iso | disk",
  isoAttached: true,
  guestReady: false,
  integrationReady: {
    ga: false,
    clipboard: false,
    display: false
  },
  lastError: null,
  rebootCount: 0
}
```

This removes ambiguity between setup-state, install markers, and runtime checks.

---

### 2. Deterministic Install Completion (No Guessing)

Install is considered complete only if at least TWO signals are present:

* Bootable disk evidence (GRUB/EFI present)
* AND one of:

  * Guest agent reachable
  * First-boot marker file exists (e.g. `/var/lib/vm_installed.flag`)

No marker = not installed.

---

### 3. Central Boot Decision Engine

Replace scattered boot logic with a single authority:

```js
decideBoot(vmState) => {
  return {
    bootOrder,
    attachISO,
    ejectISO
  }
}
```

Rules:

* installing → DVD first
* postinstall → disk first + eject ISO
* ready → disk only
* inconsistent → recovery mode

All modules must use this. No exceptions.

---

### 4. Idempotent Operations

All critical actions must be safe to re-run:

* ISO eject
* install marker set
* integration enable
* boot order update

No operation should fail if already applied.

---

### 5. Timeouts and Watchdogs

Add hard limits:

* Install timeout (20–30 min)
* Guest agent startup timeout (60 sec)
* Boot loop detector:

```js
if (rebootCount > 3 && bootSource === "iso") {
  forceDiskBoot()
}
```

Prevents infinite installer loops.

---

### 6. State Validation + Auto-Recovery

On VM start:

* Compare actual VM state vs stored state
* If mismatch:

  * Auto-heal (preferred)
  * Or enter recovery mode

Example:
state says installed but ISO attached → auto eject + disk boot

---

### 7. Zero-Touch Contract (Explicit Enforcement)

Define zero-touch as:

* No manual input
* Auto install completes
* Auto reboot to OS
* Integrations applied
* VM usable after launch

If any condition fails → surface failure, not partial success.

---

### 8. Packaged vs Dev Mode Parity Layer

```js
env.mode = "dev" | "packaged"
```

Packaged mode:

* stricter validation
* enforced automation-only flows
* extended diagnostics

---

## Steps

### Phase 1: Reproduce and Instrument Packaged Path

1. Reproduce issue in packaged .exe only.
2. Add diagnostics in vm:start:

   * elevation/admin state
   * ISO attachment
   * boot order
   * GA/session attempts
3. Add diagnostics UI panel:

   * install phase
   * boot source
   * ISO status
   * guest readiness
   * last error

---

### Phase 2: Fix Installer Loop + Install Completion

4. Implement deterministic install detection (dual-signal + marker file).
5. Update VM start flow:

   * if installConfirmed → set disk-first, eject ISO
6. Replace bootFixer logic with central boot decision engine.
7. Add stale-state recovery:

   * prevent ISO reattach after install
   * correct invalid boot orders automatically

---

### Phase 3: Truthful UI State

8. Split dashboard into:

   * configured intent
   * runtime verified state
9. Upgrade Fix All:

   * show exact blockers:

     * GA not running
     * session unavailable
     * display server mismatch
     * credentials missing

---

### Phase 4: Enforce Zero-Touch in Packaged Flow

10. Block legacy Ubuntu (10.04/11.04) in automatic mode.
11. Auto-suggest Ubuntu 20.04+.
12. Add strict guard in wizard:

* prevent creation of partially-automatic VMs

13. Fail fast if unattended install is not supported.

---

### Phase 5: Stability Hardening

14. Add watchdogs (timeouts + reboot tracking).
15. Ensure all operations are idempotent.
16. Add startup state validation + auto-recovery.
17. Log structured events:

* INSTALL_CONFIRMED
* ISO_EJECTED
* BOOT_SWITCHED_TO_DISK
* GA_READY / GA_TIMEOUT

---

### Phase 6: Verification (.exe Only)

18. Validate Ubuntu 24.04:

* full auto install
* reboot lands on disk (not ISO)
* integrations applied

19. Validate restart parity.
20. Validate stale-state recovery scenarios.
21. Validate negative path for Ubuntu 10.04/11.04:

* clear block
* no misleading automation

22. Validate no regressions across:

* start/stop
* edit
* boot recovery

---

## Relevant Files

* main.js → vm:start, install detection, runtime integration
* vm/bootFixer.js → replaced by boot decision engine
* core/orchestrator.js → state authority, install lifecycle
* core/stateManager.js → persisted VM state
* renderer/components/dashboard.js → status + diagnostics UI
* renderer/components/wizard-steps.js → OS guardrails
* renderer/app.js → packaged setup enforcement
* services/osCatalogUpdater.js → unattended support rules

---

## Verification Checklist

* No installer loop after successful install
* ISO always ejected post-install
* Dashboard reflects real runtime state
* Fix All shows actionable blockers
* Unsupported OS versions blocked cleanly
* System recovers automatically from stale/corrupt state

---

## Decisions

* Included: deterministic state model, boot authority, install verification, watchdogs, truthful UI, zero-touch enforcement
* Excluded: full automation for Ubuntu 10.04/11.04 (unsupported by current VirtualBox unattended flow)

---

Plan replaces previous version and is ready for implementation handoff.

---

## Continuation: Implementation Breakdown (Actionable)

### Milestone A: State Authority Foundations

23. Introduce a new VM state contract module under core that defines schema, defaults, validation, and migration from existing markers.
24. Make orchestrator the only writer for state transitions; all other modules become readers plus action executors.
25. Add strict transition rules:

* preinstall -> installing
* installing -> postinstall
* postinstall -> ready
* any -> degraded on hard failure

26. Add validation guards that reject illegal transitions and emit structured errors.

Deliverables:

* Shared state schema and helper utilities
* Transition function with tests
* Backward compatibility mapping from existing extradata + setup-state.json

---

### Milestone B: Boot Decision Engine

27. Add a single decideBoot(vmState, liveVmFacts) function and route all boot-related decisions through it.
28. Remove direct boot-order decisions from vm:start and bootFixer; replace with one call to decision engine.
29. Implement recovery outputs:

* forceDiskBoot
* preserveIsoForInstall
* ejectIsoAfterConfirm

30. Add idempotent wrappers for boot order updates and ISO attach/eject.

Deliverables:

* Deterministic decision matrix
* One-call boot action application
* No duplicate boot logic in multiple files

---

### Milestone C: Deterministic Install Confirmation

31. Add dual-signal install confirmation function with explicit evidence object:

* diskEvidence
* guestAgentReachable
* markerFilePresent

32. Write first-boot marker in unattended flow and verify it before promoting state to postinstall/ready.
33. For manual installs, promote only after verified signals pass; never from timing assumptions.
34. Persist evidence summary to state and structured logs.

Deliverables:

* confirmInstall() utility
* Evidence logs per VM start
* Promotion only on verified signals

---

### Milestone D: UI Truthfulness + Diagnostics

35. Refactor dashboard cards to show two columns:

* Configured (host intent)
* Verified (runtime)

36. Add diagnostics drawer per VM showing:

* phase
* installConfirmed
* bootSource
* isoAttached
* guestReady
* lastError

37. Upgrade Fix All output into categorized blockers:

* Credentials
* Guest Additions
* Session/Display server
* Shared folder mapping

Deliverables:

* Runtime-accurate status display
* Actionable blocker messaging
* Support-friendly diagnostics view

---

### Milestone E: Packaged Enforcement Layer

38. Gate packaged flow with automatic-only guardrails by default.
39. If selected profile is manual-only, block creation and auto-suggest nearest supported Ubuntu LTS entry.
40. Add explicit contract banner in review step:

* Zero-touch guaranteed
* Zero-touch unavailable (blocked)

41. Add fail-fast check before setup:start dispatch so invalid flows never reach backend.

Deliverables:

* Consistent packaged-only policy
* Clear user-facing expectation management
* No silent partial automation

---

### Milestone F: Watchdogs + Recovery Hardening

42. Add install and guest startup watchdogs with explicit timeout events.
43. Implement reboot loop protection and force-disk fallback after threshold.
44. Add startup reconciliation routine:

* compare persisted state vs live VM facts
* auto-heal mismatches
* mark degraded only when auto-heal fails

45. Add stale setup-state neutralization rules so old data cannot override confirmed install facts.

Deliverables:

* Loop prevention
* Self-healing on startup
* Robust stale-state handling

---

## PR Strategy (Recommended)

PR 1: State schema + transition authority

* files: core/orchestrator.js, core/stateManager.js, new core vm-state module

PR 2: Boot decision engine + idempotent boot actions

* files: main.js, vm/bootFixer.js, adapter helpers

PR 3: Deterministic install confirmation + marker/evidence

* files: main.js, core/orchestrator.js, vm/guestAdditions.js

PR 4: Dashboard truthful status + diagnostics drawer + Fix All blocker taxonomy

* files: renderer/components/dashboard.js, renderer/app.js

PR 5: Packaged enforcement and wizard guardrails

* files: renderer/components/wizard-steps.js, renderer/app.js, services/osCatalogUpdater.js

PR 6: Watchdogs, startup reconciliation, structured event logging

* files: main.js, core/orchestrator.js, vm/bootFixer.js

---

## Acceptance Gates

Gate 1: Installer Loop Elimination

* 5 consecutive cold starts on a completed Ubuntu 24.04 VM never land on installer screen.

Gate 2: Status Accuracy

* Dashboard runtime verified column matches live VM facts for GA, clipboard, display, shared folder.

Gate 3: Zero-Touch Contract

* Packaged wizard blocks unsupported automatic profiles and never reports partial setup as complete.

Gate 4: Recovery Reliability

* Corrupted/stale setup-state scenario auto-recovers without reattaching ISO after confirmed install.

Gate 5: Regression Safety

* Existing start/stop/edit/boot-fix behaviors pass smoke tests.

---

## Rollback Plan

If a hardened change introduces startup regressions:

1. Keep new state read-path active but feature-flag decision engine writes.
2. Fallback to previous boot behavior behind one guarded switch.
3. Preserve structured logs to compare old vs new decisions.
4. Re-enable hardened path incrementally after fix.

---

## Immediate Next Action

Begin with PR 1 and PR 2 only, then run packaged .exe validation before touching UI. This isolates core correctness first and avoids masking logic issues behind frontend changes.
