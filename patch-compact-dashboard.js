const fs = require('fs');
let css = fs.readFileSync('renderer/styles.css', 'utf8');

const fixes = [
  // Reduce chart SVG height
  ['.overview-chart-card svg', 'height: 76px;', 'height: 56px;'],
  // Reduce chart card padding
  ['.overview-chart-card {', 'padding: 9px 10px;', 'padding: 6px 8px;'],
  // Reduce chart meta margin
  ['.overview-chart-meta {', 'margin-bottom: 6px;', 'margin-bottom: 3px;'],
  // Reduce hero panel padding
  ['.overview-hero-panel {', null, null], // handled below
  // Reduce overview-panel border-radius
  ['.overview-panel {', 'border-radius: 14px;', 'border-radius: 10px;'],
  // Reduce activity list max-height
  ['.overview-activity-list {', null, null], // handled below
];

for (const [selector, find, replace] of fixes) {
  if (find && replace) {
    const idx = css.indexOf(selector);
    if (idx >= 0) {
      const findIdx = css.indexOf(find, idx);
      if (findIdx >= 0 && findIdx < idx + 600) {
        css = css.slice(0, findIdx) + replace + css.slice(findIdx + find.length);
        console.log(`FIXED: ${selector} -> ${find.substring(0,30)} => ${replace}`);
      }
    }
  }
}

// Reduce hero panel height/padding
const heroIdx = css.indexOf('.overview-hero-panel {');
if (heroIdx >= 0) {
  const padIdx = css.indexOf('padding:', heroIdx);
  if (padIdx >= 0 && padIdx < heroIdx + 300) {
    const endIdx = css.indexOf(';', padIdx);
    const oldPad = css.slice(padIdx, endIdx + 1);
    css = css.slice(0, padIdx) + 'padding: 12px 18px;' + css.slice(endIdx + 1);
    console.log(`FIXED: hero panel padding ${oldPad} => padding: 12px 18px;`);
  }
}

// Set max-height on activity list to prevent it from growing too tall
const actIdx = css.indexOf('.overview-activity-list {');
if (actIdx >= 0) {
  const braceEnd = css.indexOf('}', actIdx);
  const actBlock = css.slice(actIdx, braceEnd);
  if (!actBlock.includes('max-height')) {
    css = css.slice(0, braceEnd) + '  max-height: 150px;\r\n  overflow-y: auto;\r\n' + css.slice(braceEnd);
    console.log('ADDED: max-height: 150px to overview-activity-list');
  }
}

// Reduce overview metric card height 
const metricCardIdx = css.indexOf('.overview-metric-card {');
if (metricCardIdx >= 0) {
  const padIdx2 = css.indexOf('padding:', metricCardIdx);
  if (padIdx2 >= 0 && padIdx2 < metricCardIdx + 200) {
    const endIdx2 = css.indexOf(';', padIdx2);
    const oldPad2 = css.slice(padIdx2, endIdx2 + 1);
    if (oldPad2.includes('16px') || oldPad2.includes('14px')) {
      css = css.slice(0, padIdx2) + 'padding: 10px 12px;' + css.slice(endIdx2 + 1);
      console.log(`FIXED: metric card ${oldPad2} => padding: 10px 12px;`);
    }
  }
}

// Reduce overview-storage-grid gap
const stGridIdx = css.indexOf('.overview-storage-grid {');
if (stGridIdx >= 0) {
  const gapIdx = css.indexOf('gap:', stGridIdx);
  if (gapIdx >= 0 && gapIdx < stGridIdx + 200) {
    const endIdx3 = css.indexOf(';', gapIdx);
    const oldGap = css.slice(gapIdx, endIdx3 + 1);
    if (oldGap.includes('10px') || oldGap.includes('12px') || oldGap.includes('8px')) {
      css = css.slice(0, gapIdx) + 'gap: 6px;' + css.slice(endIdx3 + 1);
      console.log(`FIXED: storage-grid ${oldGap} => gap: 6px;`);
    }
  }
}

// Reduce ov-chip-row padding
const chipIdx = css.indexOf('.ov-chip-row {');
if (chipIdx >= 0) {
  const padIdx3 = css.indexOf('padding:', chipIdx);
  if (padIdx3 >= 0 && padIdx3 < chipIdx + 200) {
    const endIdx4 = css.indexOf(';', padIdx3);
    const oldPad3 = css.slice(padIdx3, endIdx4 + 1);
    css = css.slice(0, padIdx3) + 'padding: 4px 0;' + css.slice(endIdx4 + 1);
    console.log(`FIXED: chip-row ${oldPad3} => padding: 4px 0;`);
  }
}

fs.writeFileSync('renderer/styles.css', css, 'utf8');
console.log('\nDONE - Dashboard compacted for small screens');
