const fs = require('fs');

// ─── Fix CSS overflow ───
let css = fs.readFileSync('renderer/styles.css', 'utf8');

// Fix 1: overview-panel overflow
const panelIdx = css.indexOf('.overview-panel {');
if (panelIdx >= 0) {
  const overflowIdx = css.indexOf('overflow: hidden;', panelIdx);
  // Make sure this is within the overview-panel block (within next 200 chars)
  if (overflowIdx >= 0 && overflowIdx < panelIdx + 200) {
    css = css.slice(0, overflowIdx) + 'overflow: visible;' + css.slice(overflowIdx + 'overflow: hidden;'.length);
    console.log('FIXED: overview-panel overflow: hidden → visible');
  }
}

// Fix 2: overview-empty-state overflow + padding
const emptyIdx = css.indexOf('.overview-empty-state {');
if (emptyIdx >= 0) {
  const overflowIdx2 = css.indexOf('overflow: hidden;', emptyIdx);
  if (overflowIdx2 >= 0 && overflowIdx2 < emptyIdx + 200) {
    css = css.slice(0, overflowIdx2) + 'overflow: visible;' + css.slice(overflowIdx2 + 'overflow: hidden;'.length);
    console.log('FIXED: overview-empty-state overflow: hidden → visible');
  }
  // Reduce padding
  const padIdx = css.indexOf('padding: 20px 14px;', emptyIdx);
  if (padIdx >= 0 && padIdx < emptyIdx + 300) {
    css = css.slice(0, padIdx) + 'padding: 14px 14px;' + css.slice(padIdx + 'padding: 20px 14px;'.length);
    console.log('FIXED: overview-empty-state padding reduced');
  }
  // Make border less prominent
  const borderIdx = css.indexOf('border: 1px dashed rgba(154, 164, 178, 0.24);', emptyIdx);
  if (borderIdx >= 0 && borderIdx < emptyIdx + 300) {
    css = css.slice(0, borderIdx) + 'border: 1px dashed rgba(154, 164, 178, 0.14);' + css.slice(borderIdx + 'border: 1px dashed rgba(154, 164, 178, 0.24);'.length);
    console.log('FIXED: overview-empty-state border opacity reduced');
  }
}

fs.writeFileSync('renderer/styles.css', css, 'utf8');

// ─── Fix ISO delete styling ───
let dash = fs.readFileSync('renderer/components/dashboard.js', 'utf8');

// Find the form-group for ISO check and improve it
const isoMarker = 'deleteIsoCheck';
const isoIdx = dash.indexOf(isoMarker);
if (isoIdx >= 0) {
  // Find the form-group div before it
  const formGroupIdx = dash.lastIndexOf('form-group', isoIdx);
  if (formGroupIdx >= 0) {
    const divIdx = dash.lastIndexOf('<div', formGroupIdx);
    // Find the style attribute
    const styleStart = dash.indexOf('style="', divIdx);
    if (styleStart >= 0 && styleStart < isoIdx) {
      const styleEnd = dash.indexOf('"', styleStart + 7);
      const oldStyle = dash.substring(styleStart, styleEnd + 1);
      const newStyle = 'style="margin-top: 14px; padding: 12px; border-radius: 10px; border: 1px solid rgba(239, 68, 68, 0.18); background: rgba(239, 68, 68, 0.06);"';
      dash = dash.slice(0, styleStart) + newStyle + dash.slice(styleEnd + 1);
      console.log('POLISHED: ISO delete section styling');
    }
  }
}

fs.writeFileSync('renderer/components/dashboard.js', dash, 'utf8');
console.log('DONE');
