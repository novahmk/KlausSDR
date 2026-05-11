/**
 * Structured Logger
 * Level-based logging with emoji indicators
 */

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

class Logger {
    _log(level, emoji, fn, message, data) {
        if (CURRENT_LEVEL >= LOG_LEVELS[level]) {
            fn(`\n${emoji} ${level.toUpperCase()}: ${message}`);
            if (data) fn(JSON.stringify(data, null, 2));
        }
    }

    error(message, data = null) {
        this._log('error', '❌', console.error, message, data);
    }

    warn(message, data = null) {
        this._log('warn', '⚠️', console.warn, message, data);
    }

    info(message, data = null) {
        this._log('info', '✅', console.log, message, data);
    }

    debug(message, data = null) {
        this._log('debug', '🔧', console.log, message, data);
    }
}

module.exports = new Logger();
