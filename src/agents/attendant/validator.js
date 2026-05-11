/**
 * Attendant Validator
 * Validates generated code quality before saving
 */

const { OpenAIMemory } = require('../../openai/memory');
const logger = require('../../config/logger');

const VALIDATION_CRITERIA = [
    'has explanatory JSDoc comments',
    'descriptive variable and function names',
    'max ~80 chars per line',
    'no obvious syntax errors',
    'module.exports or export present',
    'error handling included',
    'follows separation of concerns'
];

class Validator {
    constructor() {
        this.memory = new OpenAIMemory();
    }

    /**
     * Validate a generated code object
     * @param {Object} generated - { code, filename, language }
     * @returns {Object} { is_valid, score, strengths, issues, suggestions, approved }
     */
    async validate(generated) {
        if (!generated || !generated.code) {
            logger.warn('[Attendant.Validator] No code to validate');
            return {
                is_valid: false,
                score: 0,
                strengths: [],
                issues: ['No code provided'],
                suggestions: ['Generate code first'],
                approved: false
            };
        }

        logger.info(`[Attendant.Validator] Validating: ${generated.filename}`);

        const result = await this.memory.validateCode({
            code: generated.code,
            criteria: VALIDATION_CRITERIA,
            prompt: `
Validate the code strictly against criteria.
Return JSON: is_valid (bool), score (0-100),
strengths (array), issues (array),
suggestions (array), approved (bool),
feedback_for_attendant (string).
      `.trim()
        });

        const passed = result.score >= 60 && result.is_valid !== false;
        result.approved = passed;

        logger.info(
            `[Attendant.Validator] Score: ${result.score}/100 — ` +
            `${passed ? '✅ Approved' : '❌ Rejected'}`
        );

        return result;
    }

    /**
     * Quick static checks (no AI) before sending to OpenAI
     * @param {string} code
     * @returns {string[]} list of issues found
     */
    staticCheck(code) {
        const issues = [];
        if (!code.includes('module.exports') && !code.includes('export')) {
            issues.push('Missing module.exports or export');
        }
        if (!code.includes('/**') && !code.includes('//')) {
            issues.push('No comments found');
        }
        const longLines = code.split('\n').filter(l => l.length > 100);
        if (longLines.length > 5) {
            issues.push(`${longLines.length} lines exceed 100 chars`);
        }
        return issues;
    }
}

module.exports = Validator;
