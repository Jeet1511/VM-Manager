# VM Xposed

VM Xposed is a desktop automation tool that helps users set up and configure virtual OSes quickly with a guided UI.

## Highlights

- One-click V Os setup workflow
- Guided wizard for OS image selection and provisioning
- Download and checksum utilities
- Guest additions and shared-folder setup helpers
- Electron-based desktop app for Windows

## Tech Stack

- Electron
- Node.js
- Vanilla JS (renderer + service modules)

## Architecture

The app is split across Electron's two process boundaries with a layered design:

```
  Renderer (UI)              preload.js              Main Process
┌─────────────────┐     ┌────────────────┐     ┌──────────────────────┐
│  index.html     │     │  contextBridge │     │  main.js             │
│  app.js         │◄───►│  IPC bridge    │◄───►│    ├── core/         │
│  components/*   │     │  (typed API)   │     │    ├── services/     │
│  styles.css     │     └────────────────┘     │    ├── adapters/     │
└─────────────────┘                            │    └── vm/           │
                                               └──────────────────────┘
```

| Layer | Folder | Role |
|-------|--------|------|
| **Entry** | `main.js`, `preload.js` | App lifecycle, window, IPC bridge |
| **Core** | `core/` | Orchestrator, config, state, logger, admin elevation |
| **Services** | `services/` | Downloads, checksum, OS catalog updater, system checks |
| **Adapters** | `adapters/` | VirtualBox CLI wrapper, platform detection |
| **VM** | `vm/` | VM creation, cloud-init, boot fixer, guest additions, shared folders |
| **Renderer** | `renderer/` | Single-page UI: dashboard, wizard, settings, components |
| **Scripts** | `scripts/` | Build helpers, icon generation, post-pack hooks |

> **📖 Full architecture docs:** See [`ARCHITECTURE.md`](ARCHITECTURE.md) for detailed module breakdowns, data flow diagrams, the complete IPC contract, and design decisions.

## Download Installer (APK / Setup)

Public update source is now repository folders:
- `Installer/` for setup `.exe` files
- `Patch notes/` for text patch notes

### Windows Setup Installer

[![Download Latest Installer](https://img.shields.io/badge/⬇_Download-Latest_Windows_Setup-2ea44f?style=for-the-badge&logo=windows)](https://github.com/Jeet1511/VM-Manager/raw/main/Installer/VM-Xposed-Setup.exe)

> **Current Version: v1.1.31** — Click the badge above to download.

- `VM-Xposed-Setup.exe` is always the latest build — automatically updated with every release.
- All versioned installers are available in the [📁 Installer folder](https://github.com/Jeet1511/VM-Manager/tree/main/Installer).

### Android APK Installer

[![Download Android APK](https://img.shields.io/badge/Download-Android%20APK-3DDC84?style=for-the-badge&logo=android&logoColor=white)](https://github.com/Jeet1511/VM-Manager/releases)

- Opens the Releases page. Download works only after a release is published with APK assets.
- If no assets are listed, build locally using the steps below.

## Local Development

```bash
npm install
npm run dev
```

## Build for Distribution

```bash
npm run build:win
```

Output installer is generated in `dist/`.

### Windows Trust / SmartScreen

- Unsigned `.exe` files are commonly flagged by SmartScreen/AV.
- For trusted production builds, sign the app with an Authenticode certificate:
  - `CSC_LINK` = certificate file/path or base64 content
  - `CSC_KEY_PASSWORD` = certificate password
- Build command stays the same (`npm run build:win`); electron-builder signs automatically when these env vars are present.

## Release Notes Convention

- Upload installer files to `Installer/` using this format:
  - `VM-Xposed-Setup-vX.Y.Z.exe`
- Upload patch notes to `Patch notes/` using this format:
  - `patch-vX.Y.Z.txt` (or `.md`)
- Keep installer and patch note versions matched (same `X.Y.Z`).
- VM Xposed Update section auto-detects the newest installer in `Installer/` and picks the best matching patch notes.
- VM Xposed also loads full patch history from `Patch notes/` so users can browse previous updates.

## License

MIT
