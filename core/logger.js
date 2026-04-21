/**
 * core/logger.js — Structured Logging System
 * 
 * Design Decision: Every operation is logged to both file and the UI.
 * The user sees everything happening — full transparency.
 * Logs are rotated to prevent disk bloat (max 5 files, 5MB each).
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getLogDir } = require('./config');

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SUCCESS: 4
};

const LOG_LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'SUCCESS'];

const MAX_LOG_SIZE = 5 * 1024 * 1024;  // 5 MB per log file
const MAX_LOG_FILES = 5;               // Keep 5 rotated files

class Logger extends EventEmitter {
  constructor() {
    super();
    this.logDir = getLogDir();
    this.logFile = null;
    this.currentSize = 0;
    this.minLevel = LOG_LEVELS.DEBUG;
    this._initialized = false;
  }

  /**
   * Initialize the logger — creates log directory and opens log file.
   * Called once at app startup.
   */
  async init() {
    if (this._initialized) return;

    try {
      await fs.promises.mkdir(this.logDir, { recursive: true });
      this._rotateIfNeeded();
      this._initialized = true;
      this.info('Logger', 'Logging system initialized');
    } catch (err) {
      // Fallback: log to console only if file system fails
      console.error('Failed to initialize logger:', err.message);
      this._initialized = true;
    }
  }

  /**
   * Get the current log file path, generating a timestamped name.
   */
  _getLogFilePath() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `vm-installer-${date}.log`);
  }

  /**
   * Return the current log file path.
   */
  getCurrentLogFilePath() {
    if (!this.logFile) {
      this._rotateIfNeeded();
    }
    return this.logFile;
  }

  /**
   * Ensure the current log file exists on disk.
   */
  ensureLogFile() {
    const logPath = this.getCurrentLogFilePath();
    if (!logPath) return null;

    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      if (!fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, '');
      }
      return logPath;
    } catch {
      return null;
    }
  }

  /**
   * Rotate log files if current file exceeds max size.
   */
  _rotateIfNeeded() {
    const logPath = this._getLogFilePath();

    try {
      if (fs.existsSync(logPath)) {
        const stats = fs.statSync(logPath);
        this.currentSize = stats.size;

        if (this.currentSize >= MAX_LOG_SIZE) {
          // Rotate: rename current to .1, .1 to .2, etc.
          for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
            const from = `${logPath}.${i}`;
            const to = `${logPath}.${i + 1}`;
            if (fs.existsSync(from)) {
              if (i === MAX_LOG_FILES - 1) {
                fs.unlinkSync(from);  // Delete oldest
              } else {
                fs.renameSync(from, to);
              }
            }
          }
          fs.renameSync(logPath, `${logPath}.1`);
          this.currentSize = 0;
        }
      }
    } catch (err) {
      console.error('Log rotation failed:', err.message);
    }

    this.logFile = logPath;
  }

  /**
   * Write a log entry to file and emit to UI.
   * 
   * @param {string} level - Log level (DEBUG, INFO, WARN, ERROR, SUCCESS)
   * @param {string} module - Which module is logging (e.g., 'Orchestrator', 'Download')
   * @param {string} message - Human-readable log message
   * @param {object} [data] - Optional structured data
   */
  _log(level, module, message, data = null) {
    if (LOG_LEVELS[level] < this.minLevel) return;

    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      module,
      message,
      ...(data ? { data } : {})
    };

    // Format for file output
    const fileLine = `[${timestamp}] [${level.padEnd(7)}] [${module}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}\n`;

    // Write to file (non-blocking)
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, fileLine);
        this.currentSize += Buffer.byteLength(fileLine);
        this._rotateIfNeeded();
      } catch (err) {
        // Silent fail on file write — don't crash the app
      }
    }

    // Always log to console for development
    const consoleMethod = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
    console[consoleMethod](`[${level}] [${module}] ${message}`);

    // Emit to UI so the user sees everything
    this.emit('log', entry);
  }

  // ─── Convenience methods ──────────────────────────────────────────────

  debug(module, message, data) { this._log('DEBUG', module, message, data); }
  info(module, message, data) { this._log('INFO', module, message, data); }
  warn(module, message, data) { this._log('WARN', module, message, data); }
  error(module, message, data) { this._log('ERROR', module, message, data); }
  success(module, message, data) { this._log('SUCCESS', module, message, data); }
}

// Singleton instance — shared across all modules
const logger = new Logger();

module.exports = logger;
