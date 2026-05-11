/**
 * Formatters
 * Utility functions for formatting code, text, and data
 */

/**
 * Convert a string to camelCase filename
 * @param {string} title
 * @returns {string} e.g. 'createUserAuth.js'
 */
function toCamelFilename(title) {
    const camel = title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .split(/\s+/)
        .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
        .join('');
    return `${camel}.js`;
}

/**
 * Format a Date to a human-readable string
 * @param {Date|string} date
 * @returns {string} e.g. '2026-05-08 21:30'
 */
function formatDate(date) {
    const d = new Date(date);
    return `${d.toISOString().split('T')[0]} ${d.toTimeString().slice(0, 5)}`;
}

/**
 * Truncate a string with ellipsis
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen = 80) {
    if (!str) return '';
    return str.length <= maxLen ? str : str.slice(0, maxLen - 3) + '...';
}

/**
 * Pretty-print a JSON object
 * @param {Object} obj
 * @returns {string}
 */
function prettyJSON(obj) {
    try {
        return JSON.stringify(obj, null, 2);
    } catch {
        return String(obj);
    }
}

/**
 * Build a horizontal separator
 * @param {number} len
 * @returns {string}
 */
function separator(len = 60) {
    return '═'.repeat(len);
}

module.exports = {
    toCamelFilename,
    formatDate,
    truncate,
    prettyJSON,
    separator
};
