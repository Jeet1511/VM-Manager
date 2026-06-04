/**
 * adapters/vboxXmlEditor.js — Direct .vbox XML File Editor
 *
 * Provides safe, structured read/write access to VirtualBox .vbox XML
 * configuration files. Used as a preferred configuration path when the VM
 * is powered off and VBoxSVC is not holding a lock.
 *
 * Design decisions:
 * - Zero npm dependencies (matches the project's zero-dependency philosophy)
 * - Uses regex-based parsing for attribute-level edits on the predictable
 *   VirtualBox XML schema, with a lightweight DOM-like approach for
 *   structural changes (adding/removing elements)
 * - Atomic writes (write to .tmp, then rename) to prevent corruption
 * - Timestamped backups before every modification
 * - All functions are defensive — malformed XML never throws uncaught
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../core/logger');

// ---------------------------------------------------------------------------
// VBoxSVC Process Detection
// ---------------------------------------------------------------------------

/**
 * Check if VBoxSVC (VirtualBox background service) is currently running.
 * VBoxSVC caches .vbox files and may overwrite disk changes on exit.
 *
 * @returns {{ active: boolean, pids: number[], details: string }}
 */
function isVBoxSVCActive() {
  try {
    if (process.platform === 'win32') {
      const output = execSync('tasklist /FI "IMAGENAME eq VBoxSVC.exe" /FO CSV /NH', {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      });
      const lines = String(output || '').split('\n').filter(line => /VBoxSVC/i.test(line));
      const pids = lines.map(line => {
        const match = line.match(/"VBoxSVC\.exe","(\d+)"/i);
        return match ? parseInt(match[1], 10) : 0;
      }).filter(Boolean);
      return { active: pids.length > 0, pids, details: pids.length > 0 ? `VBoxSVC running (PIDs: ${pids.join(', ')})` : 'VBoxSVC not running' };
    } else {
      // macOS / Linux
      const output = execSync('pgrep -x VBoxSVC 2>/dev/null || true', {
        encoding: 'utf8',
        timeout: 5000
      });
      const pids = String(output || '').trim().split('\n').map(s => parseInt(s.trim(), 10)).filter(Boolean);
      return { active: pids.length > 0, pids, details: pids.length > 0 ? `VBoxSVC running (PIDs: ${pids.join(', ')})` : 'VBoxSVC not running' };
    }
  } catch (err) {
    logger.debug('VBoxXmlEditor', `VBoxSVC detection error: ${err.message}`);
    return { active: false, pids: [], details: `Detection failed: ${err.message}` };
  }
}

/**
 * Check if VBoxSVC is holding a lock on a specific .vbox file.
 * On Windows, tries to open the file exclusively; on other platforms,
 * checks for .vbox-prev lock files.
 *
 * @param {string} vboxFilePath - Absolute path to the .vbox file
 * @returns {{ locked: boolean, details: string }}
 */
function isVboxFileLocked(vboxFilePath) {
  try {
    // Check for VirtualBox lock file patterns
    const lockFile = vboxFilePath + '.lock';
    const prevFile = vboxFilePath + '-prev';
    const tmpFile = vboxFilePath + '-tmp';

    if (fs.existsSync(lockFile)) {
      return { locked: true, details: `Lock file exists: ${lockFile}` };
    }

    // Try opening the file for write to test if it's locked
    let fd = null;
    try {
      fd = fs.openSync(vboxFilePath, 'r+');
      fs.closeSync(fd);
      return { locked: false, details: 'File is not locked' };
    } catch (openErr) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (/EBUSY|EACCES|EPERM/i.test(String(openErr.code || openErr.message || ''))) {
        return { locked: true, details: `File is locked by another process: ${openErr.message}` };
      }
      return { locked: false, details: `File check inconclusive: ${openErr.message}` };
    }
  } catch (err) {
    return { locked: false, details: `Lock check failed: ${err.message}` };
  }
}

/**
 * Validate that it's safe to perform direct XML editing on a VM's config file.
 *
 * @param {string} vboxFilePath - Path to the .vbox file
 * @param {string} vmState - Current VM state (from VBoxManage showvminfo)
 * @returns {{ safe: boolean, reason: string }}
 */
function ensureSafeForXmlEdit(vboxFilePath, vmState) {
  const state = String(vmState || '').toLowerCase();

  // VM must be powered off
  if (state && state !== 'poweroff' && state !== 'aborted' && state !== 'saved') {
    return { safe: false, reason: `VM is in state "${state}" — XML editing requires the VM to be powered off.` };
  }

  // Check if the file exists
  if (!vboxFilePath || !fs.existsSync(vboxFilePath)) {
    return { safe: false, reason: `Configuration file not found: ${vboxFilePath || '(no path)'}` };
  }

  // Check file lock
  const lockStatus = isVboxFileLocked(vboxFilePath);
  if (lockStatus.locked) {
    return { safe: false, reason: `Configuration file is locked: ${lockStatus.details}` };
  }

  return { safe: true, reason: 'Safe to edit' };
}

// ---------------------------------------------------------------------------
// File I/O — Backup, Read, Write
// ---------------------------------------------------------------------------

/**
 * Create a timestamped backup of the .vbox file.
 *
 * @param {string} filePath - Path to the .vbox file
 * @returns {string} Path to the backup file
 */
function backupVboxFile(filePath) {
  const timestamp = Date.now();
  const backupPath = `${filePath}.backup-${timestamp}`;
  fs.copyFileSync(filePath, backupPath);
  logger.info('VBoxXmlEditor', `Backup created: ${backupPath}`);
  return backupPath;
}

/**
 * Read a .vbox XML file and return its raw content.
 *
 * @param {string} filePath - Path to the .vbox file
 * @returns {string} Raw XML content
 */
