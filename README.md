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

## Download Installer (APK / Setup)

### Windows Setup Installer

- Download from GitHub Releases asset: `VM-Xposed-Setup-<version>.exe`
- Install by running the `.exe` on Windows

### Android APK Installer

- Download from GitHub Releases asset: `VM-Xposed-Android-v83.apk`
- If APK is not attached in the release yet, use the latest Windows installer above

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
