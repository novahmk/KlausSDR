'use strict';

/**
 * NOTIFICATION BUILDER
 * Constrói payloads de notificação estruturados para o Admin.
 * Complementa a lógica existente em sdr-state-machine._notifyAdminPayload().
 */

class NotificationBuilder {
    /**
     * Notificação para lead qualificado pronto para Closer.
     * @param {object} lead
     * @param {object} evaluation - resultado de EscalationRulesEngine.evaluate()
     * @returns {object}
     */
    buildQualifiedLeadNotification(lead, evaluation) {
        return {
            type: 'QUALIFIED_LEAD',
            priority: 'IMMEDIATE',
            timestamp: new Date().toISOString(),
            lead_info: {
                id: lead.numero || lead.id,
                nome: lead.nome || lead.clinic_name,
                phone: lead.numero || lead.phone,
                decisor: lead.decisor_name || lead.decision_maker_name,
                decisor_contact: lead.decisor_contact || lead.decision_maker_contact
            },
            qualification: {
                score: lead.score || 0,
                fluxo: lead.fluxo || lead.stage,
                temperatura: lead.temperatura,
                objecoes: lead.objecoes || []
            },
            action_required: {
                action: 'CONTACT_IMMEDIATELY',
                suggested_message: this._suggestedMessage(lead),
                next_steps: [
                    '1. Contatar decisor no número fornecido',
                    '2. Validar interesse em proposta',
                    '3. Agendar apresentação',
                    '4. Enviar proposta comercial'
                ]
            },
            metadata: {
                evaluation_score: evaluation.score,
                matched: evaluation.matched || [],
                reason: evaluation.reason
            }
        };
    }

    /**
     * Notificação para leads que precisam de intervenção humana.
     * @param {object} lead
     * @param {object} evaluation
     * @returns {object}
     */
    buildEscalationNotification(lead, evaluation) {
        return {
            type: 'ESCALATION',
            priority: 'HIGH',
            timestamp: new Date().toISOString(),
            lead_info: {
                id: lead.numero || lead.id,
                nome: lead.nome || lead.clinic_name,
                phone: lead.numero || lead.phone
            },
            escalation_reason: {
                reason: evaluation.reason,
                description: this._reasonDescription(evaluation.reason),
                matched: evaluation.matched || []
            },
            action_required: {
                action: 'MANUAL_INTERVENTION',
                suggested_approach: this._suggestedApproach(evaluation.reason),
                next_steps: [
                    '1. Revisar histórico da conversa',
                    '2. Identificar barreira principal',
                    '3. Contatar com abordagem diferente',
                    '4. Tentar contato direto com decisor'
                ]
            },
            metadata: {
                evaluation_score: evaluation.score,
                reason: evaluation.reason,
                interacoes: lead.interacoes || 0,
                ultima_resposta: String(lead.ultimaResposta || '').slice(0, 120)
            }
        };
    }

    /**
     * Serializa notificação para append no Google Sheets.
     * @param {object} notification
     * @returns {object}
     */
    formatForSheets(notification) {
        return {
            timestamp: notification.timestamp,
            type: notification.type,
            priority: notification.priority,
            lead_id: notification.lead_info.id,
            nome: notification.lead_info.nome,
            phone: notification.lead_info.phone,
            reason: notification.escalation_reason?.reason || notification.type,
            score: notification.metadata.evaluation_score,
            action: notification.action_required.action,
            status: 'PENDING'
        };
    }

    // ── Helpers privados ───────────────────────────────────────────────────────

    _suggestedMessage(lead) {
        const nome = lead.decisor_name || lead.decision_maker_name || 'Responsável';
        return `Olá ${nome}! Sou Klaus, SDR da NOVAH Assessoria Estratégica. Gostaria de apresentar uma estratégia que pode aumentar seus agendamentos. Você teria 5 minutos?`;
    }

    _suggestedApproach(reason) {
        const map = {
            ESCALATION_LOOPING: 'Lead em loop com gatekeeper. Tente contato direto com decisor ou ofereça diagnóstico gratuito.',
            ESCALATION_TECHNICAL: 'Objeção técnica. Demonstre expertise e compartilhe case de clínica similar.',
            REJECTION: 'Lead rejeitou. Manter em lista de reativação para contato em 90 dias.'
        };
        return map[reason] || 'Revisar histórico e tentar abordagem diferente.';
    }

    _reasonDescription(reason) {
        const map = {
            ESCALATION_LOOPING: 'Lead preso em loop com gatekeeper, sem progresso',
            ESCALATION_TECHNICAL: 'Lead com objeção técnica ou pediu falar com humano',
            REJECTION: 'Lead rejeitou explicitamente a abordagem'
        };
        return map[reason] || 'Escalonamento necessário';
    }
}

module.exports = new NotificationBuilder();