function readVboxXml(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`VBox config file not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Write XML content to a .vbox file using atomic write.
 * Writes to a temp file first, then renames to prevent corruption.
 *
 * @param {string} filePath - Path to the .vbox file
 * @param {string} xmlContent - The XML content to write
 */
function writeVboxXml(filePath, xmlContent) {
  const tmpPath = filePath + '.vmxposed-tmp';
  try {
    fs.writeFileSync(tmpPath, xmlContent, 'utf8');

    // Validate the temp file is readable and non-empty
    const written = fs.readFileSync(tmpPath, 'utf8');
    if (!written || written.length < 100) {
      throw new Error('Written file appears corrupt or too small');
    }

    // Atomic rename
    fs.renameSync(tmpPath, filePath);
    logger.info('VBoxXmlEditor', `Configuration written: ${filePath} (${xmlContent.length} bytes)`);
  } catch (err) {
    // Clean up temp file on failure
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// XML Parsing Utilities
// ---------------------------------------------------------------------------

/**
 * Find the namespace prefix used in the .vbox file, if any.
 * VirtualBox uses xmlns="http://www.virtualbox.org/..." which means
 * elements may or may not have a namespace prefix.
 *
 * @param {string} xml - Raw XML content
 * @returns {string} The namespace prefix (empty string if default namespace)
 */
function _detectNamespace(xml) {
  // VirtualBox .vbox files typically use a default namespace (no prefix)
  // <VirtualBox xmlns="http://www.virtualbox.org/..." version="...">
  // So elements are just <Machine>, <Hardware>, etc.
  return '';
}

/**
 * Get the content between a specific XML element's opening and closing tags.
 * Returns null if the element is not found.
 *
 * @param {string} xml - XML content
 * @param {string} tagName - Element tag name (e.g., 'Hardware')
 * @returns {{ content: string, startIndex: number, endIndex: number, fullMatch: string } | null}
 */
function _findElement(xml, tagName) {
  // Match opening tag (with optional attributes) through closing tag
  const openTagRegex = new RegExp(`(<${tagName}(?:\\s[^>]*)?>)`, 'i');
  const openMatch = xml.match(openTagRegex);
  if (!openMatch) return null;

  const startIndex = xml.indexOf(openMatch[0]);

  // Check for self-closing tag
  if (openMatch[0].endsWith('/>')) {
    return {
      content: '',
      startIndex,
      endIndex: startIndex + openMatch[0].length,
      fullMatch: openMatch[0],
      selfClosing: true,
      openTag: openMatch[0]
    };
  }

  // Find the matching closing tag (handle nesting)
  let depth = 1;
  let searchFrom = startIndex + openMatch[0].length;
  const openPattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, 'gi');
  const closePattern = new RegExp(`</${tagName}>`, 'gi');

  while (depth > 0 && searchFrom < xml.length) {
    openPattern.lastIndex = searchFrom;
    closePattern.lastIndex = searchFrom;

    const nextOpen = openPattern.exec(xml);
    const nextClose = closePattern.exec(xml);

    if (!nextClose) break; // Malformed XML — no closing tag

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      searchFrom = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      if (depth === 0) {
        const endIndex = nextClose.index + nextClose[0].length;
        const innerStart = startIndex + openMatch[0].length;
        return {
          content: xml.substring(innerStart, nextClose.index),
          startIndex,
          endIndex,
          fullMatch: xml.substring(startIndex, endIndex),
          selfClosing: false,
          openTag: openMatch[0]
        };
      }
      searchFrom = nextClose.index + nextClose[0].length;
    }
  }

  return null;
}

/**
 * Find all occurrences of a specific element within a parent section.
 *
 * @param {string} xml - XML content (typically a subsection)
 * @param {string} tagName - Element tag name
 * @returns {Array<{ content: string, startIndex: number, endIndex: number, fullMatch: string, openTag: string }>}
 */
function _findAllElements(xml, tagName) {
  const results = [];
  let remaining = xml;
  let offset = 0;

  while (true) {
    const found = _findElement(remaining, tagName);
    if (!found) break;

    results.push({
      ...found,
      startIndex: found.startIndex + offset,
      endIndex: found.endIndex + offset
    });

    const nextSearchStart = found.endIndex - offset;
    if (nextSearchStart >= remaining.length) break;
    offset += nextSearchStart;
    remaining = remaining.substring(nextSearchStart);
  }

  return results;
}

/**
 * Get the value of an attribute from an XML element's opening tag.
 *
 * @param {string} openTag - The opening tag string (e.g., '<Memory RAMSize="4096"/>')
 * @param {string} attrName - Attribute name (e.g., 'RAMSize')
 * @returns {string|null} Attribute value or null if not found
 */
function _getAttribute(openTag, attrName) {
  const regex = new RegExp(`${attrName}\\s*=\\s*"([^"]*)"`, 'i');
  const match = openTag.match(regex);
  return match ? match[1] : null;
}

/**
 * Set an attribute value on an XML tag string. If the attribute exists, it's
 * replaced; if not, it's added before the closing > or />.
 *
 * @param {string} tag - The full tag string
 * @param {string} attrName - Attribute name
 * @param {string} attrValue - New attribute value
 * @returns {string} Modified tag string
 */
function _setAttribute(tag, attrName, attrValue) {
  const existingRegex = new RegExp(`(${attrName})\\s*=\\s*"[^"]*"`, 'i');
  if (existingRegex.test(tag)) {
    return tag.replace(existingRegex, `${attrName}="${attrValue}"`);
  }

  // Add new attribute before closing > or />
  if (tag.endsWith('/>')) {
    return tag.replace(/\s*\/>$/, ` ${attrName}="${attrValue}"/>`);
  }
  return tag.replace(/>$/, ` ${attrName}="${attrValue}">`);
}

/**
 * Remove an attribute from an XML tag string.
 *
 * @param {string} tag - The full tag string
 * @param {string} attrName - Attribute name to remove
 * @returns {string} Modified tag string
 */
function _removeAttribute(tag, attrName) {
  const regex = new RegExp(`\\s*${attrName}\\s*=\\s*"[^"]*"`, 'i');
  return tag.replace(regex, '');
}

