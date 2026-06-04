# VM Xposed - Session Context and Memory Backup
**Date & Time:** May 30, 2026 (7:39 PM)
**App Version:** 1.1.31
**Conversation ID:** 8a6795b5-c81d-4c15-9d85-207e804c561a

---

## 1. High-Level Goal & Requirements

The primary objective is to make **VM Xposed** a world-class Virtual Machine manager.
Specifically, the user wants the ability to edit and control VM configuration details **via direct file modifications** rather than relying solely on the `VBoxManage` CLI.

### Core Targets:
- **Guest Display / Fullscreen**: Configure guest display resolutions, monitor counts, and full-screen preferences perfectly via file edits.
- **Integration Features**: Set bidirectional clipboard (`clipboardMode`) and drag-and-drop (`dragAndDrop`) modes.
- **Hardware Modifications**: Control settings like RAM, CPU, VRAM, Graphics Controller type, network configuration, boot order, USB controller, audio configurations, and shared folders.
- **XML-Based Modification**: Directly modify `.vbox` XML files (per-VM configuration) and global files (`VirtualBox.xml` if needed) to ensure settings apply seamlessly.

---

## 2. Codebase Architecture Summary

### Project Structure:
- **`main.js`**: Defines the Electron main process, IPC routes, window lifecycle, and manages background tasks. Key IPC handlers:
  - `vm:edit` (lines 4498–4816)
  - `vm:getDetails` (lines 4818–4887)
  - `vm:rename` (lines 4889–4896)
  - `vm:clone` (lines 4898–4900)
- **`preload.js`**: Exposes secure API bridges between the Electron main process and the React/HTML renderer.
- **`adapters/virtualbox.js`**: Interacts with the VirtualBox command-line interface (`VBoxManage`).
- **`core/orchestrator.js`**: Manages installation, state checks, and general orchestration.
- **`vm/`**:
  - `vmManager.js`: VM lifecycle management.
  - `cloudInit.js`: Automation scripts and installers.
  - `guestAdditions.js`: Controls automated installation of VirtualBox Guest Additions.
  - `sharedFolder.js`: Mounting and mapping host directories inside VMs.
- **`Patch notes/`**: Latest notes are in [patch-v1.1.31.txt](file:///c:/Users/Jeet/Documents/Github/VM-Manager/Patch%20notes/patch-v1.1.31.txt), addressing PendingFileRenameOperations false positives and keyboard automation rewrites.

---

## 3. Analysis of the `vm:edit` Channel in `main.js`

The current implementation of `vm:edit` relies on:
1. **State Checks**: If VM is running, hardware settings edits are rejected.
2. **CLI Invocation**: Constructs a CLI command array `['modifyvm', vmName, ...]` and runs `virtualbox._run(args)`.
3. **Runtime Integrations**: Applies clipboard and drag-and-drop settings dynamically for active VMs using `virtualbox.applyRuntimeIntegration` and `scheduleDeferredRuntimeIntegration`.

To support **direct file edits**, we will update or extend this handler to parse the XML configuration of the VM's `.vbox` file directly, make the required tag and attribute changes, and save the XML back to disk.

---

## 4. VirtualBox XML File Structure (.vbox)

A `.vbox` file is an XML document representing the machine configuration. Key paths and elements include:

* **XML Schema Namespace**: Looks like `xmlns="http://www.virtualbox.org/VirtualBox/Machine"`
* **Root Element**: `<VirtualBox ...>` containing a `<Machine>` child element.
* **Metadata/ExtraData**: 
  ```xml
  <ExtraData>
    <ExtraDataItem name="VMXposed/ClipboardMode" value="Bidirectional"/>
    <ExtraDataItem name="VMXposed/DragAndDropMode" value="Bidirectional"/>
  </ExtraData>
  ```
* **Hardware settings**:
  ```xml
  <Hardware>
    <CPU count="4"/>
    <Memory Size="4096"/>
    <Display VRAMSize="128" monitorCount="1" accelerate3D="true"/>
    <GraphicsController type="VMSVGA"/>
    <BIOS>
      <IOAPIC enabled="true"/>
      <Boot>
        <Order position="1" device="HardDisk"/>
        <Order position="2" device="DVD"/>
      </Boot>
    </BIOS>
    <Network>
      <Adapter slot="0" enabled="true" type="82540EM">
        <NAT/>
      </Adapter>
    </Network>
    <Clipboard mode="Bidirectional"/>
    <DragAndDrop mode="Bidirectional"/>
  </Hardware>
  ```

---

## 5. Synchronization & Locking Challenges

VirtualBox maintains a background service called `VBoxSVC` which caches configurations and holds lock file handles.
* **Challenge**: If a file-based edit is performed while `VBoxSVC` is active, it may overwrite the `.vbox` file upon exit, discarding manual file edits.
* **Solutions**:
  1. **Processes**: Check if the VM or VBoxSVC is active before modifying.
  2. **VBoxManage Integration**: Use direct file modification when the VM is powered down and VBoxSVC can be briefly released/bypassed, or coordinate direct file updates with VBoxManage where appropriate.

---

## 6. Active Research & Subagents

* **Research Subagent**: `2d05eefe-4a0a-414f-b251-5e23f13d11f0`
* **Role**: VBox XML format researcher.
* **Logs location**: [transcript.jsonl](file:///C:/Users/Jeet/.gemini/antigravity/brain/2d05eefe-4a0a-414f-b251-5e23f13d11f0/.system_generated/logs/transcript.jsonl)
* **Goal**: Document exact XML mapping elements for clipboard, drag-and-drop, fullscreen preferences, resolution, and hardware properties, and outline global VirtualBox configuration profiles (`VirtualBox.xml`).

---
*This file was created automatically by Antigravity to preserve complete context and memory.*
