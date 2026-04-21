#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const filesToCheck = [
  'main.js',
  'renderer/app.js',
  'renderer/components/dashboard.js',
  'renderer/components/wizard-steps.js',
  'core/orchestrator.js',
  'vm/vmManager.js',
  'vm/guestAdditions.js',
  'adapters/virtualbox.js',
  'vm/bootFixer.js',
  'renderer/components/progress-panel.js'
];

let hasErrors = false;

filesToCheck.forEach(file => {
  const filePath = path.join(__dirname, file);
  
  try {
    if (!fs.existsSync(filePath)) {
      console.log(`❌ FILE NOT FOUND: ${file}`);
      hasErrors = true;
      return;
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Try to compile the file using Node's parser
    try {
      new Function(content);
      console.log(`✓ ${file} - OK`);
    } catch (syntaxErr) {
      console.log(`❌ SYNTAX ERROR in ${file}:`);
      console.log(`   ${syntaxErr.message}`);
      hasErrors = true;
    }
  } catch (err) {
    console.log(`❌ ERROR reading ${file}: ${err.message}`);
    hasErrors = true;
  }
});

process.exit(hasErrors ? 1 : 0);
