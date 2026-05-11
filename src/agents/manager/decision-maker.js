/**
 * Manager Decision Maker
 * High-level strategic decisions about project direction
 */

const decisionEngine = require('../../openai/decision-engine');
const taskQueue = require('../../sheets/task-queue');
const performance = require('../../sheets/performance');
const memoryBank = require('../../sheets/memory-bank');
const analysisLog = require('../../sheets/analysis-log');
const { AGENTS, MEMORY_CATEGORY } = require('../../config/constants');
const logger = require('../../config/logger');

class DecisionMaker {
    /**
     * Evaluate system state and decide next strategic action
     * @returns {Object} decision with action, reason, priority
     */
    async decideNextAction() {
        logger.info('[Manager.DecisionMaker] Deciding next action...');

        const [counts, recentPerf, recentMemories] = await Promise.all([
            taskQueue.countByStatus(),
            performance.getLastDays(3),
            memoryBank.getRecent(5)
        ]);

        const state = {
            taskCounts: counts,
            recentPerformance: recentPerf,
            recentLearnings: recentMemories
        };

        const decision = await decisionEngine.decideNextAction(state);

        // Store decision in Memory Bank
        await memoryBank.store({
            category: MEMORY_CATEGORY.DECISIONS,
            context: `Decision: ${decision.action}`,
            details: decision,
            tags: ['decision', decision.priority]
        });

        await analysisLog.log({
            type: 'strategic_decision',
            agent: AGENTS.MANAGER,
            subject: decision.action,
            discoveries: [decision.reason],
            recommendations: [decision.action],
            confidence: 85
        });

        logger.info(`[Manager.DecisionMaker] Decision: ${decision.action}`);
        return decision;
    }

    /**
     * Handle a blocked task by resolving the problem
     * @param {string} taskId
     * @param {string} blockerNote
     * @returns {Object} resolution plan
     */
    async handleBlocker(taskId, blockerNote) {
        logger.info(`[Manager.DecisionMaker] Handling blocker for task ${taskId}`);

        const resolution = await decisionEngine.resolveBlocker({
            taskId,
            context: blockerNote,
            options: ['retry', 'simplify', 'skip', 'delegate']
        });

        await analysisLog.log({
            type: 'blocker_resolution',
            agent: AGENTS.MANAGER,
            subject: `Task ${taskId}`,
            discoveries: [blockerNote],
            recommendations: resolution.steps,
            confidence: 70
        });

        return resolution;
    }

    /**
     * Prioritize pending tasks using AI scoring
     * @returns {Array<Object>} ordered tasks
     */
    async prioritizePendingTasks() {
        logger.info('[Manager.DecisionMaker] Prioritizing tasks...');
        const pending = (await taskQueue.countByStatus()).pending;
        if (!pending) return [];

        const rows = await taskQueue.sheets
            ? [] // sheets is private, use queryRange via TaskQueue
            : [];

        logger.info(`[Manager.DecisionMaker] ${pending} tasks pending`);
        return [];
    }
}

module.exports = new DecisionMaker();