/**
 * Replace a complete element (from opening to closing tag) in the XML.
 *
 * @param {string} xml - Full XML content
 * @param {string} tagName - Element tag name to find and replace
 * @param {string} replacement - The replacement XML string
 * @returns {string} Modified XML content
 */
function _replaceElement(xml, tagName, replacement) {
  const found = _findElement(xml, tagName);
  if (!found) return xml;
  return xml.substring(0, found.startIndex) + replacement + xml.substring(found.endIndex);
}

/**
 * Insert an element as a child of a parent element, before the closing tag.
 *
 * @param {string} xml - Full XML content
 * @param {string} parentTagName - Parent element tag name
 * @param {string} childXml - The child XML string to insert
 * @returns {string} Modified XML content
 */
function _insertChild(xml, parentTagName, childXml) {
  const parent = _findElement(xml, parentTagName);
  if (!parent) return xml;

  if (parent.selfClosing) {
    // Convert self-closing to open/close and insert child
    const openTag = parent.openTag.replace(/\s*\/>$/, '>');
    const replacement = `${openTag}\n        ${childXml}\n      </${parentTagName}>`;
    return xml.substring(0, parent.startIndex) + replacement + xml.substring(parent.endIndex);
  }

  // Insert before the closing tag
  const closeTagRegex = new RegExp(`(\\s*)</${parentTagName}>`, 'i');
  const insertionPoint = xml.lastIndexOf(`</${parentTagName}>`, parent.endIndex);
  if (insertionPoint < 0) return xml;

  // Detect indentation
  const lineStart = xml.lastIndexOf('\n', insertionPoint);
  const indent = lineStart >= 0 ? xml.substring(lineStart + 1, insertionPoint).match(/^(\s*)/)?.[1] || '        ' : '        ';

  return xml.substring(0, insertionPoint) + `${indent}  ${childXml}\n` + xml.substring(insertionPoint);
}

// ---------------------------------------------------------------------------
// Setting Manipulation Functions
// ---------------------------------------------------------------------------

/**
 * Set the RAM size in the .vbox XML.
 *
 * @param {string} xml - Raw XML content
 * @param {number} sizeMB - RAM size in megabytes
 * @returns {string} Modified XML
 */
function setMemory(xml, sizeMB) {
  const size = Math.max(4, Math.floor(Number(sizeMB) || 0));
  const found = _findElement(xml, 'Memory');
  if (found) {
    const newTag = _setAttribute(found.fullMatch, 'RAMSize', String(size));
    return xml.substring(0, found.startIndex) + newTag + xml.substring(found.endIndex);
  }
  // If no Memory element exists, try inserting inside Hardware
  return _insertChild(xml, 'Hardware', `<Memory RAMSize="${size}"/>`);
}

/**
 * Set the CPU count in the .vbox XML.
 *
 * @param {string} xml - Raw XML content
 * @param {number} count - Number of CPUs
 * @returns {string} Modified XML
 */
function setCPU(xml, count) {
  const cpuCount = Math.max(1, Math.floor(Number(count) || 1));
  const found = _findElement(xml, 'CPU');
  if (found) {
    const newTag = _setAttribute(found.openTag, 'count', String(cpuCount));
    if (found.selfClosing) {
      return xml.substring(0, found.startIndex) + newTag + xml.substring(found.endIndex);
    }
    // Replace just the opening tag
    return xml.substring(0, found.startIndex) + newTag + found.content + `</CPU>` + xml.substring(found.endIndex);
  }
  return _insertChild(xml, 'Hardware', `<CPU count="${cpuCount}"/>`);
}

/**
 * Set display-related settings in the .vbox XML.
 *
 * @param {string} xml - Raw XML content
 * @param {object} options - Display options
 * @param {number} [options.vram] - VRAM size in MB
 * @param {number} [options.monitorCount] - Number of monitors
 * @param {boolean} [options.accelerate3D] - Enable 3D acceleration
 * @returns {string} Modified XML
 */
function setDisplay(xml, options = {}) {
  const found = _findElement(xml, 'Display');
  if (found) {
    let tag = found.fullMatch;
    if (options.vram !== undefined) {
      tag = _setAttribute(tag, 'VRAMSize', String(Math.max(1, Math.floor(Number(options.vram) || 0))));
    }
    if (options.monitorCount !== undefined) {
      tag = _setAttribute(tag, 'monitorCount', String(Math.max(1, Math.floor(Number(options.monitorCount) || 1))));
    }
    if (options.accelerate3D !== undefined) {
      tag = _setAttribute(tag, 'accelerate3D', options.accelerate3D ? 'true' : 'false');
    }
    return xml.substring(0, found.startIndex) + tag + xml.substring(found.endIndex);
  }
  // Create a new Display element
  const attrs = [];
  if (options.vram !== undefined) attrs.push(`VRAMSize="${Math.max(1, Math.floor(Number(options.vram) || 128))}"`);
  if (options.monitorCount !== undefined) attrs.push(`monitorCount="${Math.max(1, Math.floor(Number(options.monitorCount) || 1))}"`);
  if (options.accelerate3D !== undefined) attrs.push(`accelerate3D="${options.accelerate3D ? 'true' : 'false'}"`);
  return _insertChild(xml, 'Hardware', `<Display ${attrs.join(' ')}/>`);
}

/**
 * Set the graphics controller type in the .vbox XML.
 * In VirtualBox XML, this is a child of <Display>: <GraphicsAdapter type="VMSVGA"/>
 * OR an attribute on <Display>: graphicsControllerType="VMSVGA"
 * The exact location depends on VirtualBox version.
 *
 * @param {string} xml - Raw XML content
 * @param {string} controllerType - Controller type: 'VMSVGA', 'VBoxSVGA', 'VBoxVGA'
 * @returns {string} Modified XML
 */
