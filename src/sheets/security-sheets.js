/**
 * Security Sheets Module
 * Handles all operations for the 5 security/compliance tabs:
 * SEGURANÇA, RATE_LIMIT, AUDIT_LOG, CONFIGURAÇÕES, ALERTAS
 */

const { GoogleSheetsClient } = require('./client');
const logger = require('../config/logger');

const SECURITY_TABS = {
    SEGURANCA: 'SEGURANÇA',
    RATE_LIMIT: 'RATE_LIMIT',
    AUDIT_LOG: 'AUDIT_LOG',
    CONFIGURACOES: 'CONFIGURAÇÕES',
    ALERTAS: 'ALERTAS'
};

// Default thresholds if CONFIGURAÇÕES sheet is unavailable
const DEFAULT_CONFIG = {
    Max_Mensagens_Por_Minuto: 2,
    Max_Mensagens_Por_Hora: 10,
    Max_Mensagens_Por_Dia: 50,
    Min_Intervalo_Entre_Contatos: 30, // minutes
    Dias_Sem_Resposta_Limite: 30,
    Taxa_Rejeicao_Limite: 0.70,
    Tentativas_Maximas_Por_Lead: 6,
    Whitelist_Ativa: 'Sim',
    Deteccao_Spam_Ativa: 'Sim',
    Validacao_Reconexao: 'Obrigatória'
};

// Terminal statuses that block contact
const BLOCKED_STATUSES = [
    'Rejeitado Permanente',
    'Spam/Abuso',
    'Sem Contato 30+',
    'Número Inválido',
    'Bloqueado WhatsApp'
];

class SecuritySheets {
    constructor() {
        this.client = new GoogleSheetsClient();
        this._configCache = null;
        this._configCacheTime = 0;
        this._CONFIG_TTL = 5 * 60 * 1000; // 5 minutes cache

        // Cache de registros de segurança por lead (TTL de 10 minutos)
        this._securityRecordCache = new Map(); // leadId -> { record, expiresAt }
        this._SECURITY_RECORD_TTL = 10 * 60 * 1000; // 10 minutes
    }

    // ─────────────────────────────────────────────────────────
    // SEGURANÇA tab
    // ─────────────────────────────────────────────────────────

    /**
     * Fetch the security record for a given lead ID.
     * Results are cached locally for 10 minutes to avoid repeated Sheets API calls.
     * @param {string} leadId
     * @returns {Object|null}
     */
    async getSecurityRecord(leadId) {
        const key = String(leadId).trim();
        const cached = this._securityRecordCache.get(key);
        if (cached && Date.now() < cached.expiresAt) {
            logger.debug(`[SecuritySheets] Cache hit para lead ${key}`);
            return cached.record;
        }

        try {
            const rows = await this.client.getRange(`${SECURITY_TABS.SEGURANCA}!A:J`);
            if (!rows || rows.length < 2) return null;

            const headers = rows[0].map(h => String(h).toLowerCase().trim());
            const leadIdIdx = headers.findIndex(h => h.includes('lead id') || h === 'lead_id');
            const bloqueadoIdx = headers.findIndex(h => h.includes('bloqueado'));
            const statusFinalIdx = headers.findIndex(h => h.includes('status final') || h.includes('status_final'));
            const razaoBloqueioIdx = headers.findIndex(h => h.includes('razão bloqueio') || h.includes('razao bloqueio'));
            const motivoIdx = headers.findIndex(h => h === 'motivo');

            const row = rows.slice(1).find(r => String(r[leadIdIdx] || '').trim() === key);

            const record = row ? {
                leadId: row[leadIdIdx],
                bloqueado: String(row[bloqueadoIdx] || '').trim(),
                statusFinal: String(row[statusFinalIdx] || '').trim(),
                razaoBloqueio: String(row[razaoBloqueioIdx] || '').trim(),
                motivo: String(row[motivoIdx] || '').trim()
            } : null;

            this._securityRecordCache.set(key, {
                record,
                expiresAt: Date.now() + this._SECURITY_RECORD_TTL
            });

            return record;
        } catch (err) {
            logger.warn(`[SecuritySheets] Erro ao ler SEGURANÇA para lead ${key}: ${err.message}`);
            return null;
        }
    }

    /**
     * Invalida o cache de segurança para um lead específico.
     * Deve ser chamado após upsertSecurityRecord para garantir consistência.
     * @param {string} leadId
     */
    invalidateSecurityCache(leadId) {
        this._securityRecordCache.delete(String(leadId).trim());
    }

