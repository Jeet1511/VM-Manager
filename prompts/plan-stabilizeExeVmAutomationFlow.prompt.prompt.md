## Plan: Stabilize EXE VM Automation Flow

Your issue is real and reproducible from the code paths. The main gaps are:
1. Legacy Ubuntu versions like 10.04/11.04 are manual-only in current architecture, so they cannot deliver true no-touch automation.
2. Manual-install completion is not reliably promoted to installed-disk state, so the VM can keep booting installer media.
3. Dashboard badges currently emphasize configured intent, which can look like everything is ON even when runtime guest readiness is missing.

Recommended direction for your goal (user does nothing after start): enforce automatic-capable OS profiles in installed .exe flow, and harden install-completion + status truthfulness.

**Steps**
1. Phase 1: Reproduce and instrument packaged-only path.
2. Add focused diagnostics in packaged startup/start-VM path to expose admin/elevation state, runtime integration attempts, and warning causes. Depends on nothing.
3. Add a packaged diagnostics view through existing permissions/report plumbing to show install markers and media/boot state per VM. Parallel with step 2.
4. Phase 2: Fix installer-loop and install-completion detection.
5. In VM start flow, when installed OS evidence is present, set installed-disk marker ON, switch boot order to disk-first, and eject ISO safely. Depends on step 2.
6. Update boot fixer so it does not force DVD-first for already-installed guests, and add a recovery action to mark install complete after verification. Depends on step 5.
7. Tighten stale setup-state recovery heuristics so old interrupted state cannot keep reattaching installer ISO after install is done. Depends on step 6.
8. Phase 3: Make UI status truthful.
9. Split dashboard indicators into configured host intent vs runtime guest verified state, so ON does not imply runtime-ready when GA/session is missing. Depends on step 2.
10. Upgrade Fix All feedback to show exact blockers (GA not ready, session not ready, Xorg/Wayland mismatch, credentials missing). Parallel with step 9.
11. Phase 4: Enforce zero-touch promise in installed .exe.
12. Block/redirect legacy manual-only Ubuntu selections in packaged automatic flow and recommend Ubuntu 20.04+ automatically. Depends on unattended metadata.
13. Add strict automatic-only guard in packaged review/submit path to prevent creating incompatible “partly automatic” VMs when no-touch expectation is active. Parallel with step 12.
14. Phase 5: Verification for .exe only.
15. Validate fresh Ubuntu 24.04 install, post-install reboot behavior, integration toggles, Fix All, and relaunch parity.
16. Validate negative path for Ubuntu 10.04/11.04 in packaged mode: clear block/guidance, no misleading automation claims.
17. Validate no regressions in start/stop/edit/boot-fix flows.

**Relevant files**
- [main.js](main.js) for vm:start logic, install markers, runtime integration, IPC responses.
- [vm/bootFixer.js](vm/bootFixer.js) for preboot recovery and DVD-first/ISO reattach behavior.
- [core/orchestrator.js](core/orchestrator.js) for setup state transitions and install completion semantics.
- [core/stateManager.js](core/stateManager.js) for persisted setup-state lifecycle.
- [renderer/components/dashboard.js](renderer/components/dashboard.js) for badge/status rendering and Fix All UX.
- [renderer/components/wizard-steps.js](renderer/components/wizard-steps.js) for automatic-only OS selection guardrails.
- [renderer/app.js](renderer/app.js) for packaged setup payload and automatic-install requirement.
- [services/osCatalogUpdater.js](services/osCatalogUpdater.js) for unattended support rules by Ubuntu version.

**Verification**
1. Build/install .exe and run automatic setup with Ubuntu 24.04. Confirm reboot does not return to “Try Ubuntu / Install Ubuntu”.
2. Confirm dashboard status differentiates configured vs runtime verified states.
3. Toggle clipboard/drag-drop/display-fit during runtime and verify applied/deferred behavior messaging is accurate.
4. Simulate stale interrupted setup-state and verify no incorrect ISO reattach/DVD-first behavior post-install.
5. Confirm legacy Ubuntu selection behavior is blocked/guided in packaged automatic flow.

**Decisions**
- Included: installed .exe behavior only, installer-loop fixes, truthful runtime status, and zero-touch guardrails.
- Excluded: full no-touch automation for Ubuntu 10.04/11.04, since unattended automation is unsupported there in current VirtualBox-based approach.

Plan is saved in session memory at /memories/session/plan.md and ready for implementation handoff.