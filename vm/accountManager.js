const virtualbox = require('../adapters/virtualbox');

function _quote(value) {
  return String(value || '').replace(/"/g, '\\"');
}

async function listUsers(vmName, guestUser, guestPass) {
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

  return { success: true, users };
}

async function createUser(vmName, guestUser, guestPass, username, password) {
  const safeUser = _quote(username);
  const safePass = _quote(password);

  const script = [
    `id ${safeUser} >/dev/null 2>&1 || sudo useradd -m -s /bin/bash ${safeUser}`,
    `echo '${safeUser}:${safePass}' | sudo chpasswd`,
    `sudo usermod -aG sudo ${safeUser} >/dev/null 2>&1 || true`,
    'echo done'
  ].join(' ; ');

  await virtualbox.guestShell(vmName, guestUser, guestPass, script, { timeout: 45000 });
  return { success: true, username };
}

async function updateCredentials(vmName, guestUser, guestPass, oldUsername, newUsername, newPassword) {
  const safeOld = _quote(oldUsername);
  const safeNew = _quote(newUsername || oldUsername);
  const safePass = _quote(newPassword || '');

  const commands = [];
  if (newUsername && newUsername !== oldUsername) {
    commands.push(`sudo usermod -l ${safeNew} ${safeOld}`);
    commands.push(`sudo usermod -d /home/${safeNew} -m ${safeNew}`);
  }

  if (newPassword) {
    commands.push(`echo '${safeNew}:${safePass}' | sudo chpasswd`);
  }

  commands.push('echo done');

  await virtualbox.guestShell(vmName, guestUser, guestPass, commands.join(' ; '), { timeout: 60000 });
  return { success: true, username: newUsername || oldUsername };
}

async function setAutoLogin(vmName, guestUser, guestPass, autologinUser) {
  const safeUser = _quote(autologinUser);
  const script = [
    'sudo mkdir -p /etc/gdm3',
    'sudo bash -c "cat > /etc/gdm3/custom.conf <<EOF\n[daemon]\nAutomaticLoginEnable=true\nAutomaticLogin=' + safeUser + '\nEOF"',
    'echo done'
  ].join(' ; ');

  await virtualbox.guestShell(vmName, guestUser, guestPass, script, { timeout: 30000 });
  return { success: true, autoLoginUser: autologinUser };
}

module.exports = {
  listUsers,
  createUser,
  updateCredentials,
  setAutoLogin
};