function setGraphicsController(xml, controllerType) {
  const type = String(controllerType || 'VMSVGA');

  // VBox 6.x+: <GraphicsAdapter type="..."/>  inside <Display>
  const graphicsAdapter = _findElement(xml, 'GraphicsAdapter');
  if (graphicsAdapter) {
    const newTag = _setAttribute(graphicsAdapter.fullMatch, 'type', type);
    return xml.substring(0, graphicsAdapter.startIndex) + newTag + xml.substring(graphicsAdapter.endIndex);
  }

  // VBox 7.x+: attribute on Display element: graphicsControllerType="..."
  const display = _findElement(xml, 'Display');
  if (display) {
    // Check if Display has a graphicsControllerType attribute
    if (_getAttribute(display.openTag, 'graphicsControllerType') !== null) {
      const newTag = _setAttribute(display.openTag, 'graphicsControllerType', type);
      if (display.selfClosing) {
        return xml.substring(0, display.startIndex) + newTag + xml.substring(display.endIndex);
      }
      return xml.substring(0, display.startIndex) + newTag + display.content + '</Display>' + xml.substring(display.endIndex);
    }

    // Insert GraphicsAdapter as child of Display if Display is not self-closing
    if (!display.selfClosing) {
      const insertPoint = display.startIndex + display.openTag.length;
      return xml.substring(0, insertPoint) + `\n            <GraphicsAdapter type="${type}"/>` + xml.substring(insertPoint);
    }

    // Convert self-closing Display to open/close and add child
    const openTag = display.openTag.replace(/\s*\/>$/, '>');
    const replacement = `${openTag}\n            <GraphicsAdapter type="${type}"/>\n          </Display>`;
    return xml.substring(0, display.startIndex) + replacement + xml.substring(display.endIndex);
  }

  return xml;
}

/**
 * Set clipboard mode in the .vbox XML.
 *
 * @param {string} xml - Raw XML content
 * @param {string} mode - Mode: 'Disabled', 'HostToGuest', 'GuestToHost', 'Bidirectional'
 * @returns {string} Modified XML
 */
function setClipboard(xml, mode) {
  const normalizedMode = _normalizeIntegrationModeForXml(mode);
  const found = _findElement(xml, 'Clipboard');
  if (found) {
    const newTag = _setAttribute(found.fullMatch, 'mode', normalizedMode);
    return xml.substring(0, found.startIndex) + newTag + xml.substring(found.endIndex);
  }
  return _insertChild(xml, 'Hardware', `<Clipboard mode="${normalizedMode}"/>`);
}

/**
 * Set drag-and-drop mode in the .vbox XML.
 *
 * @param {string} xml - Raw XML content
 * @param {string} mode - Mode: 'Disabled', 'HostToGuest', 'GuestToHost', 'Bidirectional'
 * @returns {string} Modified XML
 */
function setDragAndDrop(xml, mode) {
  const normalizedMode = _normalizeIntegrationModeForXml(mode);
  const found = _findElement(xml, 'DragAndDrop');
  if (found) {
    const newTag = _setAttribute(found.fullMatch, 'mode', normalizedMode);
    return xml.substring(0, found.startIndex) + newTag + xml.substring(found.endIndex);
  }
  return _insertChild(xml, 'Hardware', `<DragAndDrop mode="${normalizedMode}"/>`);
}

/**
 * Normalize an integration mode string to the VirtualBox XML format.
 * CLI uses lowercase (e.g., 'bidirectional'), XML uses PascalCase (e.g., 'Bidirectional').
 *
 * @param {string} mode - Raw mode string
 * @returns {string} Normalized mode for XML
 */
function _normalizeIntegrationModeForXml(mode) {
  const lower = String(mode || '').toLowerCase();
  switch (lower) {
    case 'disabled': return 'Disabled';
    case 'hosttoguest': return 'HostToGuest';
    case 'guesttohost': return 'GuestToHost';
    case 'bidirectional': return 'Bidirectional';
    default: return 'Disabled';
  }
}

/**
 * Set network adapter configuration in the .vbox XML.
 *
 * @param {string} xml - Raw XML content
 * @param {object} options - Network options
 * @param {number} [options.slot=0] - Adapter slot (0-based)
 * @param {string} [options.mode='nat'] - Network mode: 'nat', 'bridged', 'intnet', 'hostonly'
 * @param {string} [options.internalNetworkName] - Name for internal network (only for 'intnet')
 * @returns {string} Modified XML
 */
function setNetwork(xml, options = {}) {
  const slot = Math.max(0, Math.floor(Number(options.slot || 0)));
  const mode = String(options.mode || 'nat').toLowerCase();

  const network = _findElement(xml, 'Network');
  if (!network) return xml;

  // Find the specific adapter by slot
  const adapters = _findAllElements(network.content, 'Adapter');
  const targetAdapter = adapters.find(a => _getAttribute(a.openTag, 'slot') === String(slot));

  if (!targetAdapter) {
    // Create a new adapter element
    const adapterXml = _buildNetworkAdapterXml(slot, mode, options);
    return _insertChild(xml, 'Network', adapterXml);
  }

  // Replace the network mode child element (NAT, BridgedInterface, InternalNetwork, etc.)
  // within the adapter
  let adapterContent = targetAdapter.content || '';

  // Remove existing mode elements
  for (const modeTag of ['NAT', 'BridgedInterface', 'InternalNetwork', 'HostOnlyInterface', 'NATNetwork']) {
    const existing = _findElement(adapterContent, modeTag);
    if (existing) {
      adapterContent = adapterContent.substring(0, existing.startIndex) + adapterContent.substring(existing.endIndex);
    }
  }

  // Also handle self-closing variants
  adapterContent = adapterContent.replace(/<(NAT|BridgedInterface|InternalNetwork|HostOnlyInterface|NATNetwork)\s*\/>/gi, '');

  // Add the new mode element
  const modeXml = _buildNetworkModeXml(mode, options);
  adapterContent = adapterContent.trimEnd() + '\n              ' + modeXml + '\n';

  // Rebuild the adapter tag
  let newAdapterTag = targetAdapter.openTag;
  // Update enabled attribute
  newAdapterTag = _setAttribute(newAdapterTag, 'enabled', 'true');

  const fullAdapter = targetAdapter.selfClosing
    ? newAdapterTag.replace(/\/>$/, '>') + adapterContent + '            </Adapter>'
    : newAdapterTag + adapterContent + '            </Adapter>';

  // Replace within the Network element
  const networkContent = network.content;
  const adapterStartInNetwork = targetAdapter.startIndex;
  const adapterEndInNetwork = targetAdapter.endIndex;
  const newNetworkContent = networkContent.substring(0, adapterStartInNetwork) + fullAdapter + networkContent.substring(adapterEndInNetwork);

  return xml.substring(0, network.startIndex) + network.openTag + newNetworkContent + '</Network>' + xml.substring(network.endIndex);
}

