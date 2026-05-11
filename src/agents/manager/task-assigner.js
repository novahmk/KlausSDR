/**
 * Manager Task Assigner
 * Generates task specs and validates Attendant code output
 */

const taskQueue = require('../../sheets/task-queue');
const codeRepo = require('../../sheets/code-repo');
const analysisLog = require('../../sheets/analysis-log');
const { OpenAIMemory } = require('../../openai/memory');
const { AGENTS, CODE_STATUS } = require('../../config/constants');
const logger = require('../../config/logger');

class TaskAssigner {
    constructor() {
        this.memory = new OpenAIMemory();
    }

    /**
     * Generate next task from analysis and add to Task Queue
     * @param {Object} analysis - result from ManagerAnalyzer.analyzeDailyStatus()
     * @returns {{ taskId: string, task: Object }}
     */
    async generateNextTask(analysis) {
        logger.info('[Manager.TaskAssigner] Generating next task...');

        const taskSpec = await this.memory.generateTask({
            currentAnalysis: analysis,
            prompt: `
Create a specific, actionable task for the Attendant AI.
Include: title, description, scope, priority,
acceptance_criteria, dependencies,
estimated_time_minutes, context, reference_code, success_metrics.
      `.trim()
        });

        const taskId = `task_${Date.now()}`;

        await taskQueue.addTask({
            id: taskId,
            ...taskSpec,
            assigner: AGENTS.MANAGER,
            assignee: AGENTS.ATTENDANT
        });

        logger.info(`[Manager.TaskAssigner] Task created: ${taskId} → ${taskSpec.title}`);
        return { taskId, task: taskSpec };
    }

    /**
     * Validate code produced by Attendant and update Code Repo status
     * @param {string} codeId - code repo entry ID
     * @param {string} code - raw code string
     * @returns {Object} validation result
     */
    async validateCodeFromAttendant(codeId, code) {
        logger.info(`[Manager.TaskAssigner] Validating code: ${codeId}`);

        const validation = await this.memory.validateCode({
            code,
            criteria: [
                'has explanatory comments',
                'max ~80 chars per line',
                'descriptive variable names',
                'follows established patterns',
                'no obvious bugs',
                'ready to use'
            ],
            prompt: 'Return JSON: is_valid, score, strengths, issues, suggestions, approved, feedback_for_attendant.'
        });

        const newStatus = validation.approved ? CODE_STATUS.REVIEWED : CODE_STATUS.NEEDS_REVISION;
        await codeRepo.updateStatus(codeId, newStatus);

        await analysisLog.log({
            type: 'code_validation',
            agent: AGENTS.MANAGER,
            subject: `Code ${codeId}`,
            discoveries: validation.strengths,
            recommendations: validation.suggestions,
            confidence: validation.score,
            reference: codeId
        });

        logger.info(`[Manager.TaskAssigner] Validation: ${newStatus} (score: ${validation.score})`);
        return validation;
    }

    /**
     * Calculate deadline given estimated minutes (+1h buffer)
     * @param {number} estimatedMinutes
     * @returns {string} ISO timestamp
     */
    calculateDeadline(estimatedMinutes) {
        const d = new Date();
        d.setMinutes(d.getMinutes() + (estimatedMinutes || 30) + 60);
        return d.toISOString();
    }
}

module.exports = new TaskAssigner();
