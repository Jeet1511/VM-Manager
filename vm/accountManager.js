const virtualbox = require('../adapters/virtualbox');

function _quote(value) {
  return String(value || '').replace(/"/g, '\\"');
}

function _validateUsername(username, label = 'Username') {
  const value = String(username || '').trim();
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(value)) {
    throw new Error(`${label} contains invalid characters.`);
  }
  return value;
}

async function _ensureGuestAccountAccess(vmName, guestUser, guestPass) {
  const state = String(await virtualbox.getVMState(vmName) || '').toLowerCase();
  if (state !== 'running') {
    throw new Error(`Account management requires the V Os to be running. Current state: ${state || 'unknown'}.`);
  }

  const adminUser = String(guestUser || '').trim();
  if (!adminUser) {
    throw new Error('OS admin username is required.');
  }

  if (guestPass === undefined || guestPass === null || String(guestPass) === '') {
    throw new Error('OS admin password is required.');
  }
}

async function listUsers(vmName, guestUser, guestPass) {
  await _ensureGuestAccountAccess(vmName, guestUser, guestPass);

  const output = await virtualbox.guestShell(
    vmName,
    guestUser,
    guestPass,
    "cut -d: -f1 /etc/passwd",
    { timeout: 20000 }
  );

  const users = output
    .split(/\r?\n/)
    .map((u) => u.trim())
    .filter(Boolean);

  const detailsOutput = await virtualbox.guestShell(
    vmName,
    guestUser,
    guestPass,
    "cut -d: -f1,3,6,7 /etc/passwd",
    { timeout: 20000 }
  );

  const usersDetailed = detailsOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [username = '', uidRaw = '', home = '', shell = ''] = line.split(':');
      const uid = Number(uidRaw);
      return {
        username,
        uid: Number.isFinite(uid) ? uid : null,
        home,
        shell,
        type: Number.isFinite(uid) ? (uid >= 1000 ? 'human' : 'system') : 'unknown'
      };
    });

  return { success: true, users, usersDetailed };
}

async function createUser(vmName, guestUser, guestPass, username, password) {
  await _ensureGuestAccountAccess(vmName, guestUser, guestPass);

  const validatedUser = _validateUsername(username, 'New username');
  const safeUser = _quote(validatedUser);
  const safePass = _quote(password);

  const script = [
    `id ${safeUser} >/dev/null 2>&1 || sudo useradd -m -s /bin/bash ${safeUser}`,
    `echo '${safeUser}:${safePass}' | sudo chpasswd`,
    `sudo usermod -aG sudo ${safeUser} >/dev/null 2>&1 || true`,
    'echo done'
  ].join(' ; ');

  await virtualbox.guestShell(vmName, guestUser, guestPass, script, { timeout: 45000 });
  return { success: true, username: validatedUser };
}

async function updateCredentials(vmName, guestUser, guestPass, oldUsername, newUsername, newPassword) {
  await _ensureGuestAccountAccess(vmName, guestUser, guestPass);

  const validatedOld = _validateUsername(oldUsername, 'Target username');
  const validatedNew = newUsername ? _validateUsername(newUsername, 'New username') : validatedOld;
  const safeOld = _quote(validatedOld);
  const safeNew = _quote(validatedNew);
  const safePass = _quote(newPassword || '');

  const commands = [];
  if (validatedNew !== validatedOld) {
    commands.push(`sudo usermod -l ${safeNew} ${safeOld}`);
    commands.push(`sudo usermod -d /home/${safeNew} -m ${safeNew}`);
  }

  if (newPassword) {
    commands.push(`echo '${safeNew}:${safePass}' | sudo chpasswd`);
  }

  commands.push('echo done');

  await virtualbox.guestShell(vmName, guestUser, guestPass, commands.join(' ; '), { timeout: 60000 });
  return { success: true, username: validatedNew };
}

async function setAutoLogin(vmName, guestUser, guestPass, autologinUser) {
  await _ensureGuestAccountAccess(vmName, guestUser, guestPass);

  const validatedUser = _validateUsername(autologinUser, 'Auto-login username');
  const safeUser = _quote(validatedUser);
  const script = [
    'sudo mkdir -p /etc/gdm3',
    'sudo bash -c "cat > /etc/gdm3/custom.conf <<EOF\n[daemon]\nAutomaticLoginEnable=true\nAutomaticLogin=' + safeUser + '\nEOF"',
    'echo done'
  ].join(' ; ');

  await virtualbox.guestShell(vmName, guestUser, guestPass, script, { timeout: 30000 });
  return { success: true, autoLoginUser: validatedUser };
}

async function deleteUser(vmName, guestUser, guestPass, username) {
  await _ensureGuestAccountAccess(vmName, guestUser, guestPass);

  const validatedUser = _validateUsername(username, 'Delete username');
  const caller = String(guestUser || '').trim();
  if (validatedUser === 'root' || validatedUser === caller) {
    throw new Error('Refusing to delete root/current admin user.');
  }

  const knownUsers = await listUsers(vmName, guestUser, guestPass);
  if (!knownUsers?.success || !knownUsers.users.includes(validatedUser)) {
    throw new Error(`User "${validatedUser}" was not found.`);
  }

  const safeUser = _quote(validatedUser);
  const script = [
    `sudo pkill -KILL -u ${safeUser} 2>/dev/null || true`,
    `sudo userdel -r ${safeUser} 2>/dev/null || sudo deluser --remove-home ${safeUser}`,
    'echo done'
  ].join(' ; ');

  await virtualbox.guestShell(vmName, guestUser, guestPass, script, { timeout: 45000 });
  return { success: true, username: validatedUser };
}

module.exports = {
  listUsers,
  createUser,
  updateCredentials,
  setAutoLogin,
  deleteUser
};
