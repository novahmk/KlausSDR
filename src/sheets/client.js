/**
 * Google Sheets Client
 * Core client for all Google Sheets API operations
 */

const { google } = require('googleapis');
const fs = require('fs');
const logger = require('../config/logger');

class GoogleSheetsClient {
    constructor() {
        this.spreadsheetId = process.env.GOOGLE_SHEETS_ID;
        this._sheets = null;
        this._auth = null;
        this._headersCache = {}; // tabName -> string[] (cached per process lifetime)
    }

    /**
     * Lazy-init auth + sheets instance
     */
    async _getSheets() {
        if (this._sheets) return this._sheets;

        const credPath = process.env.GOOGLE_CREDENTIALS_PATH;

        if (!fs.existsSync(credPath)) {
            throw new Error(`Credentials file not found: ${credPath}`);
        }

        this._auth = new google.auth.GoogleAuth({
            keyFile: credPath,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        this._sheets = google.sheets({ version: 'v4', auth: this._auth });
        logger.info('Google Sheets client initialized');
        return this._sheets;
    }

    /**
     * Read a range from a sheet
     * @param {string} range - e.g. 'Task Queue!A:K'
     * @returns {Array<Array<string>>} raw row data
     */
    async getRange(range) {
        logger.debug(`Reading range: ${range}`);
        const sheets = await this._getSheets();

        const resp = await sheets.spreadsheets.values.get({
            spreadsheetId: this.spreadsheetId,
            range
        });

        return resp.data.values || [];
    }

    /**
     * Append a single row (object → values array mapped to sheet column order)
     * @param {string} range - e.g. 'Task Queue!A:K'
     * @param {Object} rowObj - key-value row
     * @returns {number} updated rows count
     */
    async append(range, rowObj) {
        logger.debug(`Appending to: ${range}`);
        const sheets = await this._getSheets();

        // Derive tab name from range (e.g. "LEADS!A:Z" → "LEADS")
        const tabName = range.split('!')[0];
        const sheetHeaders = await this._getTabHeaders(tabName);

        let row;
        if (sheetHeaders.length > 0) {
            // Map values to the correct column order based on real sheet headers
            row = sheetHeaders.map(h => {
                const normalizedH = String(h).toLowerCase().trim().replace(/\s+/g, '_');
                const originalH = String(h).trim();
                // Try normalized key first, then original, then lowercase original
                const val = rowObj[normalizedH] ?? rowObj[originalH] ?? rowObj[originalH.toLowerCase()] ?? '';
                return val === null || val === undefined ? '' : val;
            });
        } else {
            // No headers found yet (empty sheet) — insert in object order
            row = Object.values(rowObj);
        }

        const resp = await sheets.spreadsheets.values.append({
            spreadsheetId: this.spreadsheetId,
            range,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [row] }
        });

        return resp.data.updates?.updatedRows || 0;
    }

    /**
     * Update a specific cell
     * @param {string} cell - e.g. 'Task Queue!E5'
     * @param {string|number} value - new value
     */
    async updateCell(cell, value) {
        logger.debug(`Updating cell: ${cell}`);
        const sheets = await this._getSheets();

        await sheets.spreadsheets.values.update({
            spreadsheetId: this.spreadsheetId,
            range: cell,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[value]] }
        });
    }

    /**
     * Update multiple cells in a range
     * @param {string} range
     * @param {Array<Array>} values - 2D array
     */
    async updateRange(range, values) {
        logger.debug(`Updating range: ${range}`);
        const sheets = await this._getSheets();

        await sheets.spreadsheets.values.update({
            spreadsheetId: this.spreadsheetId,
            range,
            valueInputOption: 'USER_ENTERED',
            resource: { values }
        });
    }

    /**
     * Clear a range
     * @param {string} range
     */
    async clearRange(range) {
        logger.debug(`Clearing range: ${range}`);
        const sheets = await this._getSheets();

        await sheets.spreadsheets.values.clear({
            spreadsheetId: this.spreadsheetId,
            range
        });
    }

    /**
     * Query a range with filters and optional sort
     * @param {string} range
     * @param {Object} filters - { columnName: value }
     * @param {Object} options - { sort: 'priority', desc: false }
     * @returns {Array<Object>} array of row objects
     */
    async queryRange(range, filters = {}, options = {}) {
        const data = await this.getRange(range);
        if (!data || !data[0]) return [];

        const headers = data[0];
        let rows = data.slice(1).map(row => {
            const obj = {};
            headers.forEach((h, i) => {
                // Normalize header: lowercase + underscores (e.g. "Lead ID" → "lead_id")
                const key = String(h).toLowerCase().trim().replace(/\s+/g, '_');
                obj[key] = row[i] || '';
            });
            return obj;
        });

        // Apply filters
        Object.entries(filters).forEach(([key, val]) => {
            rows = rows.filter(row => row[key] === val);
        });

        // Apply sort
        if (options.sort && headers.includes(options.sort)) {
            rows.sort((a, b) => {
                const va = a[options.sort];
                const vb = b[options.sort];
                return options.desc
                    ? vb.localeCompare(va)
                    : va.localeCompare(vb);
            });
        }

        return rows;
    }

    /**
     * Find rows matching a column value
     * @param {string} range
     * @param {string} column
     * @param {string} value
     * @returns {Array<Object>}
     */
    async findByColumn(range, column, value) {
        return this.queryRange(range, { [column]: value });
    }

    /**
     * Fetch and cache the raw header row for a given tab.
     * Cache lives for the process lifetime (headers rarely change).
     * @param {string} tabName
     * @returns {string[]}
     */
    async _getTabHeaders(tabName) {
        if (this._headersCache[tabName]) return this._headersCache[tabName];
        const data = await this.getRange(`${tabName}!1:1`);
        const headers = data?.[0] || [];
        this._headersCache[tabName] = headers;
        return headers;
    }
}

module.exports = { GoogleSheetsClient };
