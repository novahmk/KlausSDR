/**
 * OpenAI Decision Engine
 * AI-powered decision making for Manager and Attendant agents
 */

const { OpenAI } = require('openai');
const logger = require('../config/logger');

class DecisionEngine {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.model = 'gpt-4o';
    }

    /**
     * Decide the next best action given the current state
     * @param {Object} state - current system state
     * @returns {Object} decision with action, reason, priority
     */
    async decideNextAction(state) {
        logger.info('[DecisionEngine] Deciding next action...');

        const completion = await this.openai.chat.completions.create({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: `You are a system orchestrator AI.
Given the current system state, decide the best next action.
Return JSON: { action, reason, priority, estimated_impact, risks }.`
                },
                {
                    role: 'user',
                    content: `System State:\n${JSON.stringify(state, null, 2)}`
                }
            ],
            temperature: 0.5,
            response_format: { type: 'json_object' }
        });

        return JSON.parse(completion.choices[0].message.content);
    }

    /**
     * Resolve a conflict or blocked state
     * @param {Object} problem - { context, blockers, options }
     * @returns {Object} resolution plan
     */
    async resolveBlocker(problem) {
        logger.info('[DecisionEngine] Resolving blocker...');

        const completion = await this.openai.chat.completions.create({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: `You are a problem-solver AI.
Analyze blockers and suggest concrete resolution steps.
Return JSON: { resolution, steps (array), bypass_possible (boolean) }.`
                },
                {
                    role: 'user',
                    content: `Problem:\n${JSON.stringify(problem, null, 2)}`
                }
            ],
            temperature: 0.6,
            response_format: { type: 'json_object' }
        });

        return JSON.parse(completion.choices[0].message.content);
    }

    /**
     * Score and prioritize a list of tasks
     * @param {Array} tasks
     * @returns {Array} tasks sorted by AI-computed priority score
     */
    async prioritizeTasks(tasks) {
        logger.info(`[DecisionEngine] Prioritizing ${tasks.length} tasks...`);

        if (!tasks.length) return [];

        const completion = await this.openai.chat.completions.create({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: `Return a JSON array of the same tasks with an added 'priority_score' (0-100) field.`
                },
                {
                    role: 'user',
                    content: `Tasks:\n${JSON.stringify(tasks, null, 2)}`
                }
            ],
            temperature: 0.4,
            response_format: { type: 'json_object' }
        });

        const parsed = JSON.parse(completion.choices[0].message.content);
        const scored = parsed.tasks || parsed;

        return Array.isArray(scored)
            ? scored.sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))
            : tasks;
    }
}

module.exports = new DecisionEngine();
