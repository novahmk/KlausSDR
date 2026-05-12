'use strict';

/**
 * SafeSheets — Integração segura com Google Sheets (Node.js / googleapis)
 *
 * Baseado no padrão "Safe Google Sheets Integration":
 *  1. Lê e normaliza headers reais antes de qualquer operação
 *  2. Valida colunas obrigatórias ANTES de ler ou escrever
 *  3. Nunca usa índice fixo — sempre: headers.indexOf('col')
 *  4. Escreve com: headers.map(h => row[h] || '') — nunca Object.values()
 *  5. Normaliza dados: telefone (+55), datas (ISO), strings (trim)
 *  6. Fallback retrocompatível — nunca quebra o fluxo SDR
 *  7. Todo erro tratado silenciosamente com warn/error
 */

const { google } = require('googleapis');
const fs = require('fs');
const logger = require('../config/logger');

class SafeSheets {
    /**
     * @param {string} sheetId   - ID da planilha (GOOGLE_SHEETS_ID)
     * @param {string} sheetName - Nome exato da aba (ex: 'LEADS')
     */
    constructor(sheetId, sheetName) {
        this._sheetId   = sheetId;
        this._sheetName = sheetName;
        this._sheets    = null;
        this._auth      = null;

        // headers: array normalizado (equivalente ao this.headers do Apps Script)
        this.headers         = [];       // normalized strings
        this._headersRaw     = [];       // original strings
        this._headersLoaded  = false;
        this._headersCacheAt = 0;
        this._HEADERS_TTL    = 5 * 60 * 1000; // 5 min
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AUTH — lazy init
    // ─────────────────────────────────────────────────────────────────────────

    async _getSheets() {
        if (this._sheets) return this._sheets;

        const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
        if (!credPath || !fs.existsSync(credPath)) {
            throw new Error(`[SafeSheets] Credentials não encontradas: ${credPath}`);
        }

        this._auth = new google.auth.GoogleAuth({
            keyFile: credPath,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        this._sheets = google.sheets({ version: 'v4', auth: this._auth });
        return this._sheets;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. HEADERS — lê, normaliza e cacheia
    //    Equivalente ao _getNormalizedHeaders() do Apps Script
    // ─────────────────────────────────────────────────────────────────────────

    async _getNormalizedHeaders(forceRefresh = false) {
        const now = Date.now();
        const stale = (now - this._headersCacheAt) > this._HEADERS_TTL;

        if (!forceRefresh && this._headersLoaded && !stale) {
            return this.headers;
        }

        try {
            const sheets = await this._getSheets();
            const resp   = await sheets.spreadsheets.values.get({
                spreadsheetId: this._sheetId,
                range: `${this._sheetName}!1:1`
            });

            this._headersRaw    = resp.data.values?.[0] || [];
            this.headers        = this._headersRaw.map(h => this._normalizeHeader(h));
            this._headersLoaded = true;
            this._headersCacheAt = now;

            logger.debug(`[SafeSheets:${this._sheetName}] Headers: ${this.headers.join(', ')}`);
        } catch (err) {
            logger.warn(`[SafeSheets:${this._sheetName}] Falha ao ler headers: ${err.message}`);
            this.headers        = [];
            this._headersLoaded = false;
        }

        return this.headers;
    }

    _normalizeHeader(h) {
        return String(h || '').toString().trim().toLowerCase().replace(/\s+/g, '_');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. VALIDAÇÃO — verifica colunas antes de ler/escrever
    //    Equivalente ao validateColumns() do Apps Script
    // ─────────────────────────────────────────────────────────────────────────

    async validateColumns(expectedHeaders = []) {
        await this._getNormalizedHeaders();

        const normalizedExpected = expectedHeaders.map(h => this._normalizeHeader(h));
        const missing = normalizedExpected.filter(h => !this.headers.includes(h));

        if (missing.length > 0) {
            logger.warn(`[SafeSheets:${this._sheetName}] Colunas ausentes: ${missing.join(', ')}`);
            return { valid: false, missing };
        }

        return { valid: true, missing: [] };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. LEITURA — mapeamento por nome, nunca por índice fixo
    //    Equivalente ao readData() do Apps Script
    // ─────────────────────────────────────────────────────────────────────────

    async readData(expectedHeaders = []) {
        try {
            // Valida antes de ler
            if (expectedHeaders.length > 0) {
                const { valid, missing } = await this.validateColumns(expectedHeaders);
                if (!valid) {
                    logger.warn(`[SafeSheets:${this._sheetName}] readData abortado — colunas ausentes: ${missing.join(', ')}`);
                    return [];
                }
            } else {
                await this._getNormalizedHeaders();
            }

            const sheets = await this._getSheets();
            const resp   = await sheets.spreadsheets.values.get({
                spreadsheetId: this._sheetId,
                range: `${this._sheetName}!A:Z`
            });

            const rows = resp.data.values || [];
            if (rows.length < 2) return []; // sem linhas de dados

            // Usar os headers reais das linhas (linha 0), mapeados pelo nome
            const rowHeaders = rows[0].map(h => this._normalizeHeader(h));

            return rows.slice(1).map(row => {
                const obj = {};
                // Cols que o chamador quer (ou todos se não especificado)
                const cols = expectedHeaders.length > 0
                    ? expectedHeaders.map(h => this._normalizeHeader(h))
                    : rowHeaders;

                cols.forEach(col => {
                    // Índice mapeado pelo nome — nunca por posição fixa
                    const colIndex = rowHeaders.indexOf(col);
                    obj[col] = colIndex >= 0 && row[colIndex] !== undefined
                        ? String(row[colIndex])
                        : '';
                });

                return this._normalizeData(obj);
            });
        } catch (err) {
            logger.error(`[SafeSheets:${this._sheetName}] readData falhou: ${err.message}`);
            return [];
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. ESCRITA — headers.map(h => row[h] || '') — nunca Object.values()
    //    Equivalente ao writeData() do Apps Script
    // ─────────────────────────────────────────────────────────────────────────

    async writeData(data, headers = [], startRow = null) {
        try {
            const items        = Array.isArray(data) ? data : [data];
            const sheetHeaders = await this._getNormalizedHeaders();

            // Valida antes de escrever (se headers esperados foram passados)
            if (headers.length > 0) {
                const { valid, missing } = await this.validateColumns(headers);
                if (!valid) {
                    logger.warn(`[SafeSheets:${this._sheetName}] writeData abortado — colunas ausentes: ${missing.join(', ')}`);
                    return false;
                }
            }

            const rows = items.map(obj => {
                const normalized = this._normalizeData(obj);

                if (sheetHeaders.length > 0) {
                    // Alinha ao layout REAL da planilha
                    // headers.map(col => row[col] || '') — regra central
                    return sheetHeaders.map(col => {
                        const val = normalized[col];
                        return (val !== undefined && val !== null) ? String(val) : '';
                    });
                } else {
                    // Aba ainda sem headers — usa ordem dos headers fornecidos
                    const expected = headers.map(h => this._normalizeHeader(h));
                    return expected.map(col => {
                        const val = normalized[col];
                        return (val !== undefined && val !== null) ? String(val) : '';
                    });
                }
            });

            const sheets = await this._getSheets();

            if (startRow !== null) {
                await sheets.spreadsheets.values.update({
                    spreadsheetId: this._sheetId,
                    range: `${this._sheetName}!A${startRow}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: rows }
                });
            } else {
                await sheets.spreadsheets.values.append({
                    spreadsheetId: this._sheetId,
                    range: `${this._sheetName}!A:Z`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: rows }
                });
            }

            return true;
        } catch (err) {
            logger.error(`[SafeSheets:${this._sheetName}] writeData falhou: ${err.message}`);
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. NORMALIZAÇÃO — telefone, datas, strings
    //    Equivalente ao _normalizeData() do Apps Script
    // ─────────────────────────────────────────────────────────────────────────

    _normalizeData(obj) {
        const result = {};

        for (const [key, val] of Object.entries(obj || {})) {
            const nKey = this._normalizeHeader(key);
            let   nVal = (val !== undefined && val !== null) ? String(val).trim() : '';

            // Telefone → normaliza para dígitos + código país BR
            if (['telefone', 'lead_id', 'phone', 'contato', 'decisor_contact', 'numero'].some(k => nKey.includes(k))) {
                nVal = this._normalizePhone(nVal);
            }
            // Datas → ISO string
            else if (['data_criacao', 'created_at', 'updated_at', 'ultima_interacao', 'last_contact'].some(k => nKey === k || nKey.endsWith('_at'))) {
                nVal = this._normalizeDate(nVal);
            }

            result[nKey] = nVal;
        }

        return result;
    }

    _normalizePhone(raw) {
        const digits = String(raw || '').replace(/\D/g, '');
        if (!digits) return '';
        // Já tem código BR (55 + 10-11 dígitos = 12-13 total)
        if (digits.startsWith('55') && digits.length >= 12) return digits;
        // BR sem código de país → adiciona 55
        if (digits.length === 10 || digits.length === 11) return `55${digits}`;
        return digits;
    }

    _normalizeDate(raw) {
        if (!raw) return '';
        const d = new Date(raw);
        return isNaN(d.getTime()) ? String(raw).trim() : d.toISOString();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. ENSURE HEADERS — cria linha de headers se aba vazia
    //    Equivalente ao ensureHeaders() do Apps Script
    // ─────────────────────────────────────────────────────────────────────────

    async ensureHeaders(headers) {
        try {
            const current = await this._getNormalizedHeaders();
            if (current.length > 0) return true; // Já existem, não sobrescreve

            const sheets = await this._getSheets();
            const normalizedHeaders = headers.map(h => h.toString().trim());

            await sheets.spreadsheets.values.update({
                spreadsheetId: this._sheetId,
                range: `${this._sheetName}!A1`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [normalizedHeaders] }
            });

            // Invalida cache para reler na próxima operação
            this._headersLoaded  = false;
            this._headersCacheAt = 0;

            logger.info(`[SafeSheets:${this._sheetName}] Headers criados: ${normalizedHeaders.join(', ')}`);
            return true;
        } catch (err) {
            logger.warn(`[SafeSheets:${this._sheetName}] ensureHeaders falhou: ${err.message}`);
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS — busca e compatibilidade retroativa
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Filtra linhas onde coluna === valor.
     * Aceita telefone com e sem código de país (+55).
     */
    async findByColumn(column, value) {
        try {
            const rows = await this.readData();
            const col  = this._normalizeHeader(column);
            const val  = String(value || '').trim();

            const isPhone = ['telefone', 'lead_id', 'phone', 'contato'].some(k => col.includes(k));
            const stripped = (isPhone && val.startsWith('55') && val.length >= 12) ? val.slice(2) : null;

            return rows.filter(row => {
                const cell = String(row[col] || '').trim();
                if (cell === val) return true;
                if (stripped && (cell === stripped || `55${cell}` === val)) return true;
                return false;
            });
        } catch (err) {
            logger.error(`[SafeSheets:${this._sheetName}] findByColumn falhou: ${err.message}`);
            return [];
        }
    }

    /**
     * Retorna 2D array cru — compatibilidade com código legado que lê por índice.
     */
    async getRaw() {
        try {
            const sheets = await this._getSheets();
            const resp   = await sheets.spreadsheets.values.get({
                spreadsheetId: this._sheetId,
                range: `${this._sheetName}!A:Z`
            });
            return resp.data.values || [];
        } catch (err) {
            logger.error(`[SafeSheets:${this._sheetName}] getRaw falhou: ${err.message}`);
            return [];
        }
    }

    /** Invalida o cache de headers manualmente. */
    invalidateHeadersCache() {
        this._headersLoaded  = false;
        this._headersCacheAt = 0;
    }
}

module.exports = { SafeSheets };
