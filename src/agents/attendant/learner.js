/**
 * Attendant Learner
 * Extracts and persists learnings from each completed task
 */

const memoryBank = require('../../sheets/memory-bank');
const { MEMORY_CATEGORY } = require('../../config/constants');
const logger = require('../../config/logger');

class Learner {
    /**
     * Store learnings from a completed task execution
     * @param {Object} opts - { taskSpec, generatedCode, validationResult }
     */
    async learn({ taskSpec, generatedCode, validationResult }) {
        logger.info('[Attendant.Learner] Persisting learnings...');

        const tasks = [];

        // 1. Store code pattern if score is high
        if (validationResult.score >= 75) {
            tasks.push(memoryBank.store({
                category: MEMORY_CATEGORY.PATTERNS,
                context: `Pattern from: ${taskSpec.title}`,
                details: {
                    filename: generatedCode.filename,
                    explanation: generatedCode.explanation,
                    strengths: validationResult.strengths
                },
                codeExample: (generatedCode.code || '').substring(0, 400),
                tags: [
                    'generated_code',
                    generatedCode.language || 'javascript',
                    taskSpec.priority || 'medium'
                ],
                effectiveness: validationResult.score / 100
            }));
        }

        // 2. Store issues as error learnings to avoid in future
        if (validationResult.issues && validationResult.issues.length > 0) {
            tasks.push(memoryBank.store({
                category: MEMORY_CATEGORY.ERRORS,
                context: `Issues in: ${taskSpec.title}`,
                details: {
                    issues: validationResult.issues,
                    suggestions: validationResult.suggestions
                },
                tags: ['issues', 'code_quality'],
                effectiveness: 0.9 // high effectiveness — avoid these!
            }));
        }

        // 3. Store decision about scope/approach
        tasks.push(memoryBank.store({
            category: MEMORY_CATEGORY.DECISIONS,
            context: `Approach for: ${taskSpec.title}`,
            details: {
                scope: taskSpec.scope,
                estimated_time: taskSpec.estimated_time_minutes,
                acceptance_criteria: taskSpec.acceptance_criteria,
                result_score: validationResult.score
            },
            tags: ['approach', taskSpec.scope || 'medium']
        }));

        await Promise.all(tasks);
        logger.info(`[Attendant.Learner] Saved ${tasks.length} memory entries`);
    }

    /**
     * Retrieve relevant context for a new task
     * @param {Object} taskSpec - new task to execute
     * @returns {Array<Object>} relevant memories
     */
    async retrieveContext(taskSpec) {
        const keywords = [
            taskSpec.title,
            taskSpec.scope,
            taskSpec.priority,
            ...(taskSpec.reference_code || '').split(',')
        ].filter(Boolean);

        const [patterns, decisions] = await Promise.all([
            memoryBank.searchByTags(keywords, 3),
            memoryBank.getByCategory(MEMORY_CATEGORY.DECISIONS, 2)
        ]);

        return [...patterns, ...decisions];
    }
}

module.exports = Learner;
