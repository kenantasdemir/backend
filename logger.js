const fs = require('fs');
const path = require('path');

class Logger {
  constructor(options = {}) {
    this.logFile = options.logFile || path.join(__dirname, 'server.log');
  }

  _log(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args
      .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : arg))
      .join(' ');
    const logLine = `[${timestamp}] [${level.toUpperCase()}]: ${message}\n`;

    // Log to console
    if (level === 'error') {
      console.error(logLine.trim());
    } else if (level === 'warn') {
      console.warn(logLine.trim());
    } else {
      console.log(logLine.trim());
    }

    // Append to file
    try {
      fs.appendFileSync(this.logFile, logLine);
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
  }

  info(...args) {
    this._log('info', ...args);
  }

  warn(...args) {
    this._log('warn', ...args);
  }

  error(...args) {
    this._log('error', ...args);
  }

  debug(...args) {
    this._log('debug', ...args);
  }
}

module.exports = {
  createLogger: (options) => new Logger(options),
};
