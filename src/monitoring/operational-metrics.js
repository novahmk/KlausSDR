'use strict';

const logger = require('../config/logger');
const { crmSheets, CRM_TABS } = require('../sheets/crm-sheets');
const { securitySheets } = require('../sheets/security-sheets');

class OperationalMetrics {
    async trackCommercialDecision(decisionData = {}) {
        const timestamp = new Date().toISOString();
        const leadId = decisionData.leadId || '';

        try {
            await crmSheets.appendRow(CRM_TABS.ANALISE, {
                lead_id: leadId,
                evento: 'PILAR3_COMMERCIAL_DECISION',
                timestamp_evento: timestamp,
                decisao: decisionData.decision || 'NO_ACTION',
                acao: decisionData.action || 'NONE',
                motivo_regra: decisionData.reason || 'NONE',
                prioridade: decisionData.priority || 'NONE',
                score_decisao: decisionData.score != null ? decisionData.score : '',
                stage_atual: decisionData.stage || '',
                analysis_type: decisionData.analysisType || '',
                objection: decisionData.objection || '',
                should_notify: decisionData.shouldNotify ? 'Sim' : 'Não',
                interactions: decisionData.interactions != null ? decisionData.interactions : 0,
                objections_count: decisionData.objectionsCount != null ? decisionData.objectionsCount : 0,
                matched_rules: Array.isArray(decisionData.matched) ? decisionData.matched.join(' | ') : '',
                legacy_signals: JSON.stringify(decisionData.legacySignals || {}),
                message_preview: decisionData.messagePreview || ''
            });
        } catch (err) {
            logger.warn(`[OperationalMetrics] Falha ao gravar ANÁLISE: ${err.message}`);
        }

        try {
            await securitySheets.appendAuditLog({
                timestamp,
                leadId,
                acao: decisionData.action || 'NONE',
                tipoAcao: 'PILAR3_COMMERCIAL_DECISION',
                statusAntes: decisionData.stage || '',
                statusDepois: decisionData.shouldNotify ? 'NOTIFIED' : 'NO_ACTION',
                autorizado: decisionData.shouldNotify ? 'Sim' : 'Não',
                motivo: `${decisionData.decision || 'NO_ACTION'}:${decisionData.reason || 'NONE'}:${decisionData.score != null ? decisionData.score : ''}`,
                usuarioIa: 'SDR_IA_PILAR3'
            });
        } catch (err) {
            logger.warn(`[OperationalMetrics] Falha ao gravar AUDIT_LOG: ${err.message}`);
        }

        await this._maybeCreateDecisionAlert(decisionData, timestamp);
    }

    async trackOutboundMessage(eventData = {}) {
        try {
            await crmSheets.appendRow(CRM_TABS.ANALISE, {
                lead_id: eventData.leadId || '',
                evento: 'PILAR3_OUTBOUND_MESSAGE',
                timestamp_evento: new Date().toISOString(),
                origem: eventData.source || 'unknown',
                stage_atual: eventData.stage || '',
                tamanho_resposta: eventData.replyLength != null ? eventData.replyLength : '',
                validation_score: eventData.validationScore != null ? eventData.validationScore : '',
                fallback_usado: eventData.fallbackUsed ? 'Sim' : 'Não',
                followup_day: eventData.followUpDay != null ? eventData.followUpDay : '',
                template: eventData.template || '',
                message_preview: eventData.messagePreview || ''
            });
        } catch (err) {
            logger.warn(`[OperationalMetrics] Falha ao gravar métrica de outbound: ${err.message}`);
        }
    }

    async _maybeCreateDecisionAlert(decisionData, timestamp) {
        const decision = decisionData.decision || 'NO_ACTION';
        const score = Number(decisionData.score || 0);

        if (decision === 'ESCALATE' && score >= 80) {
            await securitySheets.createAlert({
                timestamp,
                tipoAlerta: 'Escalonamento Crítico Pilar 3',
                severidade: 'Alta',
                leadId: decisionData.leadId || '',
                descricao: `Lead escalado com score ${score} em ${decisionData.stage || 'N/A'} (${decisionData.reason || 'sem_motivo'}).`,
                acaoAutomatica: 'VERIFICAR_IMEDIATAMENTE',
                notas: Array.isArray(decisionData.matched) ? decisionData.matched.join(' | ') : ''
            });
            return;
        }

        if (decision === 'REJECT' && score >= 100) {
            await securitySheets.createAlert({
                timestamp,
                tipoAlerta: 'Rejeição Explícita Pilar 3',
                severidade: 'Info',
                leadId: decisionData.leadId || '',
                descricao: `Lead rejeitou explicitamente a abordagem (${decisionData.reason || 'sem_motivo'}).`,
                acaoAutomatica: 'ENCERRAR_FLUXO',
                notas: decisionData.messagePreview || ''
            });
        }
    }
}

module.exports = new OperationalMetrics();