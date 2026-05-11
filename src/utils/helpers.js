/**
 * Helpers
 * General-purpose helper utilities
 */

/**
 * Sleep for a given number of milliseconds
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry an async function up to N times with delay
 * @param {Function} fn - async function to retry
 * @param {number} retries - max attempts (default 3)
 * @param {number} delayMs - delay between retries (default 2000)
 * @returns {Promise<*>}
 */
async function retry(fn, retries = 3, delayMs = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === retries) throw err;
            console.warn(`\n⚠️ Attempt ${attempt}/${retries} failed: ${err.message}`);
            await sleep(delayMs);
        }
    }
}

/**
 * Generate a short unique ID
 * @param {string} prefix
 * @returns {string}
 */
function uid(prefix = 'id') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Safely JSON parse with a fallback
 * @param {string} str
 * @param {*} fallback
 * @returns {*}
 */
function safeParse(str, fallback = {}) {
    try {
        return JSON.parse(str);
    } catch {
        return fallback;
    }
}

/**
 * Calculate minutes elapsed since a timestamp
 * @param {string|Date} since
 * @returns {number}
 */
function elapsedMinutes(since) {
    return Math.round((Date.now() - new Date(since).getTime()) / 60000);
}

module.exports = {
    sleep,
    retry,
    uid,
    safeParse,
    elapsedMinutes
};
