/**
 * Validators
 * Input/structure validation utilities
 */

/**
 * Check all required env vars are set
 * @param {string[]} vars
 * @throws {Error} if any are missing
 */
function validateEnv(vars) {
    const missing = vars.filter(v => !process.env[v]);
    if (missing.length) {
        throw new Error(`Missing env vars: ${missing.join(', ')}`);
    }
}

/**
 * Validate a task spec object has required fields
 * @param {Object} spec
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateTaskSpec(spec) {
    const required = ['title', 'description', 'priority'];
    const errors = required.filter(k => !spec[k]).map(k => `Missing: ${k}`);
    return { valid: errors.length === 0, errors };
}

/**
 * Validate a generated code object
 * @param {Object} generated
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateGenerated(generated) {
    const errors = [];
    if (!generated) { return { valid: false, errors: ['No generated object'] }; }
    if (!generated.code) errors.push('Missing: code');
    if (!generated.filename) errors.push('Missing: filename');
    if (!generated.language) errors.push('Missing: language');
    return { valid: errors.length === 0, errors };
}

/**
 * Check that a string is valid JSON
 * @param {string} str
 * @returns {boolean}
 */
function isValidJSON(str) {
    try {
        JSON.parse(str);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    validateEnv,
    validateTaskSpec,
    validateGenerated,
    isValidJSON
};
