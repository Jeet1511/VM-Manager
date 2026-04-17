/**
 * vm/sharedFolder.js — Shared Folder Automation
 * 
 * Design Decision: Shared folders are added via VBoxManage with auto-mount.
 * The cloud-init config adds the user to the 'vboxsf' group so they can
 * access the shared folder inside the VM without manual steps.
 * 
 * Auto-mount ensures the folder is available every time the VM boots.
 */

const logger = require('../core/logger');
const virtualbox = require('../adapters/virtualbox');
const fs = require('fs');

/**
 * Set up a shared folder between host and guest VM.
 * 
 * @param {string} vmName - VM name
 * @param {string} hostPath - Absolute path on the host machine
 * @param {string} [shareName='shared'] - Name of the share (visible inside guest)
 * @returns {Promise<object>} Setup result with share details
 */
async function setupSharedFolder(vmName, hostPath, shareName = 'shared') {
  logger.info('SharedFolder', `Setting up shared folder for "${vmName}"`);
  logger.info('SharedFolder', `Host path: ${hostPath}`);
  logger.info('SharedFolder', `Share name: ${shareName}`);

  // Validate host path exists
  if (!fs.existsSync(hostPath)) {
    logger.warn('SharedFolder', `Host path does not exist, creating: ${hostPath}`);
    await fs.promises.mkdir(hostPath, { recursive: true });
    logger.success('SharedFolder', `Created host directory: ${hostPath}`);
  }

  try {
    // Add shared folder with auto-mount enabled
    await virtualbox.addSharedFolder(vmName, shareName, hostPath, true);

    const result = {
      shareName,
      hostPath,
      guestMountPoint: `/media/sf_${shareName}`,
      autoMount: true,
      persistent: true
    };

    logger.success('SharedFolder', `Shared folder configured successfully`);
    logger.info('SharedFolder', `Inside VM, access at: ${result.guestMountPoint}`);

    return result;

  } catch (err) {
    // If folder already exists, remove and re-add
    if (err.message.includes('already exists')) {
      logger.warn('SharedFolder', 'Shared folder already exists, replacing...');

      try {
        await virtualbox._run(['sharedfolder', 'remove', vmName, '--name', shareName]);
        await virtualbox.addSharedFolder(vmName, shareName, hostPath, true);

        logger.success('SharedFolder', 'Shared folder replaced successfully');
        return {
          shareName,
          hostPath,
          guestMountPoint: `/media/sf_${shareName}`,
          autoMount: true,
          persistent: true
        };
      } catch (replaceErr) {
        logger.error('SharedFolder', `Failed to replace shared folder: ${replaceErr.message}`);
        throw replaceErr;
      }
    }

    logger.error('SharedFolder', `Failed to setup shared folder: ${err.message}`);
    throw err;
  }
}

module.exports = { setupSharedFolder };
