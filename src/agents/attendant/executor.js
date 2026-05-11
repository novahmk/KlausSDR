/**
 * Attendant Executor
 * Fetches tasks from queue and coordinates full execution pipeline
 */

const taskQueue = require('../../sheets/task-queue');
const codeRepo = require('../../sheets/code-repo');
const analysisLog = require('../../sheets/analysis-log');
const memoryBank = require('../../sheets/memory-bank');
const CodeGenerator = require('./code-generator');
const Validator = require('./validator');
const Learner = require('./learner');
const { TASK_STATUS, AGENTS } = require('../../config/constants');
const logger = require('../../config/logger');

class Executor {
    constructor() {
        this.generator = new CodeGenerator();
        this.validator = new Validator();
        this.learner = new Learner();
    }

    /**
     * Fetch the next pending task (highest priority first)
     * @returns {Object|null} task object or null
     */
    async getNextTask() {
        logger.info('[Attendant.Executor] Looking for next task...');

        const task = await taskQueue.getNextPending();

        if (!task) {
            logger.info('[Attendant.Executor] No pending tasks');
            return null;
        }

        logger.info(`[Attendant.Executor] Found: ${task.title}`);
        return {
            id: task.id,
            title: task.title,
            spec: this._parseSpec(task.description),
            priority: task.priority,
            deadline: task.deadline
        };
    }

    /**
     * Execute a task end-to-end:
     * fetch → generate → validate → save → log
     * @param {string} taskId
     * @param {Object} taskSpec
     * @returns {Object} execution result
     */
    async executeTask(taskId, taskSpec) {
        logger.info(`[Attendant.Executor] Executing task: ${taskId}`);

        // 1. Mark in_progress
        await taskQueue.updateStatus(taskId, TASK_STATUS.IN_PROGRESS);

        try {
            // 2. Load relevant memories for context
            const tags = (taskSpec.reference_code || '').split(',').filter(Boolean);
            const context = tags.length
                ? await memoryBank.searchByTags(tags, 5)
                : await memoryBank.getRecent(5);

            logger.info(`[Attendant.Executor] Loaded ${context.length} memory items`);

            // 3. Generate code
            const generated = await this.generator.generate({ taskSpec, context });

            // 4. Validate generated code
            const validation = await this.validator.validate(generated);

            if (!validation.is_valid) {
                throw new Error(`Validation failed: ${(validation.issues || []).join(', ')}`);
            }

            // 5. Save to Code Repository
            const codeId = await codeRepo.saveCode({
                taskId,
                filename: generated.filename,
                fullPath: `/src/${generated.filename}`,
                language: generated.language || 'javascript',
                code: generated.code,
                dependencies: generated.dependencies || [],
                notes: generated.explanation || '',
                testsPassed: validation.score >= 70
            });

            // 6. Update task → done + result link
            await taskQueue.updateStatus(taskId, TASK_STATUS.DONE);
            await taskQueue.setResultLink(taskId, codeId);

            // 7. Log execution
            await analysisLog.log({
                type: 'task_execution',
                agent: AGENTS.ATTENDANT,
                subject: taskSpec.title,
                discoveries: [`Generated ${generated.filename}`],
                recommendations: validation.suggestions,
                confidence: validation.score,
                reference: codeId
            });

            // 8. Learn from the execution
            await this.learner.learn({
                taskSpec,
                generatedCode: generated,
                validationResult: validation
            });

            logger.info(`[Attendant.Executor] ✅ Task ${taskId} complete → ${codeId}`);

            return {
                status: 'success',
                codeId,
                code: generated.code,
                filename: generated.filename,
                validation
            };

        } catch (error) {
            logger.error(`[Attendant.Executor] Task ${taskId} failed: ${error.message}`);

            await taskQueue.updateStatus(taskId, TASK_STATUS.BLOCKED);
            await taskQueue.addNote(taskId, `Error: ${error.message}`);

            throw error;
        }
    }

    /** @private Parse task spec JSON safely */
    _parseSpec(description) {
        try {
            return JSON.parse(description);
        } catch {
            return { title: description, description, acceptance_criteria: [] };
        }
    }
}

module.exports = new Executor();
