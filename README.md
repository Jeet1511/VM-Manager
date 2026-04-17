# VM Xposed

VM Xposed is a desktop automation tool that helps users set up and configure virtual machines quickly with a guided UI.

## Highlights

- One-click VM setup workflow
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
- `vm/` — VM lifecycle helpers and post-install tooling
- `adapters/` — virtualization platform adapters
- `scripts/` — build helpers and utility scripts

## Download Installer (APK / Setup)

### Windows Setup Installer

[![Download Windows Installer](https://img.shields.io/badge/Download-Windows%20Installer-2ea44f?style=for-the-badge&logo=windows)](https://github.com/Jeet1511/VM-Manager/releases/latest/download/VM-Xposed-Setup.exe)

- Tap the button above to auto-download the latest Windows installer.

### Android APK Installer

[![Download Android APK](https://img.shields.io/badge/Download-Android%20APK-3DDC84?style=for-the-badge&logo=android&logoColor=white)](https://github.com/Jeet1511/VM-Manager/releases/latest/download/VM-Xposed-Android.apk)

- Tap the button above to auto-download the latest APK.
- If APK is not attached in the latest release, use the Windows installer button.

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

- Create a release per version tag (example: `v83`)
- Attach installer assets under the same tag

## License

MIT
