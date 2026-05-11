/**
 * Code Repository Sheet Manager
 * Manages Sheet 2: stores generated code, versions, status
 */

const { GoogleSheetsClient } = require('./client');
const { SHEETS, CODE_STATUS } = require('../config/constants');
const logger = require('../config/logger');

const RANGE = `${SHEETS.CODE_REPO}!A:N`;

class CodeRepo {
    constructor() {
        this.sheets = new GoogleSheetsClient();
        this._counter = Date.now();
    }

    /**
     * Save generated code to repo
     * @param {Object} entry - code entry
     * @returns {string} generated code ID
     */
    async saveCode(entry) {
        const codeId = `code_repo_${++this._counter}`;
        logger.info(`Saving code: ${entry.filename} → ${codeId}`);

        // Split code into chunks of ~200 chars per cell for readability
        const code = entry.code || '';
        const chunk = (str, size) => {
            const chunks = [];
            for (let i = 0; i < str.length; i += size) {
                chunks.push(str.slice(i, i + size));
            }
            return chunks;
        };

        const [lines1, lines2, linesRest] = chunk(code, 2000);

        await this.sheets.append(RANGE, {
            id: codeId,
            task_id: entry.taskId || '',
            filename: entry.filename || '',
            full_path: entry.fullPath || '',
            language: entry.language || 'javascript',
            version: entry.version || '1.0',
            status: CODE_STATUS.DRAFT,
            lines_1_50: lines1 || '',
            lines_51_100: lines2 || '',
            lines_101_plus: linesRest || '',
            dependencies: (entry.dependencies || []).join(','),
            tests_passed: entry.testsPassed ? 'yes' : 'no',
            created_at: new Date().toISOString(),
            notes: entry.notes || ''
        });

        return codeId;
    }

    /**
     * Get code entry by ID
     * @param {string} codeId
     * @returns {Object|null}
     */
    async getById(codeId) {
        const rows = await this.sheets.findByColumn(RANGE, 'id', codeId);
        return rows[0] || null;
    }

    /**
     * Get code entry by filename
     * @param {string} filename
     * @returns {Object|null}
     */
    async getByFilename(filename) {
        const rows = await this.sheets.findByColumn(RANGE, 'filename', filename);
        return rows[0] || null;
    }

    /**
     * Update code status
     * @param {string} codeId
     * @param {string} status - CODE_STATUS.*
     */
    async updateStatus(codeId, status) {
        logger.info(`Updating code ${codeId} status → ${status}`);

        const data = await this.sheets.getRange(RANGE);
        const headers = data[0];
        const idCol = headers.indexOf('id');
        const statusColIdx = headers.indexOf('status');

        const rowIndex = data.findIndex(
            (row, i) => i > 0 && row[idCol] === codeId
        );
        if (rowIndex === -1) return;

        const sheetRow = rowIndex + 1;
        const colLetter = String.fromCharCode(65 + statusColIdx);
        await this.sheets.updateCell(
            `${SHEETS.CODE_REPO}!${colLetter}${sheetRow}`,
            status
        );
    }

    /**
     * Get recent code entries
     * @param {number} limit
     * @returns {Array<Object>}
     */
    async getRecent(limit = 5) {
        const rows = await this.sheets.queryRange(RANGE);
        return rows.slice(-limit);
    }

    /**
     * Reconstruct full code string from chunked cells
     * @param {Object} row - row from sheet
     * @returns {string} full code
     */
    extractFullCode(row) {
        return [
            row.lines_1_50 || '',
            row.lines_51_100 || '',
            row.lines_101_plus || ''
        ].join('');
    }
}

module.exports = new CodeRepo();