function _buildNetworkAdapterXml(slot, mode, options) {
  const modeXml = _buildNetworkModeXml(mode, options);
  return `<Adapter slot="${slot}" enabled="true" type="82540EM">\n              ${modeXml}\n            </Adapter>`;
}

function _buildNetworkModeXml(mode, options = {}) {
  switch (mode) {
    case 'nat': return '<NAT/>';
    case 'bridged': return `<BridgedInterface name="${options.bridgeAdapter || ''}"/>`;
    case 'intnet':
    case 'internal': return `<InternalNetwork name="${options.internalNetworkName || 'intnet'}"/>`;
    case 'hostonly': return '<HostOnlyInterface/>';
    default: return '<NAT/>';
  }
}

/**
 * Set boot order in the .vbox XML.
 *
 * @param {string} xml - Raw XML content
 * @param {string[]} order - Boot order array, e.g., ['disk', 'dvd', 'none', 'none']
 * @returns {string} Modified XML
 */
function setBootOrder(xml, order) {
  if (!Array.isArray(order) || order.length === 0) return xml;

  const normalizedOrder = order.slice(0, 4).map(item => {
    const lower = String(item || 'none').toLowerCase();
    switch (lower) {
      case 'disk': case 'harddisk': return 'HardDisk';
      case 'dvd': case 'dvddrive': case 'cdrom': return 'DVD';
      case 'floppy': return 'Floppy';
      case 'net': case 'network': return 'Network';
      default: return 'None';
    }
  });

  // Pad to 4 entries
  while (normalizedOrder.length < 4) normalizedOrder.push('None');

  const boot = _findElement(xml, 'Boot');
  if (boot) {
    // Build new boot order XML
    const orderXml = normalizedOrder.map((device, i) =>
      `<Order position="${i + 1}" device="${device}"/>`
    ).join('\n              ');

    const replacement = `<Boot>\n              ${orderXml}\n            </Boot>`;
    return xml.substring(0, boot.startIndex) + replacement + xml.substring(boot.endIndex);
  }

  // If no Boot element, try inserting inside BIOS
  const bootXml = normalizedOrder.map((device, i) =>
    `<Order position="${i + 1}" device="${device}"/>`
  ).join('\n              ');

  const bios = _findElement(xml, 'BIOS');
  if (bios) {
    return _insertChild(xml, 'BIOS', `<Boot>\n              ${bootXml}\n            </Boot>`);
  }

  return xml;
}

/**
 * Set USB controller settings in the .vbox XML.
 *
 * @param {string} xml - Raw XML content
 * @param {boolean} enabled - Whether USB is enabled
 * @returns {string} Modified XML
 */
function setUSB(xml, enabled) {
  const usb = _findElement(xml, 'USB');
  if (usb) {
    // Find controller elements within USB
    const controllers = _findAllElements(usb.fullMatch, 'Controllers');
    if (controllers.length > 0) {
      // Update enabled attributes on each controller
      let result = xml;
      const usbSection = _findElement(result, 'USB');
      if (!usbSection) return result;

      // Rebuild USB section
      if (enabled) {
        // Ensure at least OHCI controller exists
        if (!usb.content.includes('type="OHCI"') && !usb.content.includes("type='OHCI'")) {
          const controllersEl = _findElement(usb.fullMatch, 'Controllers');
          if (controllersEl) {
            const newControllers = controllersEl.selfClosing
              ? `<Controllers>\n                <Controller name="OHCI" type="OHCI"/>\n              </Controllers>`
              : controllersEl.fullMatch;
            result = result.substring(0, usbSection.startIndex) +
              _replaceElement(usbSection.fullMatch, 'Controllers', newControllers) +
              result.substring(usbSection.endIndex);
          }
        }
      } else {
        // Remove all controllers (disable USB)
        const replacement = '<USB>\n              <Controllers/>\n            </USB>';
        result = result.substring(0, usbSection.startIndex) + replacement + result.substring(usbSection.endIndex);
      }
      return result;
    }
  }

  if (enabled) {
    return _insertChild(xml, 'Hardware',
      `<USB>\n              <Controllers>\n                <Controller name="OHCI" type="OHCI"/>\n                <Controller name="EHCI" type="EHCI"/>\n              </Controllers>\n            </USB>`);
  }

  return xml;
}

/**
 * Set audio adapter settings in the .vbox XML.
 *
 * @param {string} xml - Raw XML content
 * @param {object} options - Audio options
 * @param {boolean} [options.enabled] - Whether audio is enabled
 * @param {string} [options.controller] - Audio controller type (e.g., 'HDA', 'AC97', 'SB16')
 * @returns {string} Modified XML
 */
function setAudio(xml, options = {}) {
  const found = _findElement(xml, 'AudioAdapter');
  if (found) {
    let tag = found.fullMatch;
    if (options.enabled !== undefined) {
      tag = _setAttribute(tag, 'enabled', options.enabled ? 'true' : 'false');
    }
    if (options.controller !== undefined) {
      tag = _setAttribute(tag, 'controller', String(options.controller).toUpperCase());
    }
    return xml.substring(0, found.startIndex) + tag + xml.substring(found.endIndex);
  }

  if (options.enabled) {
    const controller = String(options.controller || 'HDA').toUpperCase();
    return _insertChild(xml, 'Hardware', `<AudioAdapter controller="${controller}" enabled="true"/>`);
  }

  return xml;
}

