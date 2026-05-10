# VM Xposed — Architecture Guide

> **Last updated:** v1.1.31  
> This document describes the internal architecture of the VM Xposed desktop application.

---

## Table of Contents

1. [High-Level Overview](#high-level-overview)
2. [Folder Structure](#folder-structure)
3. [Layer Breakdown](#layer-breakdown)
   - [Entry Layer](#1-entry-layer)
   - [Adapters](#2-adapters)
   - [Core](#3-core)
   - [Services](#4-services)
   - [VM Layer](#5-vm-layer)
   - [Renderer (UI)](#6-renderer-ui)
4. [Data Flow](#data-flow)
5. [IPC Contract](#ipc-contract)
6. [Build & Packaging](#build--packaging)
7. [Key Design Decisions](#key-design-decisions)

---

## High-Level Overview

VM Xposed is an **Electron** desktop application that automates the creation, configuration, and management of virtual machines through VirtualBox. The app follows a layered architecture split across Electron's two process boundaries:

```
┌──────────────────────────────────────────────────────────┐
│                    Renderer Process                      │
│                                                          │
│   index.html ← styles.css ← app.js ← components/*.js    │
│                        │                                 │
│                   window.vmInstaller                     │
│                   (IPC bridge API)                        │
└──────────────────────┬───────────────────────────────────┘
                       │  contextBridge (preload.js)
                       │  ipcRenderer.invoke / .on
                       ▼
┌──────────────────────────────────────────────────────────┐
│                     Main Process                         │
│                                                          │
│   main.js                                                │
│     ├── createWindow()        App lifecycle & window     │
│     ├── registerIPC()         IPC handler registration   │
│     ├── Helper functions      Business logic & utils     │
│     │                                                    │
│     ├── core/                 Orchestration & infra      │
│     ├── services/             Downloads, checks, catalog │
│     ├── adapters/             VirtualBox CLI bridge      │
│     └── vm/                   VM lifecycle operations    │
└──────────────────────────────────────────────────────────┘
```

**Key principle:** The renderer has **zero** direct Node.js access. All system operations go through the IPC bridge exposed via `preload.js` using Electron's `contextBridge`.

---

## Folder Structure

```
VM-Manager/
│
├── main.js                     # Electron main process entry point
├── preload.js                  # Secure IPC bridge (contextBridge)
├── package.json                # App config, scripts, build settings
├── check-syntax.js             # Dev utility — syntax validation
│
├── adapters/                   # External system adapters
│   ├── platform.js             #   OS platform detection & utilities
│   └── virtualbox.js           #   VBoxManage CLI wrapper
│
├── core/                       # Application infrastructure
│   ├── admin-elevate.js        #   Windows UAC elevation logic
│   ├── config.js               #   OS catalog, VM defaults, paths
│   ├── logger.js               #   File + event logging system
│   ├── orchestrator.js         #   Multi-phase setup workflow engine
│   ├── production-utils.js     #   ASAR-safe path resolution & security
│   ├── stateManager.js         #   Persistent setup state (resume/retry)
│   └── vm-state.js             #   VM install state machine
│
├── services/                   # Reusable service modules
│   ├── checksum.js             #   SHA256 file verification
│   ├── downloadManager.js      #   HTTP download with resume & progress
│   ├── osCatalogUpdater.js     #   Live OS catalog refresh from Ubuntu archives
│   └── systemChecker.js        #   Host hardware/software validation
│
├── vm/                         # Virtual machine operations
│   ├── accountManager.js       #   Guest OS user account CRUD
│   ├── bootFixer.js            #   Boot order repair & ISO management
│   ├── cloudInit.js            #   Cloud-init / autoinstall generation
│   ├── guestAdditions.js       #   VBox Guest Additions configuration
│   ├── sharedFolder.js         #   Host↔Guest shared folder setup
│   └── vmManager.js            #   VM creation, hardware config
│
├── renderer/                   # Frontend (renderer process)
│   ├── index.html              #   Single-page app shell
│   ├── styles.css              #   Global styles & design system
│   ├── vm-xposed.css           #   Dashboard-specific styles
│   ├── app.js                  #   Application controller & routing
│   ├── assets/                 #   Logos, brand images
│   │   ├── vm-xposed-logo.png
│   │   └── vm-xposed-mark.png
│   └── components/             #   UI components
│       ├── icons.js            #     SVG icon library
│       ├── dashboard.js        #     Dashboard view renderer
│       ├── wizard-steps.js     #     Setup wizard step definitions
│       └── progress-panel.js   #     Setup progress display
│
├── scripts/                    # Build & development scripts
│   ├── after-pack-win.js       #   Post-build hook for Windows
│   ├── generate-icons.js       #   Icon generation from source images
│   ├── generate-manifest.js    #   Windows manifest generation
│   ├── fix-dash.js             #   Dashboard fix utilities
│   ├── make_dash.js            #   Dashboard builder
│   ├── run-fix.js              #   General fix runner
│   └── write-css.js            #   CSS generation utility
│
├── logos/                      # App icons (ICO, PNG)
├── Installer/                  # Published release installers
├── Patch notes/                # Per-version release notes
└── dist/                       # Build output (gitignored)
```

---

## Layer Breakdown

### 1. Entry Layer

| File | Role |
|------|------|
| **`main.js`** | Electron main process. Creates the browser window, registers all IPC handlers, manages app lifecycle (quit, single-instance lock, VM shutdown on exit), and contains business logic for catalog caching, system scanning, VM operations, update checking, and admin elevation. |
| **`preload.js`** | Secure bridge between renderer and main process. Uses `contextBridge.exposeInMainWorld()` to expose the `window.vmInstaller` API. The renderer can **only** call methods defined here — no direct `require()` or Node.js access. |

#### main.js Internal Structure

The main process file is structured in these logical sections (top to bottom):

| Section | Line Range (approx.) | Purpose |
|---------|----------------------|---------|
| Imports & globals | 1–53 | Electron APIs, module requires, runtime state maps |
| Catalog management | 55–155 | OS catalog cache read/write/normalize |
| UI preferences | 156–260 | User preferences persistence |
| Path validation | 260–475 | Setup path normalization, Windows path safety |
| Logger & maintenance | 477–510 | Log level apply, log retention pruning |
| System scanning | 510–800 | Host partition scan, VM path detection, full system scan |
| App icon & branding | 800–850 | Icon resolution with fallback SVG |
| Update system | 850–1245 | GitHub API, version compare, installer download |
| VM state helpers | 1245–1550 | Boot decision, display fit, runtime integration |
| VM delete & cleanup | 1550–1730 | Safe VM deletion with artifact cleanup |
| VM folder resolution | 1730–1910 | `.vbox` file scanning, VM import |
| Catalog refresh | 1910–1930 | Background catalog refresh scheduling |
| Admin & permissions | 1980–2400 | UAC, driver probing, kernel device checks |
| Host recovery | 2400–2700 | Guided host-fix actions |
| Realtime metrics | 2700–3000 | Live CPU/RAM/disk/network monitoring |
| VM storage analysis | 3000–3380 | Per-VM disk usage collection |
| Window creation | 3381–3421 | `BrowserWindow` setup, menu, load HTML |
| App menu | 3425–3580 | Native menu bar (File, Permissions, Help) |
| IPC registration | 3582–5617 | All `ipcMain.handle()` registrations |
| App lifecycle | 5619–5710 | Single instance, `app.whenReady()`, quit hooks |

---

### 2. Adapters

Adapters abstract **external systems** so the rest of the app never calls CLI tools directly.

#### `adapters/virtualbox.js`
- Wraps all `VBoxManage` CLI commands behind async functions
- Handles path discovery (env vars, registry, common paths)
- Provides: `init()`, `isInstalled()`, `getVersion()`, `createVM()`, `startVM()`, `stopVM()`, `getVMInfo()`, `getVMState()`, `configureVM()`, `configureDisplayHints()`, `applyRuntimeIntegration()`, `ejectInstallerIso()`, `attachInstallerIso()`, etc.
- All output is parsed and returned as structured JavaScript objects

#### `adapters/platform.js`
- Platform detection (Windows, macOS, Linux)
- CPU architecture, feature detection
- OS-specific path conventions

---

### 3. Core

Core modules provide **application infrastructure** that other layers depend on.

#### `core/config.js` — Central Configuration
- **`OS_CATALOG`** — Master registry of all supported operating systems (Ubuntu, Debian, Fedora, Mint, Arch, Kali, RHEL-based, FreeBSD, Windows, Custom)
- Each entry defines: `category`, `osType`, `filename`, `downloadUrl`, `sha256Url`, `unattended`, `defaultUser/Pass`, hardware defaults (`ram`, `cpus`, `disk`, `vram`), `graphicsController`, and `notes`
- **`VM_DEFAULTS`** — Default VM hardware configuration
- **`VIRTUALBOX_DOWNLOADS`** — VirtualBox installer download URL patterns
- Helper functions: `getDefaultInstallPath()`, `getDownloadDir()`, `getOSCategories()`, `findOS()`

#### `core/orchestrator.js` — Setup Workflow Engine
- Extends `EventEmitter` — emits `phase`, `progress`, `log`, `error`, `complete` events
- Runs the full setup pipeline in sequence:
  ```
  SYSTEM_CHECK → DOWNLOAD_VBOX → INSTALL_VBOX → DOWNLOAD_ISO →
  VERIFY_ISO → CREATE_VM → INSTALL_OS → WAIT_BOOT → GUEST_CONFIG → COMPLETE
  ```
- Supports **pause**, **cancel**, and **resume** (via stateManager)
- Multi-source download with automatic mirror fallback
- Handles both unattended and manual install paths

#### `core/stateManager.js` — Setup State Persistence
- Saves setup progress to disk so interrupted installs can resume
- Tracks completed phases and artifacts (ISO path, VM creation status)
- Provides: `createNewState()`, `loadState()`, `completePhase()`, `skipPhase()`, `clearState()`, `determineResumePoint()`

#### `core/vm-state.js` — VM Install State Machine
- Determines what boot action to take based on VM's current install evidence
- States: `fresh`, `installing`, `installed`, `guest-ready`
- Functions: `createVmState()`, `buildInstallEvidence()`, `decideBoot()`

#### `core/logger.js` — Logging System
- Writes timestamped logs to file and emits events for UI consumption
- Levels: `debug`, `info`, `warn`, `error`, `success`
- Auto-creates log directory, supports configurable minimum level

#### `core/production-utils.js` — Production Path Safety
- Resolves paths correctly in both development and ASAR-packaged production builds
- Security utilities: path traversal prevention, URL validation, filename sanitization
- VirtualBox path discovery for Windows
- Asset path resolution: `getRendererHtmlPath()`, `getPreloadScriptPath()`, `getAppIconPath()`

#### `core/admin-elevate.js` — Windows Admin Elevation
- UAC elevation via Windows manifest and `ShellExecuteW`
- Detects if currently running as administrator
- Can relaunch the app with elevated privileges

---

### 4. Services

Reusable services that perform **specific tasks** for any caller.

| Module | Purpose |
|--------|---------|
| `services/downloadManager.js` | HTTP/HTTPS file download with progress reporting, resume support, speed calculation |
| `services/checksum.js` | SHA256 hash computation with progress callback; SHA256SUMS file parsing |
| `services/systemChecker.js` | Host validation: RAM, disk space, CPU count, 64-bit, virtualization, VirtualBox presence |
| `services/osCatalogUpdater.js` | Scrapes Ubuntu release archives to discover new ISO versions; merges into runtime catalog |

---

### 5. VM Layer

Modules that perform **VM-specific operations** using the VirtualBox adapter.

| Module | Purpose |
|--------|---------|
| `vm/vmManager.js` | Creates and fully configures a new VM (hardware, storage, network, display, boot order, unattended install) |
| `vm/cloudInit.js` | Generates cloud-init `user-data` / `meta-data` and autoinstall configs for Ubuntu unattended installs |
| `vm/bootFixer.js` | Diagnoses and repairs boot issues (stuck on ISO, wrong boot order); manages boot state transitions |
| `vm/guestAdditions.js` | Configures Guest Additions features: clipboard, drag-and-drop, display resolution, 3D acceleration |
| `vm/sharedFolder.js` | Sets up VirtualBox shared folders between host and guest |
| `vm/accountManager.js` | Manages guest OS user accounts: list, create, update, delete, auto-login |

---

### 6. Renderer (UI)

The renderer is a **single-page application** built with vanilla JavaScript, loaded from `renderer/index.html`.

#### Page Architecture

```
index.html
  ├── styles.css              Global design system
  ├── components/icons.js     SVG icon library (Icons.*)
  ├── components/dashboard.js Dashboard view (Dashboard.*)
  ├── components/wizard-steps.js  Wizard step renderers (WizardSteps.*)
  ├── components/progress-panel.js  Setup progress UI (ProgressPanel.*)
  └── app.js                  App controller, routing, state management
```

#### View System

`app.js` manages a client-side router with these views:

| View ID | Nav Label | Description |
|---------|-----------|-------------|
| `dashboard` | Dashboard | System overview, quick actions, realtime metrics |
| `machines` | V Os | List, start, stop, edit, delete virtual machines |
| `wizard` | Create V Os | Multi-step setup wizard (OS select → ISO → config → review) |
| `library` | OS Library | Browse and search the OS catalog |
| `snapshots` | Snapshots | Create, restore, delete VM snapshots |
| `storage` | Storage | Disk usage analysis per VM and partition |
| `network` | Network | Network adapter configuration |
| `download` | Updates | Check for app updates, view patch history |
| `settings` | Settings | User preferences, paths, credentials, security |
| `credits` | Credits | Attribution and version info |

#### UI Communication

All data flows through the `window.vmInstaller` API exposed by `preload.js`:

- **Request/Response** — `window.vmInstaller.methodName()` → `ipcRenderer.invoke()` → `ipcMain.handle()` → return value
- **Event Streaming** — `window.vmInstaller.onProgress(callback)` → `ipcRenderer.on()` ← `mainWindow.webContents.send()`

---

## Data Flow

### Setup Workflow (Create V Os)

```
User clicks "Start"
       │
       ▼
  app.js (renderer)
  └── window.vmInstaller.startSetup(config)
       │
       ▼  ipcRenderer.invoke('setup:start')
  main.js (main process)
  ├── normalizeSetupConfig()     Validate & resolve paths
  ├── orchestrator.runSetup()    Kick off workflow
  │   ├── Phase 1: systemChecker.runSystemCheck()
  │   ├── Phase 2-3: orchestrator.ensureVirtualBoxInstalled()
  │   │   └── downloadManager.downloadFile() + platform install
  │   ├── Phase 4: downloadManager.downloadFile()  (ISO)
  │   ├── Phase 5: checksum.computeSHA256()
  │   ├── Phase 6: vmManager.createAndConfigureVM()
  │   │   ├── virtualbox.createVM() + configureVM()
  │   │   ├── cloudInit.generate()  (if Ubuntu)
  │   │   └── virtualbox.attachInstallerIso()
  │   ├── Phase 7: virtualbox.startVM()
  │   ├── Phase 8: Wait for OS boot
  │   └── Phase 9: guestAdditions + sharedFolder
  │
  │   Events emitted during each phase:
  │   ├── 'phase'    → UI updates phase status indicators
  │   ├── 'progress' → UI updates progress bar & messages
  │   ├── 'log'      → UI shows log entries
  │   └── 'error'    → UI shows error with recovery options
  │
  └── return result
       │
       ▼  ipcRenderer.on('setup:complete')
  app.js (renderer)
  └── Show completion screen with VM details
```

### VM Lifecycle

```
  renderer                    main.js                     adapters/virtualbox.js
     │                           │                               │
     ├── vm:list ───────────────►├── virtualbox._run(['list'])──►│── VBoxManage list vms
     │◄── [{name, state}] ──────┤◄── parse output ──────────────┤
     │                           │                               │
     ├── vm:start ──────────────►├── pre-boot checks ───────────►│
     │                           ├── decideBoot() → boot order   │
     │                           ├── virtualbox.startVM() ──────►│── VBoxManage startvm
     │                           ├── configureDisplayFit() ─────►│── VBoxManage controlvm
     │◄── {success} ────────────┤                               │
     │                           │                               │
     ├── vm:stop ───────────────►├── virtualbox.stopVM() ───────►│── VBoxManage controlvm
     │◄── {success} ────────────┤                               │
```

---

## IPC Contract

The `preload.js` file defines the complete IPC API. Here is every channel grouped by domain:

### Configuration
| Method | Channel | Direction |
|--------|---------|-----------|
| `getDefaults()` | `config:getDefaults` | Request → Response |
| `getUiPrefs()` | `config:getUiPrefs` | Request → Response |
| `saveUiPrefs(prefs)` | `config:saveUiPrefs` | Request → Response |
| `getAppVersion()` | `app:getVersion` | Request → Response |

### System & Permissions
| Method | Channel | Direction |
|--------|---------|-----------|
| `checkSystem(path)` | `system:check` | Request → Response |
| `fullSystemScan()` | `system:fullScan` | Request → Response |
| `getRealtimeMetrics()` | `system:getRealtimeMetrics` | Request → Response |
| `checkPermissions()` | `permissions:check` | Request → Response |
| `isAdmin()` | `permissions:isAdmin` | Request → Response |
| `restartAsAdmin()` | `permissions:restartAsAdmin` | Request → Response |
| `fixDriver()` | `permissions:fixDriver` | Request → Response |

### VirtualBox
| Method | Channel | Direction |
|--------|---------|-----------|
| `detectVBox()` | `vbox:detect` | Request → Response |
| `ensureVBoxInstalled(opts)` | `vbox:ensureInstalled` | Request → Response |
| `pauseVBoxDownload()` | `vbox:pauseDownload` | Request → Response |
| `cancelVBoxDownload()` | `vbox:cancelDownload` | Request → Response |

### Setup Workflow
| Method | Channel | Direction |
|--------|---------|-----------|
| `startSetup(config)` | `setup:start` | Request → Response |
| `pauseSetup()` | `setup:pause` | Request → Response |
| `cancelSetup()` | `setup:cancel` | Request → Response |
| `getPhases()` | `setup:getPhases` | Request → Response |
| `checkForResume()` | `setup:checkResume` | Request → Response |
| `clearSavedState()` | `setup:clearState` | Request → Response |

### VM Management
| Method | Channel | Direction |
|--------|---------|-----------|
| `listVMs()` | `vm:list` | Request → Response |
| `startVM(name)` | `vm:start` | Request → Response |
| `stopVM(name)` | `vm:stop` | Request → Response |
| `pauseVM(name)` | `vm:pause` | Request → Response |
| `resumeVM(name)` | `vm:resume` | Request → Response |
| `deleteVM(name)` | `vm:delete` | Request → Response |
| `editVM(name, settings)` | `vm:edit` | Request → Response |
| `getVMDetails(name)` | `vm:getDetails` | Request → Response |
| `renameVM(old, new)` | `vm:rename` | Request → Response |
| `cloneVM(source, target)` | `vm:clone` | Request → Response |
| `listSnapshots(name)` | `vm:snapshots:list` | Request → Response |
| `createSnapshot(vm, snap)` | `vm:snapshots:create` | Request → Response |
| `restoreSnapshot(vm, ref)` | `vm:snapshots:restore` | Request → Response |
| `deleteSnapshot(vm, ref)` | `vm:snapshots:delete` | Request → Response |

### Event Streams (Main → Renderer)
| Listener | Channel | Direction |
|----------|---------|-----------|
| `onPhase(cb)` | `setup:phase` | Event stream |
| `onProgress(cb)` | `setup:progress` | Event stream |
| `onLog(cb)` | `setup:log` | Event stream |
| `onError(cb)` | `setup:error` | Event stream |
| `onComplete(cb)` | `setup:complete` | Event stream |
| `onVBoxEnsureProgress(cb)` | `vbox:ensureProgress` | Event stream |

---

## Build & Packaging

### Development
```bash
npm install          # Install dependencies
npm run dev          # Launch with DevTools (--dev flag)
npm start            # Launch production mode locally
```

### Production Build
```bash
npm run build:win    # Windows NSIS installer (.exe)
npm run build:portable  # Windows portable (.exe)
npm run build:all    # Both installer + portable
```

### Build Pipeline
1. `npm run prepare:icons` — generates ICO files from PNG sources
2. `electron-builder` packages the app:
   - Source files are bundled into an **ASAR archive**
   - `preload.js`, `renderer/**`, `logos/**` are **unpacked** from ASAR (required for file:// access)
   - The same files are also copied to `extraResources/` for production path resolution
3. Output goes to `dist/`

### Production Path Resolution
In production, files inside the ASAR archive have different paths than development. `core/production-utils.js` handles this transparently:

| Context | Path strategy |
|---------|--------------|
| Development | `__dirname` relative paths |
| Production (ASAR) | `process.resourcesPath` + extraResources |
| Preload script | Must be outside ASAR for security |
| Renderer HTML | Loaded via extraResources path |

---

## Key Design Decisions

### 1. Monolithic Main Process
The `main.js` file (~5,700 lines) consolidates all main-process logic in a single file. This was a deliberate choice for:
- **Simplicity** — One file to search/debug, no circular dependency issues
- **Electron IPC locality** — All `ipcMain.handle()` registrations are co-located with their handler logic
- **Tradeoff** — Harder to navigate; compensated by clear section headers and consistent naming

### 2. No Frontend Framework
The renderer uses **vanilla JavaScript** instead of React/Vue/Svelte because:
- Minimizes bundle size and dependency footprint
- No build step required for the frontend
- Electron's sandboxed renderer restricts what frameworks can do anyway
- The app has ~10 views — manageable without a framework

### 3. Context Isolation
The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. All main-process access goes through the typed `preload.js` API. This prevents:
- Renderer-side `require()` of Node.js modules
- Direct filesystem or process access from the UI
- XSS escalation to system-level access

### 4. Multi-Source Download with Fallback
ISO downloads try the primary URL first, then automatically fail over to mirror URLs. Ubuntu versions have 3 built-in fallback sources (releases.ubuntu.com, old-releases.ubuntu.com, mirrors.edge.kernel.org).

### 5. Resumable Setup Workflow
The orchestrator persists phase completion to disk via `stateManager`. If the app crashes or the user quits mid-setup, the next launch detects the incomplete state and offers to resume from the last completed phase.

### 6. Cloud-Init for Unattended Install
For Ubuntu VMs, the app generates `cloud-init` configuration files (`user-data`, `meta-data`) that automate the entire OS installation — no user interaction required inside the VM window.

### 7. Pre-Boot State Machine
Before starting a VM, the app inspects install evidence (disk content, reboot count, guest markers) to decide whether to boot from DVD or disk, and whether to eject the installer ISO. This prevents common issues like getting stuck in an install loop.
