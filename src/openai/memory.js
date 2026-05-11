/**
 * OpenAI Memory System
 * Generative memory that learns and improves each cycle
 */

const { OpenAI } = require('openai');
const memoryBank = require('../sheets/memory-bank');
const analysisLog = require('../sheets/analysis-log');
const logger = require('../config/logger');
const { MEMORY_CATEGORY, AGENTS } = require('../config/constants');

class OpenAIMemory {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.model = 'gpt-4o';
    }

    /**
     * Analyze full project context from Sheets data
     * @param {Object} ctx - { taskQueue, codeRepo, memoryBank, performance, prompt }
     * @returns {Object} structured analysis result
     */
    async analyzeContext({ taskQueue, codeRepo, memoryBank: mb, performance, prompt }) {
        logger.info('[Memory] Analyzing full context...');

        const contextStr = this._buildContextString({
            taskQueue,
            codeRepo,
            memoryBank: mb,
            performance
        });

        const completion = await this.openai.chat.completions.create({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: `You are a senior engineering manager AI.
Analyze the provided project context (Google Sheets data) and return
a structured JSON analysis.
Always return valid JSON with keys: discoveries, recommendations, confidence,
next_priority_task, blockers.`
                },
                { role: 'user', content: `${contextStr}\n\n${prompt}` }
            ],
            temperature: 0.6,
            response_format: { type: 'json_object' }
        });

        const analysis = JSON.parse(completion.choices[0].message.content);

        // Store this analysis as a learning
        await memoryBank.store({
            category: MEMORY_CATEGORY.LEARNINGS,
            context: 'Daily context analysis',
            details: analysis,
            tags: ['analysis', 'daily']
        });

        return analysis;
    }

    /**
     * Generate a structured task specification
     * @param {Object} opts - { currentAnalysis, prompt }
     * @returns {Object} task spec JSON
     */
    async generateTask({ currentAnalysis, prompt }) {
        logger.info('[Memory] Generating task spec...');

        const similar = await memoryBank.getByCategory(
            MEMORY_CATEGORY.TASK_GENERATION,
            3
        );

        const completion = await this.openai.chat.completions.create({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: `You create detailed task specifications for an AI worker.
Return valid JSON with: title, description, scope, priority, acceptance_criteria,
dependencies, estimated_time_minutes, context, reference_code, success_metrics.`
                },
                {
                    role: 'user',
                    content: [
                        similar.length
                            ? `Similar past tasks:\n${similar.map(m => m.details).join('\n')}`
                            : '',
                        `Current analysis:\n${JSON.stringify(currentAnalysis, null, 2)}`,
                        prompt
                    ].join('\n\n')
                }
            ],
            temperature: 0.7,
            response_format: { type: 'json_object' }
        });

        const taskSpec = JSON.parse(completion.choices[0].message.content);

        await memoryBank.store({
            category: MEMORY_CATEGORY.TASK_GENERATION,
            context: taskSpec.title,
            details: taskSpec,
            tags: ['task', taskSpec.priority]
        });

        return taskSpec;
    }

    /**
     * Validate code quality with AI
     * @param {Object} opts - { code, criteria, prompt }
     * @returns {Object} validation result
     */
    async validateCode({ code, criteria = [], prompt = '' }) {
        logger.info('[Memory] Validating code...');

        const completion = await this.openai.chat.completions.create({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: `You are a rigorous code reviewer.
Return valid JSON with: is_valid (boolean), score (0-100),
strengths, issues, suggestions, approved (boolean), feedback_for_attendant.`
                },
                {
                    role: 'user',
                    content: [
                        criteria.length ? `Criteria: ${criteria.join(', ')}` : '',
                        `\`\`\`javascript\n${code}\n\`\`\``,
                        prompt
                    ].join('\n\n')
                }
            ],
            temperature: 0.4,
            response_format: { type: 'json_object' }
        });

        return JSON.parse(completion.choices[0].message.content);
    }

    /**
     * Analyze a single code file
     * @param {Object} opts - { code, filename, context, prompt }
     * @returns {Object} analysis result
     */
    async analyzeCode({ code, filename, context = '', prompt = '' }) {
        logger.info(`[Memory] Analyzing code: ${filename}`);

        const completion = await this.openai.chat.completions.create({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: `You are a senior code reviewer.
Return JSON with: structure, improvements, patterns,
complexity (low|medium|high), next_steps.`
                },
                {
                    role: 'user',
                    content: [
                        `File: ${filename}`,
                        context ? `Context: ${context}` : '',
                        `Code:\n\`\`\`javascript\n${code}\n\`\`\``,
                        prompt
                    ].join('\n\n')
                }
            ],
            temperature: 0.5,
            response_format: { type: 'json_object' }
        });

        return JSON.parse(completion.choices[0].message.content);
    }

    /** @private Build context string from Sheets data */
    _buildContextString({ taskQueue, codeRepo, memoryBank: mb, performance }) {
        const fmt = (rows, cols) =>
            (rows || []).slice(0, 5).map(r => `- ${cols.map(c => r[c]).join(' | ')}`).join('\n') || '(empty)';

        return [
            `TASK QUEUE (last 5):\n${fmt(taskQueue.slice(-5), [0, 1, 4])}`,
            `CODE REPO (last 3):\n${fmt(codeRepo.slice(-3), [2, 5, 6])}`,
            `MEMORY BANK (recent):\n${fmt((mb || []).slice(-3), [2, 3])}`,
            `PERFORMANCE (last 3 days):\n${fmt((performance || []).slice(-3), [0, 1, 2])}`
        ].join('\n\n');
    }
}

module.exports = { OpenAIMemory };
