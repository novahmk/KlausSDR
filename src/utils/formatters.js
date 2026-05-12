/**
 * Build a horizontal separator
 * @param {number} len
 * @returns {string}
 */
function separator(len = 60) {
    return '═'.repeat(len);
}

module.exports = {
    separator
};
