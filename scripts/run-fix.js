const fs = require('fs');

let code = fs.readFileSync('renderer/components/dashboard.js', 'utf8');

const replacement = `_renderVMCard(vm) {
    const id = vm.uuid.substring(0, 8);
    const osLower = (vm.os || '').toLowerCase();

    let osColor = '#e6edf3';
    let dsOsIcon = Icons.monitor;
    if (osLower.includes('ubuntu')) { osColor = '#E95420'; }
    else if (osLower.includes('windows')) { osColor = '#0078D6'; }
    else if (osLower.includes('debian')) { osColor = '#D70A53'; }
    else if (osLower.includes('kali')) { osColor = '#557C94'; }
    else if (osLower.includes('arch')) { osColor = '#1793D1'; }
    else if (osLower.includes('mac') || osLower.includes('darwin')) { osColor = '#ffffff'; }
    else if (osLower.includes('linux')) { osColor = '#f5c400'; }

    const isRunning = vm.state === 'running';
    const isPaused = vm.state === 'paused';
    const isStopped = !isRunning && !isPaused;

    const stateLabel = isRunning ? 'Running' : isPaused ? 'Paused' : 'Powered Off';
    const stateClass = isRunning ? 'state-running' : isPaused ? 'state-paused' : 'state-stopped';
    const osLabel = (vm.os || 'Unknown').replace(/_/g, ' ');

    const featureBadges = [
      { label: 'Clipboard', on: (vm.clipboard || '').toLowerCase() !== 'disabled' },
      { label: 'Drag&Drop', on: (vm.draganddrop || '').toLowerCase() !== 'disabled' },
      { label: 'Audio', on: !!vm.audioEnabled },
      { label: 'USB', on: !!vm.usbEnabled },
      { label: '3D', on: !!vm.accelerate3d },
      { label: 'EFI', on: !!vm.efiEnabled },
      { label: 'Nested VT', on: !!vm.nestedVirtualization }
    ];

    return \`
      <div class="vm-card \${stateClass}" style="border-top: 3px solid \${osColor}">
        <div class="vm-card-header">
          <div class="vm-card-icon" style="color: \${osColor};">\${Icons.sized(dsOsIcon, 32)}</div>
          <div class="vm-card-title-group">
            <div class="vm-card-name">\${vm.name}</div>
            <div class="vm-card-os">\${osLabel}</div>
          </div>
          <div class="vm-card-state">
            <span class="state-dot \${stateClass}"></span>
            <span class="state-text">\${stateLabel}</span>
          </div>
          <div class="vm-menu-wrap">
            <button class="btn btn-sm btn-ghost btn-icon vm-menu-btn" id="vm-menu-btn-\${id}" title="More actions">
              \${Icons.sized(Icons.moreVertical, 16)}
            </button>
            <div class="vm-action-menu" id="vm-menu-\${id}">
               <button class="vm-menu-item" id="vm-menu-rename-\${id}">\${Icons.sized(Icons.edit, 14)} Rename</button>
               <button class="vm-menu-item" id="vm-menu-settings-\${id}">\${Icons.sized(Icons.settings, 14)} Settings</button>
               <button class="vm-menu-item" id="vm-menu-clone-\${id}">\${Icons.sized(Icons.copy, 14)} Clone</button>
               <button class="vm-menu-item" id="vm-menu-folder-\${id}">\${Icons.sized(Icons.folder, 14)} Open Folder</button>
               <button class="vm-menu-item danger" id="vm-menu-delete-\${id}">\${Icons.sized(Icons.trash, 14)} Delete</button>
            </div>
          </div>
        </div>

        <div class="vm-card-specs">
          <div class="vm-spec" title="Memory">\${Icons.sized(Icons.memory, 14)} <span><strong>RAM</strong> \${vm.ram} MB</span></div>
          <div class="vm-spec" title="Processor">\${Icons.sized(Icons.cpu, 14)} <span><strong>CPU</strong> \${vm.cpus} Core\${vm.cpus > 1 ? 's' : ''}</span></div>
          <div class="vm-spec" title="Video Memory">\${Icons.sized(Icons.monitor, 14)} <span><strong>VRAM</strong> \${vm.vram} MB</span></div>
          <div class="vm-spec" title="Network Mode">\${Icons.sized(Icons.globe, 14)} <span><strong>NET</strong> \${vm.network}</span></div>
        </div>

        <div class="vm-feature-badges">
           \${\nfeatureBadges.map(f => \`<span class="vm-feature-badge \${f.on ? 'on' : 'off'}">\${f.label}: \${f.on ? 'ON' : 'OFF'}</span>\`).join('')\n}
        </div>

        <div class="vm-card-controls">
          \${isStopped ? \`
            <button class="btn btn-sm btn-success btn-icon-text" id="vm-start-\${id}" title="Start VM">
              \${Icons.sized(Icons.play, 14)} Start
            </button>
          \` : ''}
          \${isRunning ? \`
            <button class="btn btn-sm btn-warn btn-icon-text" id="vm-pause-\${id}" title="Pause VM">
              \${Icons.sized(Icons.pause, 14)} Pause
            </button>
            <button class="btn btn-sm btn-danger btn-icon-text" id="vm-stop-\${id}" title="Stop VM">
              \${Icons.sized(Icons.power, 14)} Stop
            </button>
          \` : ''}
          \${isPaused ? \`
            <button class="btn btn-sm btn-success btn-icon-text" id="vm-pause-\${id}" title="Resume VM">
              \${Icons.sized(Icons.play, 14)} Resume
            </button>
            <button class="btn btn-sm btn-danger btn-icon-text" id="vm-stop-\${id}" title="Force Stop">
              \${Icons.sized(Icons.power, 14)} Stop
            </button>
          \` : ''}
          <button class="btn btn-sm btn-secondary btn-icon-text" id="vm-edit-\${id}" title="Edit VM Settings">
            \${Icons.sized(Icons.settings, 14)} Edit
          </button>
          <button class="btn btn-sm btn-ghost btn-icon-text" id="vm-bootfix-\${id}" title="Diagnose and fix boot issues">
            \${Icons.sized(Icons.wrench, 14)} Boot Fix
          </button>
          <button class="btn btn-sm btn-ghost btn-icon-text" id="vm-users-\${id}" title="Manage guest users">
            \${Icons.sized(Icons.user, 14)} Accounts
          </button>
        </div>
      </div>
    \`;
  },`;

code = code.replace(/_renderVMCard\(vm\) \{[\s\S]*?(?=  _openCloneModal)/, replacement + '\n\n');

code = code.replace(/overlay\.onclick = close;/g, 
  "overlay.onclick = close;\n    const escHandler = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } };\n    document.addEventListener('keydown', escHandler);");

fs.writeFileSync('renderer/components/dashboard.js', code);
console.log('Fixed dashboard.js!');
