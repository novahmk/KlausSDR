/**
 * Attendant Code Generator
 * Uses CodeWizard to produce high-quality, documented code
 */

const codeWizard = require('../../openai/code-wizard');
const logger = require('../../config/logger');

class CodeGenerator {
    /**
     * Generate code from task spec using Code Wizard
     * Adds header comment and formats output
     * @param {Object} opts - { taskSpec, context }
     * @returns {Object} { code, filename, language, explanation, dependencies }
     */
    async generate({ taskSpec, context = [] }) {
        logger.info(`[Attendant.CodeGenerator] Generating: ${taskSpec.title}`);

        // Generate via OpenAI Code Wizard
        const result = await codeWizard.generate({ taskSpec, context });

        // Prepend header comment block
        const header = this._buildHeader(taskSpec);
        result.code = header + '\n' + (result.code || '');

        // Normalize filename
        if (!result.filename) {
            result.filename = this._toFilename(taskSpec.title);
        }

        logger.info(`[Attendant.CodeGenerator] Done: ${result.filename}`);
        return result;
    }

    /**
     * Build a JSDoc file header
     * @param {Object} taskSpec
     * @returns {string}
     */
    _buildHeader(taskSpec) {
        const criteria = (taskSpec.acceptance_criteria || [])
            .map(c => ` * - ${c}`)
            .join('\n');

        return `/**
 * ${taskSpec.title}
 *
 * Description: ${taskSpec.description}
 * Scope: ${taskSpec.scope || 'medium'}
 * Priority: ${taskSpec.priority || 'medium'}
 *
 * Acceptance Criteria:
${criteria || ' * (none specified)'}
 *
 * Generated: ${new Date().toISOString()}
 */`;
    }

    /**
     * Convert task title to a camelCase filename
     * @param {string} title
     * @returns {string} e.g. 'createUserAuth.js'
     */
    _toFilename(title) {
        const camel = title
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .trim()
            .split(/\s+/)
            .map((w, i) => i === 0 ? w : w[0].toUpperCase() + w.slice(1))
            .join('');
        return `${camel}.js`;
    }
}

module.exports = CodeGenerator;
