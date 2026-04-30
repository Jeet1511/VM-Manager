/**
 * scripts/generate-manifest.js
 * 
 * Generate Windows manifest file for UAC elevation.
 * This is required for proper admin privilege handling.
 */

const fs = require('fs');
const path = require('path');

module.exports = async function generateManifest(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const manifestContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity
    version="1.0.0.0"
    processorArchitecture="amd64"
    name="VM.Xposed"
    type="win32"
  />
  <description>VM Xposed - One-click cross-platform VM setup automation</description>

  <trustInfo xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <security>
      <requestedPrivileges>
        <!-- This makes Windows show UAC prompt, but doesn't auto-elevate -->
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>

  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <!-- Windows 7 and above -->
      <supportedOS Id="{35138b9a-5d96-4fbd-af16-fa5a60d29f08}"/>
      <!-- Windows Vista -->
      <supportedOS Id="{e2011457-1546-43c5-a5fe-008deee3d3f0}"/>
      <!-- Windows 10 and above -->
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
      <!-- Windows 11 and above -->
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/>
    </application>
  </compatibility>

  <asmv3:application xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
    <asmv3:windowsSettings xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">
      <dpiAware>true</dpiAware>
    </asmv3:windowsSettings>
  </asmv3:application>
</assembly>`;

  console.log('Generated Windows manifest for UAC support');
  return manifestContent;
};
