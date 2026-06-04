const fs = require('fs');
const lines = fs.readFileSync('vm/cloudInit.js', 'utf8').split('\n');
console.log('Total lines:', lines.length);

// Find and show the corrupted line
for (let i = 295; i < 305; i++) {
  const hex = Buffer.from(lines[i]).toString('hex').substring(0, 60);
  console.log(`L${i+1}: [${lines[i].substring(0, 60)}] hex=${hex}`);
}

// The corrupted line 298 (index 297) and the duplicate lines after it need to go
// Find the first backtick-semicolon that's the proper end of the template (line 297 ends with vboxvideo)
// Then everything from 298 to the next `; is duplicate

// Strategy: find index of the corrupted line and remove from there to the duplicate `;
let cutStart = -1;
let cutEnd = -1;
for (let i = 296; i < lines.length; i++) {
  const line = lines[i].trim();
  // Find the corrupted line (contains garbage after backtick+semicolon)
  if (cutStart === -1 && i >= 297 && (line.includes('`;') && line.length > 3)) {
    cutStart = i;
    console.log(`Cut start at L${i+1}: ${lines[i].substring(0, 40)}`);
  }
  // Find the next proper `; closing
  if (cutStart >= 0 && i > cutStart && line === '`;') {
    cutEnd = i + 1; // inclusive
    console.log(`Cut end at L${i+1}`);
    break;
  }
}

if (cutStart >= 0 && cutEnd > cutStart) {
  // Replace the corrupted line with just `; and remove duplicates
  lines[cutStart] = '`;';
  // Remove lines cutStart+1 to cutEnd-1
  lines.splice(cutStart + 1, cutEnd - cutStart - 1);
  console.log(`Removed ${cutEnd - cutStart - 1} duplicate lines`);
  fs.writeFileSync('vm/cloudInit.js', lines.join('\n'), 'utf8');
  console.log('FIXED');
} else {
  console.log('Could not find cut points');
}
