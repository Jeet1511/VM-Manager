const fs = require('node:fs');
const path = require('node:path');
const rcedit = require('rcedit');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const packageJson = context.packager.appInfo.info;
  const productName = context.packager.appInfo.productName;
  const executableName = `${productName}.exe`;
  const exePath = path.join(context.appOutDir, executableName);
  const iconPath = path.join(context.packager.projectDir, 'logos', 'icon-app.ico');

  if (!fs.existsSync(exePath)) {
    throw new Error(`Executable not found for metadata patch: ${exePath}`);
  }

  // Generate Windows manifest for proper UAC handling and OS compatibility
  const manifestContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity
    version="${packageJson.version || '1.0.0'}.0"
    processorArchitecture="amd64"
    name="VM.Xposed"
    type="win32"
  />
  <description>${packageJson.description || productName}</description>

  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <!-- asInvoker: App runs at user level, requests elevation via PowerShell when needed -->
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>

  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <!-- Windows Vista -->
      <supportedOS Id="{e2011457-1546-43c5-a5fe-008deee3d3f0}"/>
      <!-- Windows 7 -->
      <supportedOS Id="{35138b9a-5d96-4fbd-af16-fa5a60d29f08}"/>
      <!-- Windows 8 -->
      <supportedOS Id="{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}"/>
      <!-- Windows 8.1 -->
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/>
      <!-- Windows 10 / 11 -->
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>

  <asmv3:application xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
    <asmv3:windowsSettings xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">
      <dpiAware>true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </asmv3:windowsSettings>
  </asmv3:application>
</assembly>`;

  // Write manifest to temp file for rcedit
  const manifestPath = path.join(context.appOutDir, 'vm-xposed.manifest');
  fs.writeFileSync(manifestPath, manifestContent, 'utf8');

  try {
    await rcedit(exePath, {
      icon: iconPath,
      'application-manifest': manifestPath,
      'file-version': packageJson.version,
      'product-version': packageJson.version,
      'version-string': {
        CompanyName: 'Jeet',
        FileDescription: packageJson.description || productName,
        ProductName: productName,
        InternalName: packageJson.name,
        OriginalFilename: path.basename(exePath),
        LegalCopyright: '\u00A9 Jeet',
      },
    });

    console.log(`Patched app executable with metadata + manifest: ${exePath}`);
  } finally {
    // Clean up temp manifest file
    try {
      fs.unlinkSync(manifestPath);
    } catch {}
  }
};