/**
 * Set firmware type (BIOS or EFI) in the .vbox XML.
 *
 * @param {string} xml - Raw XML content
 * @param {boolean} efiEnabled - True for EFI, false for BIOS
 * @returns {string} Modified XML
 */
function setFirmware(xml, efiEnabled) {
  const found = _findElement(xml, 'Firmware');
  if (found) {
    const newTag = _setAttribute(found.fullMatch, 'type', efiEnabled ? 'EFI' : 'BIOS');
    return xml.substring(0, found.startIndex) + newTag + xml.substring(found.endIndex);
  }

  // Older VirtualBox uses a 'firmware' attribute on Machine element
  const machine = _findElement(xml, 'Machine');
  if (machine) {
    const currentFirmware = _getAttribute(machine.openTag, 'firmware');
    if (currentFirmware !== null) {
      const newOpenTag = _setAttribute(machine.openTag, 'firmware', efiEnabled ? 'EFI' : 'BIOS');
      return xml.substring(0, machine.startIndex) + newOpenTag + machine.content + '</Machine>' + xml.substring(machine.endIndex);
    }
  }

  // Insert Firmware element inside Hardware
  return _insertChild(xml, 'Hardware', `<Firmware type="${efiEnabled ? 'EFI' : 'BIOS'}"/>`);
}

/**
 * Set nested virtualization (nested-hw-virt) in the .vbox XML.
 * This is typically on the <CPU> element or <HwVirtEx> child.
 *
 * @param {string} xml - Raw XML content
 * @param {boolean} enabled - Whether nested virtualization is enabled
 * @returns {string} Modified XML
 */
function setNestedVirtualization(xml, enabled) {
  // Look for NestedHWVirt element inside CPU
  const cpu = _findElement(xml, 'CPU');
  if (!cpu) return xml;

  const nestedEl = _findElement(cpu.fullMatch, 'NestedHWVirt');
  if (nestedEl) {
    const newTag = _setAttribute(nestedEl.fullMatch, 'enabled', enabled ? 'true' : 'false');
    // Replace within the full XML by calculating absolute position
    const absoluteStart = cpu.startIndex + (nestedEl.startIndex);
    const absoluteEnd = cpu.startIndex + (nestedEl.endIndex);
    // Since nestedEl positions are relative to cpu.fullMatch, not xml
    const cpuContent = cpu.fullMatch;
    const newCpuContent = cpuContent.substring(0, nestedEl.startIndex) + newTag + cpuContent.substring(nestedEl.endIndex);
    return xml.substring(0, cpu.startIndex) + newCpuContent + xml.substring(cpu.endIndex);
  }

  // Insert NestedHWVirt inside CPU
  if (cpu.selfClosing) {
    const openTag = cpu.openTag.replace(/\s*\/>$/, '>');
    const replacement = `${openTag}\n              <NestedHWVirt enabled="${enabled ? 'true' : 'false'}"/>\n            </CPU>`;
    return xml.substring(0, cpu.startIndex) + replacement + xml.substring(cpu.endIndex);
  }

  const insertPoint = cpu.startIndex + cpu.openTag.length;
  return xml.substring(0, insertPoint) + `\n              <NestedHWVirt enabled="${enabled ? 'true' : 'false'}"/>` + xml.substring(insertPoint);
}

/**
 * Set an ExtraData item in the .vbox XML.
 *
 * @param {string} xml - Raw XML content
 * @param {string} key - ExtraData key (e.g., 'VMXposed/ClipboardMode')
 * @param {string} value - ExtraData value
 * @returns {string} Modified XML
 */
function setExtraData(xml, key, value) {
  const extraData = _findElement(xml, 'ExtraData');

  if (extraData) {
    // Check if this key already exists
    const itemRegex = new RegExp(`<ExtraDataItem\\s+name="${_escapeRegex(key)}"\\s+value="[^"]*"\\s*/>`, 'i');
    const altItemRegex = new RegExp(`<ExtraDataItem\\s+value="[^"]*"\\s+name="${_escapeRegex(key)}"\\s*/>`, 'i');

    if (itemRegex.test(extraData.content) || altItemRegex.test(extraData.content)) {
      // Replace existing value
      let newContent = extraData.content;
      newContent = newContent.replace(itemRegex, `<ExtraDataItem name="${key}" value="${_escapeXmlAttr(value)}"/>`);
      newContent = newContent.replace(altItemRegex, `<ExtraDataItem name="${key}" value="${_escapeXmlAttr(value)}"/>`);
      return xml.substring(0, extraData.startIndex) + extraData.openTag + newContent + '</ExtraData>' + xml.substring(extraData.endIndex);
    }

    // Add new item inside ExtraData
    return _insertChild(xml, 'ExtraData', `<ExtraDataItem name="${key}" value="${_escapeXmlAttr(value)}"/>`);
  }

  // Create ExtraData section inside Machine
  const extraDataXml = `<ExtraData>\n          <ExtraDataItem name="${key}" value="${_escapeXmlAttr(value)}"/>\n        </ExtraData>`;
  return _insertChild(xml, 'Machine', extraDataXml);
}

/**
 * Set shared folders in the .vbox XML.
 *
 * @param {string} xml - Raw XML content
 * @param {Array<{ name: string, hostPath: string, autoMount?: boolean }>} folders - Shared folder definitions
 * @returns {string} Modified XML
 */
function setSharedFolders(xml, folders) {
  if (!Array.isArray(folders)) return xml;

  const foldersXml = folders
    .filter(f => f && f.name && f.hostPath)
    .map(f => {
      const autoMount = f.autoMount !== false ? ' autoMount="true"' : '';
      return `<SharedFolder name="${_escapeXmlAttr(f.name)}" hostPath="${_escapeXmlAttr(f.hostPath)}"${autoMount} writable="true"/>`;
    })
    .join('\n            ');

  const sharedFolders = _findElement(xml, 'SharedFolders');
  if (sharedFolders) {
    const replacement = folders.length > 0
      ? `<SharedFolders>\n            ${foldersXml}\n          </SharedFolders>`
      : '<SharedFolders/>';
    return xml.substring(0, sharedFolders.startIndex) + replacement + xml.substring(sharedFolders.endIndex);
  }

  if (folders.length > 0) {
    return _insertChild(xml, 'Machine',
      `<SharedFolders>\n            ${foldersXml}\n          </SharedFolders>`);
  }

  return xml;
}