    /**
     * Write or update a security record for a lead.
     * @param {Object} data
     */
    async upsertSecurityRecord(data) {
        try {
            const row = {
                lead_id: data.leadId,
                nome_lead: data.nomeLead || '',
                status_final: data.statusFinal || 'Em Progresso',
                data_finalizacao: data.dataFinalizacao || new Date().toLocaleDateString('pt-BR'),
                motivo: data.motivo || '',
                bloqueado: data.bloqueado || 'Não',
                data_bloqueio: data.dataBloqueio || '',
                razao_bloqueio: data.razaoBloqueio || '',
                token_seguranca: data.tokenSeguranca || '',
                nota: data.nota || ''
            };
            await this.client.append(`${SECURITY_TABS.SEGURANCA}!A:J`, row);
            this.invalidateSecurityCache(data.leadId);
            logger.info(`[SecuritySheets] Registro de segurança gravado para lead ${data.leadId}`);
        } catch (err) {
            logger.error(`[SecuritySheets] Erro ao gravar SEGURANÇA: ${err.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────
    // RATE_LIMIT tab
    // ─────────────────────────────────────────────────────────

    /**
     * Fetch all RATE_LIMIT rows (for counting recent messages).
     * @returns {Array<Object>}
     */
    async getRateLimitRows() {
        try {
            const rows = await this.client.getRange(`${SECURITY_TABS.RATE_LIMIT}!A:J`);
            if (!rows || rows.length < 2) return [];

            const headers = rows[0].map(h => String(h).toLowerCase().trim());
            return rows.slice(1).map(row => {
                const obj = {};
                headers.forEach((h, i) => { obj[h] = row[i] || ''; });
                return obj;
            });
        } catch (err) {
            logger.warn(`[SecuritySheets] Erro ao ler RATE_LIMIT: ${err.message}`);
            return [];
        }
    }

    /**
     * Append a RATE_LIMIT event record.
     * @param {Object} data
     */
    async appendRateLimitEvent(data) {
        try {
            const row = {
                timestamp: data.timestamp || new Date().toISOString(),
                lead_id: data.leadId,
                tipo_mensagem: data.tipoMensagem || 'WhatsApp',
                tempo_desde_ultima: data.tempoDesdeUltima || '',
                mensagens_ultima_hora: data.mensagensUltimaHora || '',
                mensagens_ultimo_dia: data.mensagensUltimoDia || '',
                status_rate: data.statusRate || 'OK',
                permitido: data.permitido || 'Não',
                motivo_bloqueio: data.motivoBloqueio || '',
                acao_tomada: data.acaoTomada || 'Rejeitada'
            };
            await this.client.append(`${SECURITY_TABS.RATE_LIMIT}!A:J`, row);
        } catch (err) {
            logger.warn(`[SecuritySheets] Erro ao gravar RATE_LIMIT: ${err.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────
    // AUDIT_LOG tab
    // ─────────────────────────────────────────────────────────

    /**
     * Append an audit log entry.
     * @param {Object} data
     */
    async appendAuditLog(data) {
        try {
            const row = {
                id_log: `AUD_${Date.now()}`,
                timestamp: data.timestamp || new Date().toISOString(),
                lead_id: data.leadId,
                acao: data.acao,
                tipo_acao: data.tipoAcao || 'Geral',
                status_antes: data.statusAntes || '',
                status_depois: data.statusDepois || '',
                ip_sessao: data.ipSessao || 'local',
                token_reconexao: data.tokenReconexao || '',
                autorizado: data.autorizado || 'Não',
                motivo: data.motivo || '',
                usuario_ia: data.usuarioIa || 'SDR_IA_v2.0'
            };
            await this.client.append(`${SECURITY_TABS.AUDIT_LOG}!A:L`, row);
        } catch (err) {
            logger.warn(`[SecuritySheets] Erro ao gravar AUDIT_LOG: ${err.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────
    // CONFIGURAÇÕES tab
    // ─────────────────────────────────────────────────────────

    /**
     * Read config from CONFIGURAÇÕES sheet. Uses a short TTL cache.
     * @returns {Object}
     */
    async getConfig() {
        const now = Date.now();
        if (this._configCache && (now - this._configCacheTime) < this._CONFIG_TTL) {
            return this._configCache;
        }

        try {
            const rows = await this.client.getRange(`${SECURITY_TABS.CONFIGURACOES}!A:C`);
            if (!rows || rows.length < 2) {
                return DEFAULT_CONFIG;
            }

            const config = { ...DEFAULT_CONFIG };
            rows.slice(1).forEach(row => {
                const key = String(row[0] || '').trim();
                const val = row[1];
                if (key && val !== undefined && val !== '') {
                    // Try numeric conversion
                    const num = parseFloat(val);
                    config[key] = isNaN(num) ? String(val).trim() : num;
                }
            });

            this._configCache = config;
            this._configCacheTime = now;
            logger.debug('[SecuritySheets] Configurações carregadas da planilha');
            return config;
        } catch (err) {
            logger.warn(`[SecuritySheets] Erro ao ler CONFIGURAÇÕES, usando padrão: ${err.message}`);
            return DEFAULT_CONFIG;
        }
    }

    // ─────────────────────────────────────────────────────────
    // ALERTAS tab
    // ─────────────────────────────────────────────────────────

    /**
     * Create an alert entry.
     * @param {Object} data
     */
    async createAlert(data) {
        try {
            const row = {
                id_alerta: `ALT_${Date.now()}`,
                timestamp: data.timestamp || new Date().toISOString(),
                tipo_alerta: data.tipoAlerta,
                severidade: data.severidade || 'Aviso',
                lead_id: data.leadId || '',
                descricao: data.descricao,
                acao_automatica: data.acaoAutomatica || '',
                status_alerta: 'Ativo',
                resolvido: 'Não',
                notas: data.notas || ''
            };
            await this.client.append(`${SECURITY_TABS.ALERTAS}!A:J`, row);
            logger.warn(`[SecuritySheets] ⚠️ ALERTA criado: [${data.severidade}] ${data.tipoAlerta} - Lead ${data.leadId || 'N/A'}`);
        } catch (err) {
            logger.error(`[SecuritySheets] Erro ao gravar ALERTAS: ${err.message}`);
        }
    }
}

module.exports = {
    securitySheets: new SecuritySheets(),
    SECURITY_TABS,
    BLOCKED_STATUSES,
    DEFAULT_CONFIG
};
