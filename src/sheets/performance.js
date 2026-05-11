/**
 * Performance Sheet Manager
 * Manages Sheet 5: daily performance metrics and KPIs
 */

const { GoogleSheetsClient } = require('./client');
const { SHEETS } = require('../config/constants');
const logger = require('../config/logger');

const RANGE = `${SHEETS.PERFORMANCE}!A:I`;

class Performance {
    constructor() {
        this.sheets = new GoogleSheetsClient();
    }

    /**
     * Record daily performance metrics
     * @param {Object} metrics
     */
    async record(metrics) {
        logger.info('Recording performance metrics');

        await this.sheets.append(RANGE, {
            date: new Date().toISOString().split('T')[0],
            tasks_completed: metrics.tasksCompleted || 0,
            success_rate: `${metrics.successRate || 0}%`,
            bugs_found: metrics.bugsFound || 0,
            code_optimization: `${metrics.codeOptimization || 0}%`,
            avg_time_minutes: metrics.avgTimeMinutes || 0,
            learnings: metrics.learnings || 0,
            overall_confidence: `${metrics.overallConfidence || 80}%`,
            notes: metrics.notes || 'Auto cycle'
        });
    }

    /**
     * Get performance data for last N days
     * @param {number} days
     * @returns {Array<Object>}
     */
    async getLastDays(days = 7) {
        const rows = await this.sheets.queryRange(RANGE);
        return rows.slice(-days);
    }

    /**
     * Compute aggregate statistics
     * @returns {Object} averages and totals
     */
    async getStats() {
        const rows = await this.sheets.queryRange(RANGE);
        if (!rows.length) return null;

        const total = rows.length;
        const avgSuccess = rows.reduce(
            (sum, r) => sum + parseFloat(r.success_rate || 0),
            0
        ) / total;
        const totalTasks = rows.reduce(
            (sum, r) => sum + parseInt(r.tasks_completed || 0),
            0
        );

        return {
            totalCycles: total,
            totalTasks,
            avgSuccessRate: avgSuccess.toFixed(1)
        };
    }
}

module.exports = new Performance();
