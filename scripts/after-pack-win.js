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

  await rcedit(exePath, {
    icon: iconPath,
    'file-version': packageJson.version,
    'product-version': packageJson.version,
    'version-string': {
      CompanyName: 'Dev: Jeet',
      FileDescription: packageJson.description || productName,
      ProductName: productName,
      InternalName: packageJson.name,
      OriginalFilename: path.basename(exePath),
      LegalCopyright: '© Jeet',
    },
  });

  console.log(`Patched app executable metadata before installer build: ${exePath}`);
};
