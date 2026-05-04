const VALID_PHASES = new Set(['preinstall', 'installing', 'postinstall', 'ready', 'degraded']);

function normalizePhase(value = '') {
  const phase = String(value || '').trim().toLowerCase();
  if (VALID_PHASES.has(phase)) return phase;
  return 'preinstall';
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = String(value || '').trim().toLowerCase();
  if (!text) return !!fallback;
  if (['on', 'true', 'yes', '1'].includes(text)) return true;
  if (['off', 'false', 'no', '0'].includes(text)) return false;
  return !!fallback;
}

function normalizeIntegrationReady(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    ga: toBool(source.ga, false),
    clipboard: toBool(source.clipboard, false),
    display: toBool(source.display, false)
  };
}

function createVmState(partial = {}) {
  const source = partial && typeof partial === 'object' ? partial : {};
  return {
    phase: normalizePhase(source.phase),
    installConfirmed: toBool(source.installConfirmed, false),
    bootSource: ['iso', 'disk'].includes(String(source.bootSource || '').toLowerCase())
      ? String(source.bootSource || '').toLowerCase()
      : 'iso',
    isoAttached: toBool(source.isoAttached, true),
    guestReady: toBool(source.guestReady, false),
    integrationReady: normalizeIntegrationReady(source.integrationReady),
    lastError: source.lastError ? String(source.lastError) : null,
    rebootCount: Math.max(0, parseInt(source.rebootCount, 10) || 0)
  };
}

function detectStorageFacts(info = {}) {
  const values = Object.values(info || {}).filter((v) => typeof v === 'string');
  const hasBootableDisk = values.some((value) => /\.(vdi|vmdk|vhd|qcow2)$/i.test(String(value || '')));
  const hasBootableIso = values.some((value) => /\.(iso|viso)$/i.test(String(value || '')));
  const boot1 = String(info.boot1 || '').trim().toLowerCase();
  const bootSource = boot1 === 'disk' ? 'disk' : 'iso';

  const gaRunLevel = parseInt(info.GuestAdditionsRunLevel || '0', 10) || 0;
  const guestAgentReachable = !!info.GuestAdditionsVersion && gaRunLevel >= 2;

  return {
    hasBootableDisk,
    hasBootableIso,
    bootSource,
    guestAgentReachable
  };
}

function buildInstallEvidence(info = {}, extras = {}) {
  const storage = detectStorageFacts(info);
  const markerPresent = toBool(extras.markerPresent, false) || toBool(extras.installedDiskReady, false);
  const installConfirmed = storage.hasBootableDisk && (storage.guestAgentReachable || markerPresent);

  return {
    hasBootableDisk: storage.hasBootableDisk,
    hasBootableIso: storage.hasBootableIso,
    guestAgentReachable: storage.guestAgentReachable,
    markerPresent,
    installConfirmed,
    bootSource: storage.bootSource
  };
}

function buildVmStateFromLegacy(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const info = source.info || {};
  const extras = source.extras || {};
  const evidence = buildInstallEvidence(info, extras);

  const configuredPhase = normalizePhase(extras.installPhase || '');
  let phase = configuredPhase;
  if (!phase || phase === 'preinstall') {
    if (evidence.installConfirmed && evidence.guestAgentReachable) {
      phase = 'ready';
    } else if (evidence.installConfirmed) {
      phase = 'postinstall';
    } else if (toBool(extras.unattendedApplied, false) || toBool(extras.manualInstallRequired, false)) {
      phase = 'installing';
    } else {
      phase = 'preinstall';
    }
  }

  return createVmState({
    phase,
    installConfirmed: evidence.installConfirmed,
    bootSource: evidence.bootSource,
    isoAttached: evidence.hasBootableIso,
    guestReady: evidence.guestAgentReachable,
    integrationReady: {
      ga: evidence.guestAgentReachable,
      clipboard: evidence.guestAgentReachable,
      display: evidence.guestAgentReachable
    },
    lastError: source.lastError || null,
    rebootCount: source.rebootCount || 0
  });
}

function decideBoot(vmState = {}, liveFacts = {}) {
  const state = createVmState(vmState);
  const facts = liveFacts && typeof liveFacts === 'object' ? liveFacts : {};
  const hasBootableDisk = toBool(facts.hasBootableDisk, false);
  const hasBootableIso = toBool(facts.hasBootableIso, false);
  const manualInstallRequired = toBool(facts.manualInstallRequired, false);

  if (state.installConfirmed || state.phase === 'postinstall' || state.phase === 'ready') {
    return {
      mode: 'disk-first',
      bootOrder: ['disk', 'dvd', 'none', 'none'],
      attachISO: false,
      ejectISO: true,
      reason: 'Installed OS confirmed'
    };
  }

  if (state.phase === 'installing' || state.phase === 'preinstall') {
    const diskPreferredDuringInstall = hasBootableDisk && (
      manualInstallRequired
      || state.bootSource === 'disk'
      || state.rebootCount > 0
    );
    if (diskPreferredDuringInstall) {
      return {
        mode: 'install-disk-preferred',
        bootOrder: ['disk', 'dvd', 'none', 'none'],
        attachISO: !hasBootableIso,
        ejectISO: false,
        reason: 'Install phase with disk-first fallback'
      };
    }
    return {
      mode: 'install-from-iso',
      bootOrder: ['dvd', 'disk', 'none', 'none'],
      attachISO: !hasBootableIso,
      ejectISO: false,
      reason: 'Install phase active'
    };
  }

  if (!hasBootableIso && hasBootableDisk) {
    return {
      mode: 'recovery-disk',
      bootOrder: ['disk', 'dvd', 'none', 'none'],
      attachISO: false,
      ejectISO: false,
      reason: 'ISO missing, disk available'
    };
  }

  return {
    mode: 'recovery',
    bootOrder: ['disk', 'dvd', 'none', 'none'],
    attachISO: false,
    ejectISO: false,
    reason: 'Inconsistent state'
  };
}

module.exports = {
  VALID_PHASES,
  createVmState,
  normalizePhase,
  detectStorageFacts,
  buildInstallEvidence,
  buildVmStateFromLegacy,
  decideBoot
};
