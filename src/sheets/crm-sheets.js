/**
 * CRM Sheets Manager
 * Centraliza o acesso a todas as abas do sistema completo de SDR IA.
 * Usa SafeSheets para garantir: headers normalizados, colunas corretas,
 * sem loops, sem dados corrompidos.
 */

const { SafeSheets } = require('./safe-sheets');
const logger = require('../config/logger');

// Nomes extatos das abas que você deve ter na sua planilha
const CRM_TABS = {
    LEADS: 'LEADS',
    INTERACOES: 'INTERAÇÕES',
    PIPELINE: 'PIPELINE',
    ANALISE: 'ANÁLISE',
    FOLLOW_UP: 'FOLLOW-UP',
    TEMPLATES: 'TEMPLATES',
    PENSAMENTO_IA: 'PENSAMENTO_IA',
    // Abas de segurança & compliance
    SEGURANCA: 'SEGURANÇA',
    RATE_LIMIT: 'RATE_LIMIT',
    AUDIT_LOG: 'AUDIT_LOG',
    CONFIGURACOES: 'CONFIGURAÇÕES',
    ALERTAS: 'ALERTA',
    // Aba de detecção de BOTs
    BOT_DETECCOES: 'BOT_DETECCAO',
    // Aba de feedback do sistema de aprendizado
    FEEDBACK_LOG: 'FEEDBACK_LOG'
};

class CrmSheets {
    constructor() {
        this._sheetId = process.env.GOOGLE_SHEETS_ID;
        this._tabs = {}; // cache de instâncias SafeSheets por aba
    }

    /**
     * Retorna (ou cria) instância SafeSheets para a aba.
     */
    _tab(tabName) {
        if (!this._tabs[tabName]) {
            this._tabs[tabName] = new SafeSheets(this._sheetId, tabName);
        }
        return this._tabs[tabName];
    }

    /**
     * Adiciona uma linha — usa SafeSheets.writeData (nunca Object.values).
     */
    async appendRow(tabName, rowData) {
        logger.debug(`[CRM.Sheets] Inserindo registro em ${tabName}...`);
        return this._tab(tabName).writeData(rowData);
    }

    /**
     * Busca dados filtrando por coluna. Aceita telefone +55 ou sem.
     */
    async findByFilter(tabName, filterKey, filterValue) {
        return this._tab(tabName).findByColumn(filterKey, filterValue);
    }

    /**
     * Busca UMA linha pelo Lead ID.
     */
    async getOneByLeadId(tabName, leadId) {
        const rows = await this.findByFilter(tabName, 'lead_id', leadId);
        return rows[0] || null;
    }

    /**
     * Busca múltiplos registros por Lead ID.
     */
    async getManyByLeadId(tabName, leadId) {
        return this.findByFilter(tabName, 'lead_id', leadId);
    }

    /**
     * Retorna dados crus (Array 2D) — compatibilidade retroativa.
     */
    async getAll(tabName) {
        return this._tab(tabName).getRaw();
    }

    /**
     * Valida se colunas esperadas existem na aba.
     */
    async validateTab(tabName, expectedHeaders) {
        return this._tab(tabName).validateColumns(expectedHeaders);
    }
}

module.exports = {
    crmSheets: new CrmSheets(),
    CRM_TABS
};
