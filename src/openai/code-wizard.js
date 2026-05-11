/**
 * OpenAI Code Wizard
 * Generates high-quality, documented code via OpenAI
 */

const { OpenAI } = require('openai');
const logger = require('../config/logger');

const SYSTEM_PROMPT = `You are an expert Node.js developer.
Generate production-quality code following these standards:
- Google JavaScript Style Guide
- Meaningful variable and function names
- JSDoc comments on every function
- Max ~80 chars per line
- Separation of concerns (imports → constants → class → exports)
- Include error handling
- Provide usage examples in comments

Always return JSON with: code, filename, language, explanation, dependencies, tests.`;

class CodeWizard {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.model = 'gpt-4o';
    }

    /**
     * Generate code from a task spec + context
     * @param {Object} opts - { taskSpec, context, extraInstructions }
     * @returns {Object} { code, filename, language, explanation, dependencies, tests }
     */
    async generate({ taskSpec, context = [], extraInstructions = '' }) {
        logger.info(`[CodeWizard] Generating: ${taskSpec.title}`);

        const contextStr = context.length
            ? `\nRelevant context from Memory Bank:\n${context.map(c => c.details).join('\n')}`
            : '';

        const completion = await this.openai.chat.completions.create({
            model: this.model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: `
Task: ${taskSpec.title}
Description: ${taskSpec.description}

Acceptance Criteria:
${(taskSpec.acceptance_criteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}
${contextStr}
${extraInstructions}

Generate complete, working code. Return JSON.
          `.trim()
                }
            ],
            temperature: 0.7,
            response_format: { type: 'json_object' }
        });

        const result = JSON.parse(completion.choices[0].message.content);

        logger.info(`[CodeWizard] Generated ${result.filename} (${result.code?.length ?? 0} chars)`);

        return result;
    }

    /**
     * Improve existing code (add comments, fix style, add docs)
     * @param {string} code - original code
     * @param {string} improvements - what to improve
     * @returns {string} improved code
     */
    async improve(code, improvements = 'add JSDoc comments and improve readability') {
        logger.info('[CodeWizard] Improving code...');

        const completion = await this.openai.chat.completions.create({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: 'You are a code quality specialist. Return only the improved code, no explanations.'
                },
                {
                    role: 'user',
                    content: `Improve this code — ${improvements}:\n\n\`\`\`javascript\n${code}\n\`\`\``
                }
            ],
            temperature: 0.4
        });

        return completion.choices[0].message.content
            .replace(/```javascript\n?/g, '')
            .replace(/```\n?/g, '')
            .trim();
    }
}

module.exports = new CodeWizard();