// ---------------------------------------------------------------------------
// Read Settings (XML → Object)
// ---------------------------------------------------------------------------

/**
 * Read all relevant settings from the parsed .vbox XML and return
 * a normalized settings object.
 *
 * @param {string} xml - Raw XML content
 * @returns {object} Current settings from the XML
 */
function readCurrentSettings(xml) {
  const settings = {};

  // Memory
  const memory = _findElement(xml, 'Memory');
  if (memory) {
    settings.ram = parseInt(_getAttribute(memory.openTag, 'RAMSize') || '0', 10) || 0;
  }

  // CPU
  const cpu = _findElement(xml, 'CPU');
  if (cpu) {
    settings.cpus = parseInt(_getAttribute(cpu.openTag, 'count') || '1', 10) || 1;

    // Nested virtualization
    const nested = _findElement(cpu.fullMatch, 'NestedHWVirt');
    if (nested) {
      settings.nestedVirtualization = _getAttribute(nested.openTag, 'enabled') === 'true';
    }
  }

  // Display
  const display = _findElement(xml, 'Display');
  if (display) {
    settings.vram = parseInt(_getAttribute(display.openTag, 'VRAMSize') || '0', 10) || 0;
    settings.monitorCount = parseInt(_getAttribute(display.openTag, 'monitorCount') || '1', 10) || 1;
    settings.accelerate3d = _getAttribute(display.openTag, 'accelerate3D') === 'true';
  }

  // Graphics controller
  const graphicsAdapter = _findElement(xml, 'GraphicsAdapter');
  if (graphicsAdapter) {
    settings.graphicsController = _getAttribute(graphicsAdapter.openTag, 'type') || '';
  }
  if (!settings.graphicsController && display) {
    settings.graphicsController = _getAttribute(display.openTag, 'graphicsControllerType') || '';
  }

  // Clipboard
  const clipboard = _findElement(xml, 'Clipboard');
  if (clipboard) {
    settings.clipboardMode = (_getAttribute(clipboard.openTag, 'mode') || 'Disabled').toLowerCase();
  }

  // Drag and drop
  const dragAndDrop = _findElement(xml, 'DragAndDrop');
  if (dragAndDrop) {
    settings.dragAndDrop = (_getAttribute(dragAndDrop.openTag, 'mode') || 'Disabled').toLowerCase();
  }

  // Boot order
  const boot = _findElement(xml, 'Boot');
  if (boot) {
    const orders = _findAllElements(boot.fullMatch, 'Order');
    const bootOrder = [];
    for (const order of orders) {
      const position = parseInt(_getAttribute(order.openTag, 'position') || '0', 10);
      const device = (_getAttribute(order.openTag, 'device') || 'None').toLowerCase();
      if (position > 0) {
        bootOrder[position - 1] = device === 'harddisk' ? 'disk' : device === 'dvd' ? 'dvd' : device;
      }
    }
    settings.bootOrder = bootOrder.filter(Boolean);
  }

  // Audio
  const audio = _findElement(xml, 'AudioAdapter');
  if (audio) {
    settings.audioEnabled = _getAttribute(audio.openTag, 'enabled') === 'true';
    settings.audioController = (_getAttribute(audio.openTag, 'controller') || 'HDA').toLowerCase();
  }

  // USB
  const usb = _findElement(xml, 'USB');
  if (usb) {
    const controllers = _findElement(usb.fullMatch, 'Controllers');
    if (controllers) {
      const controllerElements = _findAllElements(controllers.fullMatch, 'Controller');
      settings.usbEnabled = controllerElements.length > 0;
    } else {
      settings.usbEnabled = false;
    }
  }

  // Firmware / EFI
  const firmware = _findElement(xml, 'Firmware');
  if (firmware) {
    settings.efiEnabled = (_getAttribute(firmware.openTag, 'type') || '').toUpperCase() === 'EFI';
  } else {
    const machine = _findElement(xml, 'Machine');
    if (machine) {
      const fw = _getAttribute(machine.openTag, 'firmware') || '';
      settings.efiEnabled = fw.toUpperCase() === 'EFI';
    }
  }

  // Network
  const network = _findElement(xml, 'Network');
  if (network) {
    const adapters = _findAllElements(network.content, 'Adapter');
    const adapter0 = adapters.find(a => _getAttribute(a.openTag, 'slot') === '0');
    if (adapter0) {
      if (adapter0.content) {
        if (adapter0.content.includes('<NAT') || adapter0.content.includes('<NAT/')) settings.networkMode = 'nat';
        else if (adapter0.content.includes('<BridgedInterface')) settings.networkMode = 'bridged';
        else if (adapter0.content.includes('<InternalNetwork')) settings.networkMode = 'internal';
        else if (adapter0.content.includes('<HostOnlyInterface')) settings.networkMode = 'hostonly';
        else settings.networkMode = 'nat';
      }
    }
  }

  // Shared folders
  const sharedFolders = _findElement(xml, 'SharedFolders');
  if (sharedFolders) {
    const folderElements = _findAllElements(sharedFolders.fullMatch, 'SharedFolder');
    settings.sharedFolders = folderElements.map(f => ({
      name: _getAttribute(f.openTag, 'name') || '',
      hostPath: _getAttribute(f.openTag, 'hostPath') || '',
      autoMount: _getAttribute(f.openTag, 'autoMount') !== 'false'
    })).filter(f => f.name && f.hostPath);
  }

  // ExtraData — VMXposed preferences
  const extraData = _findElement(xml, 'ExtraData');
  if (extraData) {
    const items = _findAllElements(extraData.fullMatch, 'ExtraDataItem');
    settings.extraData = {};
    for (const item of items) {
      const name = _getAttribute(item.openTag, 'name') || '';
      const value = _getAttribute(item.openTag, 'value') || '';
      if (name) settings.extraData[name] = value;
    }
  }

  return settings;
}

