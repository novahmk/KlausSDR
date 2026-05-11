/**
 * Task Queue Sheet Manager
 * Manages Sheet 1: Task Queue (pending, in_progress, done tasks)
 */

const { GoogleSheetsClient } = require('./client');
const { SHEETS, TASK_STATUS, PRIORITY } = require('../config/constants');
const logger = require('../config/logger');

const RANGE = `${SHEETS.TASK_QUEUE}!A:K`;

class TaskQueue {
    constructor() {
        this.sheets = new GoogleSheetsClient();
    }

    /**
     * Add a new task to the queue
     * @param {Object} task - task definition from Manager
     * @returns {number} row count after append
     */
    async addTask(task) {
        logger.info(`Adding task: ${task.title}`);

        return this.sheets.append(RANGE, {
            id: task.id || `task_${Date.now()}`,
            title: task.title,
            description: JSON.stringify(task),
            priority: task.priority || PRIORITY.MEDIUM,
            status: TASK_STATUS.PENDING,
            assigner: task.assigner || 'Manager',
            assignee: task.assignee || 'Attendant',
            created_at: new Date().toISOString(),
            deadline: task.deadline || '',
            result_link: '',
            notes: task.notes || ''
        });
    }

    /**
     * Get the first pending task (sorted by priority: high → low)
     * @returns {Object|null} task object or null if none
     */
    async getNextPending() {
        const priorityOrder = { high: 0, medium: 1, low: 2 };

        const rows = await this.sheets.queryRange(
            RANGE,
            { status: TASK_STATUS.PENDING }
        );

        if (!rows.length) return null;

        // Sort high → low priority
        rows.sort((a, b) =>
            (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9)
        );

        return rows[0];
    }

    /**
     * Update a task's status by ID
     * @param {string} taskId
     * @param {string} newStatus
     */
    async updateStatus(taskId, newStatus) {
        logger.info(`Updating task ${taskId} → ${newStatus}`);

        const data = await this.sheets.getRange(RANGE);
        const headers = data[0];
        const idCol = headers.indexOf('id');
        const statusCol = headers.indexOf('status');

        const rowIndex = data.findIndex(
            (row, i) => i > 0 && row[idCol] === String(taskId)
        );

        if (rowIndex === -1) {
            logger.warn(`Task ${taskId} not found in queue`);
            return;
        }

        const sheetRow = rowIndex + 1; // 1-indexed
        const colLetter = String.fromCharCode(65 + statusCol); // A=0
        await this.sheets.updateCell(
            `${SHEETS.TASK_QUEUE}!${colLetter}${sheetRow}`,
            newStatus
        );
    }

    /**
     * Set the result link for a completed task
     * @param {string} taskId
     * @param {string} resultLink
     */
    async setResultLink(taskId, resultLink) {
        const data = await this.sheets.getRange(RANGE);
        const headers = data[0];
        const idCol = headers.indexOf('id');
        const linkColIdx = headers.indexOf('result_link');

        const rowIndex = data.findIndex(
            (row, i) => i > 0 && row[idCol] === String(taskId)
        );

        if (rowIndex === -1) return;

        const sheetRow = rowIndex + 1;
        const colLetter = String.fromCharCode(65 + linkColIdx);
        await this.sheets.updateCell(
            `${SHEETS.TASK_QUEUE}!${colLetter}${sheetRow}`,
            resultLink
        );
    }

    /**
     * Add a note to a task
     * @param {string} taskId
     * @param {string} note
     */
    async addNote(taskId, note) {
        const data = await this.sheets.getRange(RANGE);
        const headers = data[0];
        const idCol = headers.indexOf('id');
        const noteColIdx = headers.indexOf('notes');

        const rowIndex = data.findIndex(
            (row, i) => i > 0 && row[idCol] === String(taskId)
        );
        if (rowIndex === -1) return;

        const sheetRow = rowIndex + 1;
        const colLetter = String.fromCharCode(65 + noteColIdx);
        await this.sheets.updateCell(
            `${SHEETS.TASK_QUEUE}!${colLetter}${sheetRow}`,
            note
        );
    }

    /**
     * Count tasks by status
     * @returns {Object} { pending, in_progress, done, blocked }
     */
    async countByStatus() {
        const rows = await this.sheets.queryRange(RANGE);
        const counts = {
            pending: 0,
            in_progress: 0,
            done: 0,
            blocked: 0
        };
        rows.forEach(r => {
            if (counts[r.status] !== undefined) counts[r.status]++;
        });
        return counts;
    }
}

module.exports = new TaskQueue();
