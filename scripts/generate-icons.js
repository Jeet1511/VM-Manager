const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const pngToIco = require('png-to-ico');
const sharp = require('sharp');

async function ensureIcon(inputName, outputName) {
  const inputPath = path.join(__dirname, '..', 'logos', inputName);
  const outputPath = path.join(__dirname, '..', 'logos', outputName);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Missing logo file: ${inputPath}`);
  }

  const tempPngPath = path.join(os.tmpdir(), `vmxposed-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);

  await sharp(inputPath)
    .resize(1024, 1024, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(tempPngPath);

  const icoBuffer = await pngToIco(tempPngPath);
  fs.writeFileSync(outputPath, icoBuffer);
  fs.unlinkSync(tempPngPath);
  console.log(`Created icon: ${outputPath}`);
}

async function run() {
  await ensureIcon('inside app logo.png', 'icon-app.ico');
  await ensureIcon('outside app logo.png', 'icon-installer.ico');
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