// ---------------------------------------------------------------------------
// High-Level Edit Orchestrator
// ---------------------------------------------------------------------------

/**
 * Apply a set of settings to a VM's .vbox XML file.
 * This is the main entry point for direct XML editing.
 *
 * @param {string} vboxFilePath - Path to the .vbox file
 * @param {object} settings - Settings to apply (same shape as vm:edit handler)
 * @returns {{ success: boolean, applied: string[], warnings: string[], backupPath: string }}
 */
function applySettingsToXml(vboxFilePath, settings) {
  const applied = [];
  const warnings = [];

  // Read current XML
  let xml = readVboxXml(vboxFilePath);

  // Backup
  let backupPath = '';
  try {
    backupPath = backupVboxFile(vboxFilePath);
  } catch (backupErr) {
    warnings.push(`Backup failed: ${backupErr.message}`);
  }

  try {
    // Apply each setting
    if (settings.ram !== undefined) {
      xml = setMemory(xml, settings.ram);
      applied.push(`RAM: ${settings.ram} MB`);
    }

    if (settings.cpus !== undefined) {
      xml = setCPU(xml, settings.cpus);
      applied.push(`CPUs: ${settings.cpus}`);
    }

    if (settings.vram !== undefined) {
      xml = setDisplay(xml, { vram: settings.vram });
      applied.push(`VRAM: ${settings.vram} MB`);
    }

    if (settings.accelerate3d !== undefined) {
      xml = setDisplay(xml, { accelerate3D: settings.accelerate3d });
      applied.push(`3D Acceleration: ${settings.accelerate3d ? 'on' : 'off'}`);
    }

    if (settings.graphicsController !== undefined) {
      xml = setGraphicsController(xml, settings.graphicsController);
      applied.push(`Graphics Controller: ${settings.graphicsController}`);
    }

    if (settings.clipboardMode !== undefined) {
      xml = setClipboard(xml, settings.clipboardMode);
      applied.push(`Clipboard: ${settings.clipboardMode}`);
    }

    if (settings.dragAndDrop !== undefined) {
      xml = setDragAndDrop(xml, settings.dragAndDrop);
      applied.push(`Drag & Drop: ${settings.dragAndDrop}`);
    }

    if (settings.networkMode !== undefined) {
      xml = setNetwork(xml, {
        slot: 0,
        mode: settings.networkMode,
        internalNetworkName: settings.internalNetworkName
      });
      applied.push(`Network: ${settings.networkMode}`);
    }

    if (Array.isArray(settings.bootOrder) && settings.bootOrder.length > 0) {
      xml = setBootOrder(xml, settings.bootOrder);
      applied.push(`Boot Order: ${settings.bootOrder.join(' → ')}`);
    }

    if (settings.audioEnabled !== undefined) {
      xml = setAudio(xml, {
        enabled: settings.audioEnabled,
        controller: settings.audioController
      });
      applied.push(`Audio: ${settings.audioEnabled ? 'on' : 'off'}`);
    }

    if (settings.audioController !== undefined && settings.audioEnabled === undefined) {
      xml = setAudio(xml, { controller: settings.audioController });
      applied.push(`Audio Controller: ${settings.audioController}`);
    }

    if (settings.usbEnabled !== undefined) {
      xml = setUSB(xml, settings.usbEnabled);
      applied.push(`USB: ${settings.usbEnabled ? 'on' : 'off'}`);
    }

    if (settings.efiEnabled !== undefined) {
      xml = setFirmware(xml, settings.efiEnabled);
      applied.push(`Firmware: ${settings.efiEnabled ? 'EFI' : 'BIOS'}`);
    }

    if (settings.nestedVirtualization !== undefined) {
      xml = setNestedVirtualization(xml, settings.nestedVirtualization);
      applied.push(`Nested Virtualization: ${settings.nestedVirtualization ? 'on' : 'off'}`);
    }

    if (Array.isArray(settings.sharedFolders)) {
      xml = setSharedFolders(xml, settings.sharedFolders);
      applied.push(`Shared Folders: ${settings.sharedFolders.length} configured`);
    }

    // Save ExtraData preferences for integration modes
    if (settings.clipboardMode) {
      xml = setExtraData(xml, 'VMXposed/ClipboardMode', settings.clipboardMode);
    }
    if (settings.dragAndDrop) {
      xml = setExtraData(xml, 'VMXposed/DragAndDropMode', settings.dragAndDrop);
    }

    // Write the modified XML
    writeVboxXml(vboxFilePath, xml);

    logger.success('VBoxXmlEditor', `Applied ${applied.length} settings via XML: ${applied.join(', ')}`);
    return { success: true, applied, warnings, backupPath };
  } catch (err) {
    // If we have a backup, restore it
    if (backupPath && fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(backupPath, vboxFilePath);
        logger.warn('VBoxXmlEditor', `Restored backup after XML edit failure: ${err.message}`);
      } catch (restoreErr) {
        logger.error('VBoxXmlEditor', `CRITICAL: Failed to restore backup: ${restoreErr.message}`);
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Utility Helpers
// ---------------------------------------------------------------------------

function _escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _escapeXmlAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Safety checks
  isVBoxSVCActive,
  isVboxFileLocked,
  ensureSafeForXmlEdit,

  // File I/O
  backupVboxFile,
  readVboxXml,
  writeVboxXml,

  // Individual setting manipulation
  setMemory,
  setCPU,
  setDisplay,
  setGraphicsController,
  setClipboard,
  setDragAndDrop,
  setNetwork,
  setBootOrder,
  setUSB,
  setAudio,
  setFirmware,
  setNestedVirtualization,
  setExtraData,
  setSharedFolders,

  // Read settings
  readCurrentSettings,

  // High-level orchestrator
  applySettingsToXml
};
