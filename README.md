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

## Project Structure

- `main.js`, `preload.js` — Electron entry and preload bridge
- `renderer/` — UI, components, and styles
- `core/` — orchestration, config, state, logging
- `services/` — downloader, checksum, OS catalog, system checks
- `vm/` — V Os lifecycle helpers and post-install tooling
- `adapters/` — virtualization platform adapters
- `scripts/` — build helpers and utility scripts

## Download Installer (APK / Setup)

Public update source is now repository folders:
- `Installer/` for setup `.exe` files
- `Patch notes/` for text patch notes

### Windows Setup Installer

[![Open Installer Folder](https://img.shields.io/badge/Download-Windows%20Installer-2ea44f?style=for-the-badge&logo=windows)](https://github.com/Jeet1511/VM-Manager/tree/main/Installer)

- Open the folder and download the latest installer file.

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

## Release Notes Convention

- Upload installer files to `Installer/` using this format:
  - `VM-Xposed-Setup-vX.Y.Z.exe`
- Upload patch notes to `Patch notes/` using this format:
  - `patch-vX.Y.Z.txt` (or `.md`)
- Keep installer and patch note versions matched (same `X.Y.Z`).
- VM Xposed Update section auto-detects the highest version and shows matching patch notes.
- VM Xposed also loads full patch history from `Patch notes/` so users can browse previous updates.

## License

MIT
