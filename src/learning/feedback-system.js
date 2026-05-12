'use strict';

/**
 * FEEDBACK SYSTEM
 * Registra conversas bem-sucedidas e coleta feedback para o ciclo de aprendizado.
 *
 * Complementa o SDRLearning (playbooks por similaridade) que já existe em sdr-engine.js,
 * focando em análise de outcomes e feedback do Admin via Google Sheets.
 *
 * Uso: instanciar com o cliente de sheets ativo (crm-sheets ou analysis-log).
 */

const logger = require('../config/logger');

class FeedbackSystem {
    /**
     * @param {object} sheetsClient - Objeto com método append(tab, row) e read(tab)
     */
    constructor(sheetsClient = null) {
        this._sheets = sheetsClient;
        this._buffer = [];          // buffer local caso sheets não esteja disponível
    }

    /**
     * Registrar conversa com outcome definido (QUALIFIED, REJECTED, ESCALATED).
     * @param {object} lead
     * @param {Array<{role,content}>} conversation
     * @param {{ type: string, personas?: string[], playbooks?: string[], duration?: number }} outcome
     */
    /**
     * Registrar conversa com outcome definido (QUALIFIED, REJECTED, ESCALATED).
     * Aceita um único objeto com todos os dados.
     * @param {object} params - { lead, conversation, outcome }
     */
    async recordSuccessfulConversation(params) {
        const { lead, conversation, outcome } = params || {};

        if (!lead || !outcome) {
            logger.warn('[FEEDBACK] recordSuccessfulConversation: parâmetros inválidos (lead e outcome são obrigatórios)');
            return null;
        }

        const record = {
            timestamp: new Date().toISOString(),
            lead_id: lead.numero || lead.id,
            nome: lead.nome || lead.clinic_name || 'N/A',
            outcome: outcome.type,
            score: lead.score || 0,
            message_count: Array.isArray(conversation) ? conversation.length : 0,
            conversation_summary: this._summarize(conversation || []),
            personas_used: (outcome.personas || []).join(','),
            playbooks_used: (outcome.playbooks || []).join(','),
            time_to_outcome_ms: outcome.duration || 0,
            pain_points: (lead.objecoes || lead.pain_points || []).join(','),
        };

        this._buffer.push(record);

        if (this._sheets) {
            try {
                await this._sheets.append('successful_conversations', record);
            } catch (err) {
                logger.warn(`[FEEDBACK] Falha ao persistir no Sheets: ${err.message}`);
            }
        }

        logger.info(`[FEEDBACK] Conversa registrada: ${record.lead_id} → ${record.outcome}`);
        return record;
    }

    /**
     * Registrar feedback manual do Admin sobre uma conversa.
     * @param {string} leadId
     * @param {{ type: string, comment?: string, rating?: number, suggestion?: string }} feedback
     */
    async recordAdminFeedback(leadId, feedback) {
        const record = {
            timestamp: new Date().toISOString(),
            lead_id: leadId,
            feedback_type: feedback.type,      // POSITIVE | NEGATIVE | IMPROVEMENT
            comment: feedback.comment || '',
            rating: feedback.rating || null,   // 1-5
            suggested_improvement: feedback.suggestion || null
        };

        if (this._sheets) {
            try {
                await this._sheets.append('admin_feedback', record);
            } catch (err) {
                logger.warn(`[FEEDBACK] Falha ao persistir feedback no Sheets: ${err.message}`);
            }
        }

        logger.info(`[FEEDBACK] Feedback do Admin registrado: ${leadId}`);
        return record;
    }

    /**
     * Calcula taxa de sucesso a partir do buffer local (ou Sheets se disponível).
     */
    async getSuccessRate() {
        const conversations = this._sheets
            ? await this._sheets.read('successful_conversations').catch(() => this._buffer)
            : this._buffer;

        if (!conversations || conversations.length === 0) {
            return { total: 0, qualified: 0, rejected: 0, escalated: 0, success_rate: '0%' };
        }

        const qualified = conversations.filter(c => c.outcome === 'QUALIFIED').length;
        const rejected  = conversations.filter(c => c.outcome === 'REJECTED').length;
        const escalated = conversations.filter(c => c.outcome === 'ESCALATED').length;
        const total = conversations.length;

        return {
            total,
            qualified,
            rejected,
            escalated,
            success_rate: `${((qualified / total) * 100).toFixed(2)}%`
        };
    }

    /**
     * Retorna padrões das conversas qualificadas do buffer local.
     */
    async getSuccessPatterns() {
        const conversations = this._sheets
            ? await this._sheets.read('successful_conversations').catch(() => this._buffer)
            : this._buffer;

        const qualified = (conversations || []).filter(c => c.outcome === 'QUALIFIED');
        if (qualified.length === 0) return null;

        return {
            average_message_count: this._avg(qualified.map(c => Number(c.message_count) || 0)),
            average_score: this._avg(qualified.map(c => Number(c.score) || 0)),
            most_common_personas: this._topN(qualified.flatMap(c => (c.personas_used || '').split(',').filter(Boolean))),
            most_common_playbooks: this._topN(qualified.flatMap(c => (c.playbooks_used || '').split(',').filter(Boolean)))
        };
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _summarize(conversation) {
        if (!Array.isArray(conversation) || conversation.length === 0) return 'Sem histórico';
        const first = String(conversation[0]?.content || '').slice(0, 60);
        const last  = String(conversation[conversation.length - 1]?.content || '').slice(0, 60);
        return `Início: "${first}…" | Fim: "${last}…"`;
    }

    _avg(numbers) {
        if (!numbers.length) return 0;
        return Math.round(numbers.reduce((a, b) => a + b, 0) / numbers.length);
    }

    _topN(items, n = 5) {
        const counts = {};
        items.forEach(item => { counts[item] = (counts[item] || 0) + 1; });
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([item, count]) => ({ item, count }));
    }
}

module.exports = FeedbackSystem;
