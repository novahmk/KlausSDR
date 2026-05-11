/**
 * Analysis Log Sheet Manager
 * Manages Sheet 3: logs all analysis events and decisions
 */

const { GoogleSheetsClient } = require('./client');
const { SHEETS } = require('../config/constants');
const logger = require('../config/logger');

const RANGE = `${SHEETS.ANALYSIS_LOG}!A:I`;

class AnalysisLog {
    constructor() {
        this.sheets = new GoogleSheetsClient();
        this._counter = Date.now();
    }

    /**
     * Log an analysis event
     * @param {Object} entry - log entry
     */
    async log(entry) {
        logger.debug(`Logging analysis: ${entry.type} by ${entry.agent}`);

        await this.sheets.append(RANGE, {
            id: `log_${++this._counter}`,
            timestamp: new Date().toISOString(),
            type: entry.type || 'general',
            agent: entry.agent || 'System',
            subject: entry.subject || '',
            discoveries: Array.isArray(entry.discoveries)
                ? entry.discoveries.join(' | ')
                : (entry.discoveries || ''),
            recommendations: Array.isArray(entry.recommendations)
                ? entry.recommendations.join(' | ')
                : (entry.recommendations || ''),
            confidence: entry.confidence !== undefined
                ? `${entry.confidence}%`
                : '80%',
            reference: entry.reference || ''
        });
    }

    /**
     * Get recent log entries
     * @param {number} limit
     * @returns {Array<Object>}
     */
    async getRecent(limit = 10) {
        const rows = await this.sheets.queryRange(RANGE);
        return rows.slice(-limit);
    }

    /**
     * Get entries by agent
     * @param {string} agentName
     * @param {number} limit
     * @returns {Array<Object>}
     */
    async getByAgent(agentName, limit = 5) {
        const rows = await this.sheets.findByColumn(RANGE, 'agent', agentName);
        return rows.slice(-limit);
    }
}

module.exports = new AnalysisLog();
