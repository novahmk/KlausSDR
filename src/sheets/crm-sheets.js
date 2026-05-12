/**
 * CRM Sheets Manager
 * Centraliza o acesso a todas as abas do sistema completo de SDR IA.
 */

const { GoogleSheetsClient } = require('./client');
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
    // Abas de segurança & compliance (adicionadas no sistema anti-spam)
    SEGURANCA: 'SEGURANÇA',
    RATE_LIMIT: 'RATE_LIMIT',
    AUDIT_LOG: 'AUDIT_LOG',
    CONFIGURACOES: 'CONFIGURAÇÕES',
    ALERTAS: 'ALERTAS',
    // Aba de detecção de BOTs
    BOT_DETECCOES: 'BOT_DETECCOES',
    // Aba de feedback do sistema de aprendizado
    FEEDBACK_LOG: 'FEEDBACK_LOG'
};

class CrmSheets {
    constructor() {
        this.client = new GoogleSheetsClient();
    }

    /**
     * Helper genérico para adicionar uma linha em qualquer aba CRM
     * @param {string} tabName
     * @param {Object} rowData
     */
    async appendRow(tabName, rowData) {
        logger.debug(`[CRM.Sheets] Inserindo registro em ${tabName}...`);
        try {
            await this.client.append(`${tabName}!A:Z`, rowData);
            return true;
        } catch (err) {
            logger.error(`Erro ao inserir em ${tabName}: ${err.message}`);
            return false;
        }
    }

    /**
     * Busca dados baseados em um filtro (ex: Lead ID)
     * @param {string} tabName 
     * @param {string} filterKey 
     * @param {string} filterValue 
     */
    async findByFilter(tabName, filterKey, filterValue) {
        try {
            const rows = await this.client.queryRange(`${tabName}!A:Z`);
            return rows.filter(r => String(r[filterKey]) === String(filterValue));
        } catch (err) {
            return [];
        }
    }

    /**
     * Busca UMA linha pelo Lead ID
     */
    async getOneByLeadId(tabName, leadId) {
        const rows = await this.findByFilter(tabName, 'lead id', leadId);
        return rows[0] || null;
    }

    /**
     * Busca múltiplos registros por Lead ID (ex: Interações)
     */
    async getManyByLeadId(tabName, leadId) {
        return await this.findByFilter(tabName, 'lead id', leadId);
    }

    /**
     * Busca todos os registros crus (Array 2D)
     */
    async getAll(tabName) {
        try {
            return await this.client.getRange(`${tabName}!A:Z`);
        } catch (err) {
            return [];
        }
    }
}

module.exports = {
    crmSheets: new CrmSheets(),
    CRM_TABS
};
