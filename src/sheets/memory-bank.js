/**
 * Memory Bank Sheet Manager
 * Manages Sheet 4: generative memory — patterns, decisions, learnings
 */

const { GoogleSheetsClient } = require('./client');
const { SHEETS, MEMORY_CATEGORY } = require('../config/constants');
const logger = require('../config/logger');

const RANGE = `${SHEETS.MEMORY_BANK}!A:I`;

class MemoryBank {
    constructor() {
        this.sheets = new GoogleSheetsClient();
        this._counter = Date.now();
    }

    /**
     * Store a new memory entry
     * @param {Object} memory
     */
    async store(memory) {
        logger.debug(`Storing memory: [${memory.category}] ${memory.context}`);

        await this.sheets.append(RANGE, {
            id: `mem_${++this._counter}`,
            category: memory.category || MEMORY_CATEGORY.LEARNINGS,
            context: (memory.context || '').substring(0, 120),
            details: typeof memory.details === 'object'
                ? JSON.stringify(memory.details)
                : (memory.details || ''),
            code_example: memory.codeExample || '',
            discovered_at: new Date().toISOString(),
            frequency: memory.frequency || 1,
            effectiveness: memory.effectiveness || 0.8,
            tags: Array.isArray(memory.tags)
                ? memory.tags.join(',')
                : (memory.tags || '')
        });
    }

    /**
     * Retrieve recent memories by category
     * @param {string} category
     * @param {number} limit
     * @returns {Array<Object>}
     */
    async getByCategory(category, limit = 5) {
        const rows = await this.sheets.findByColumn(RANGE, 'category', category);
        return rows.slice(-limit);
    }

    /**
     * Get all memories (for context building)
     * @param {number} limit
     * @returns {Array<Object>}
     */
    async getRecent(limit = 10) {
        const rows = await this.sheets.queryRange(RANGE);
        return rows.slice(-limit);
    }

    /**
     * Search memories by tags
     * @param {string[]} tags
     * @param {number} limit
     * @returns {Array<Object>}
     */
    async searchByTags(tags, limit = 5) {
        const rows = await this.sheets.queryRange(RANGE);
        const tagSet = new Set(tags.map(t => t.toLowerCase()));

        const matched = rows.filter(row => {
            const rowTags = (row.tags || '').toLowerCase().split(',');
            return rowTags.some(t => tagSet.has(t.trim()));
        });

        // Sort by effectiveness desc
        matched.sort((a, b) =>
            parseFloat(b.effectiveness || 0) - parseFloat(a.effectiveness || 0)
        );

        return matched.slice(0, limit);
    }

    /**
     * Increment frequency counter for a memory
     * @param {string} memoryId
     */
    async incrementFrequency(memoryId) {
        const data = await this.sheets.getRange(RANGE);
        const headers = data[0];
        const idCol = headers.indexOf('id');
        const freqColIdx = headers.indexOf('frequency');

        const rowIndex = data.findIndex(
            (row, i) => i > 0 && row[idCol] === memoryId
        );
        if (rowIndex === -1) return;

        const currentFreq = parseInt(data[rowIndex][freqColIdx] || '0') + 1;
        const sheetRow = rowIndex + 1;
        const colLetter = String.fromCharCode(65 + freqColIdx);
        await this.sheets.updateCell(
            `${SHEETS.MEMORY_BANK}!${colLetter}${sheetRow}`,
            currentFreq
        );
    }
}

module.exports = new MemoryBank();
