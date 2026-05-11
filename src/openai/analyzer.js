/**
 * OpenAI Analyzer
 * Standalone analysis helpers for agents
 */

const { OpenAI } = require('openai');
const logger = require('../config/logger');

class Analyzer {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.model = 'gpt-4o';
    }

    /**
     * Identify patterns and blockers from Sheets data
     * @param {Object} data - { taskQueue, memoryBank }
     * @returns {Object} patterns and recommendations
     */
    async identifyPatterns(data) {
        logger.info('[Analyzer] Identifying patterns...');

        const completion = await this.openai.chat.completions.create({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: `You are a pattern recognition AI.
Identify recurring patterns, successful strategies, and common pitfalls.
Return JSON with: patterns (array), blockers (array), opportunities (array).`
                },
                {
                    role: 'user',
                    content: `Data to analyze:\n${JSON.stringify(data, null, 2)}`
                }
            ],
            temperature: 0.5,
            response_format: { type: 'json_object' }
        });

        return JSON.parse(completion.choices[0].message.content);
    }

    /**
     * Summarize analysis log entries
     * @param {Array} logEntries
     * @returns {string} summary
     */
    async summarizeLogs(logEntries) {
        logger.info('[Analyzer] Summarizing logs...');

        const completion = await this.openai.chat.completions.create({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: 'Summarize these log entries in 3 bullet points max.'
                },
                {
                    role: 'user',
                    content: JSON.stringify(logEntries)
                }
            ],
            temperature: 0.4,
            max_tokens: 300
        });

        return completion.choices[0].message.content;
    }
}

module.exports = new Analyzer();
