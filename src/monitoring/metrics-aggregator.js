'use strict';

const logger = require('../config/logger');
const { crmSheets, CRM_TABS } = require('../sheets/crm-sheets');
const { securitySheets } = require('../sheets/security-sheets');

/**
 * Agregador de métricas por janela de tempo (hora/dia)
 * Lê raw metrics de ANÁLISE e consolida em agregações
 * Emite alertas quando degradação é detectada
 */
class MetricsAggregator {
    constructor() {
        this._lastAggregationTime = {};
        this._degradationThresholds = {
            fallbackRate: 0.30,          // 30%
            rejectRate: 0.40,            // 40%
            minValidationScore: 60,      // score médio < 60
            escalateCountHourly: 5       // >5 escalates em 1 hora
        };
    }

    /**
     * Processa agregações e alertas a cada ciclo
     * Chamado periodicamente (ex: a cada 5 mensagens ou 15 min)
     */
    async processAggregations(timeWindow = 'hourly') {
        try {
            const aggregatedData = await this._aggregateMetrics(timeWindow);
            if (!aggregatedData) return; // Sem dados novos

            logger.info(`[PILAR3_AGGREGATION] ${timeWindow.toUpperCase()}: ${JSON.stringify(aggregatedData, null, 2)}`);

            // Registra agregação
            await this._recordAggregation(aggregatedData, timeWindow);

            // Verifica degradação
            await this._checkDegradation(aggregatedData, timeWindow);
        } catch (err) {
            logger.warn(`[MetricsAggregator] Falha ao processar agregações: ${err.message}`);
        }
    }

    /**
     * Agrega métricas raw de ANÁLISE para período específico
     * @param {string} timeWindow 'hourly' ou 'daily'
     * @returns {Object} Agregação ou null
     */
    async _aggregateMetrics(timeWindow = 'hourly') {
        try {
            // Busca todas as linhas de ANÁLISE
            const rows = await crmSheets.getAll(CRM_TABS.ANALISE);
            if (!rows || rows.length < 2) return null; // Sem dados além do header

            // Remove header
            const dataRows = rows.slice(1);

            // Mapeia período de interesse
            const now = new Date();
            const periodStart = this._getPeriodStart(now, timeWindow);
            const periodEnd = new Date(periodStart.getTime() + this._getPeriodMs(timeWindow));

            // Filtra métricas do período
            const metricsInPeriod = dataRows
                .map(row => this._parseMetricRow(row, rows[0]))
                .filter(m => m && m.timestamp >= periodStart && m.timestamp < periodEnd);

            if (metricsInPeriod.length === 0) return null;

            // Agrega
            return this._computeAggregation(metricsInPeriod, timeWindow, periodStart);
        } catch (err) {
            logger.warn(`[MetricsAggregator] Falha ao agregar: ${err.message}`);
            return null;
        }
    }

    /**
     * Parse uma linha de métrica bruta
     * Retorna objeto com timestamp, origem, fallback, etc, ou null
     */
    _parseMetricRow(row, headers) {
        if (!row || !Array.isArray(row) || row.length < 2) return null;

        // Mapeia colunas (assumindo ordem: lead_id, evento, timestamp_evento, origem, stage, tamanho, score, fallback, ...)
        const timestampStr = row[2]; // timestamp_evento col
        if (!timestampStr) return null;

        try {
            const timestamp = new Date(timestampStr);
            const origem = row[3] || '';
            const fallbackStr = row[7] || 'Não'; // fallback_usado col
            const scoreStr = row[6] || '';

            // Apenas processa PILAR3_OUTBOUND_MESSAGE e PILAR3_COMMERCIAL_DECISION
            const evento = row[1] || '';
            if (!evento.includes('PILAR3')) return null;

            return {
                timestamp,
                evento,
                origem,
                fallbackUsed: fallbackStr.toLowerCase() === 'sim',
                validationScore: scoreStr ? parseInt(scoreStr, 10) : null,
                decisao: row[5] || '' // Para commercial decisions
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * Calcula agregação consolidada
     */
    _computeAggregation(metricsInPeriod, timeWindow, periodStart) {
        const outboundMsgs = metricsInPeriod.filter(m => m.evento === 'PILAR3_OUTBOUND_MESSAGE');
        const decisions = metricsInPeriod.filter(m => m.evento === 'PILAR3_COMMERCIAL_DECISION');

        // Estatísticas de outbound
        let fallbackCount = 0;
        let validScores = [];
        outboundMsgs.forEach(m => {
            if (m.fallbackUsed) fallbackCount++;
            if (m.validationScore !== null) validScores.push(m.validationScore);
        });

        const fallbackRate = outboundMsgs.length > 0 ? fallbackCount / outboundMsgs.length : 0;
        const avgValidationScore = validScores.length > 0 
            ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length)
            : 0;

        // Estatísticas de decisões
        const escalateCount = decisions.filter(d => d.decisao === 'ESCALATE').length;
        const rejectCount = decisions.filter(d => d.decisao === 'REJECT').length;
        const rejectRate = decisions.length > 0 ? rejectCount / decisions.length : 0;

        const aggregation = {
            period: timeWindow,
            periodStart: periodStart.toISOString(),
            totalOutboundMessages: outboundMsgs.length,
            totalDecisions: decisions.length,
            fallbackCount,
            fallbackRate: +(fallbackRate.toFixed(2)),
            avgValidationScore,
            escalateCount,
            rejectCount,
            rejectRate: +(rejectRate.toFixed(2)),
            gptOriginMessages: outboundMsgs.filter(m => m.origem === 'openai').length,
            templateOriginMessages: outboundMsgs.filter(m => m.origem === 'template').length,
            metricsCount: metricsInPeriod.length
        };

        return aggregation;
    }

    /**
     * Registra agregação na aba ANÁLISE
     */
    async _recordAggregation(aggregation, timeWindow) {
        try {
            await crmSheets.appendRow(CRM_TABS.ANALISE, {
                lead_id: 'AGREGAÇÃO_' + timeWindow.toUpperCase(),
                evento: `PILAR3_AGGREGATION_${timeWindow.toUpperCase()}`,
                timestamp_evento: new Date().toISOString(),
                origem: 'system',
                stage_atual: 'SISTEMA',
                tamanho_resposta: aggregation.totalOutboundMessages,
                validation_score: aggregation.avgValidationScore,
                fallback_usado: `${+(aggregation.fallbackRate * 100).toFixed(1)}%`,
                followup_day: '',
                template: `Reject: ${aggregation.rejectRate * 100}% | Escalate: ${aggregation.escalateCount}`,
                message_preview: JSON.stringify(aggregation)
            });
            logger.debug(`[PILAR3_AGGREGATION] Registrada agregação ${timeWindow}`);
        } catch (err) {
            logger.warn(`[MetricsAggregator] Falha ao registrar agregação: ${err.message}`);
        }
    }

    /**
     * Verifica degradação contra thresholds
     */
    async _checkDegradation(aggregation, timeWindow) {
        const alerts = [];

        // Fallback rate excessive
        if (aggregation.fallbackRate > this._degradationThresholds.fallbackRate) {
            alerts.push({
                type: 'FALLBACK_DEGRADATION',
                severity: 'Média',
                metric: `Fallback rate ${+(aggregation.fallbackRate * 100).toFixed(1)}% > ${+(this._degradationThresholds.fallbackRate * 100).toFixed(1)}%`,
                count: aggregation.fallbackCount,
                recommendation: 'Revisar qualidade do LLM ou templates; increase tuning parameters'
            });
        }

        // Reject rate excessive
        if (aggregation.rejectRate > this._degradationThresholds.rejectRate) {
            alerts.push({
                type: 'REJECT_DEGRADATION',
                severity: 'Alta',
                metric: `Reject rate ${+(aggregation.rejectRate * 100).toFixed(1)}% > ${+(this._degradationThresholds.rejectRate * 100).toFixed(1)}%`,
                count: aggregation.rejectCount,
                recommendation: 'Revisar regras de rejeição; validar persona selector'
            });
        }

        // Low validation score
        if (aggregation.avgValidationScore < this._degradationThresholds.minValidationScore) {
            alerts.push({
                type: 'VALIDATION_SCORE_LOW',
                severity: 'Média',
                metric: `Average validation score ${aggregation.avgValidationScore} < ${this._degradationThresholds.minValidationScore}`,
                count: aggregation.totalOutboundMessages,
                recommendation: 'Aumentar rigor das regras de validação ou revisar GPT output'
            });
        }

        // Escalonamentos excessive
        if (timeWindow === 'hourly' && aggregation.escalateCount > this._degradationThresholds.escalateCountHourly) {
            alerts.push({
                type: 'ESCALATE_SPIKE',
                severity: 'Média',
                metric: `Escalate count ${aggregation.escalateCount} > ${this._degradationThresholds.escalateCountHourly}/hour`,
                count: aggregation.escalateCount,
                recommendation: 'Verificar padrões anomalos; considerar revisar thresholds de escalação'
            });
        }

        // Cria alertas
        for (const alert of alerts) {
            await this._createDegradationAlert(alert, aggregation, timeWindow);
        }
    }

    /**
     * Cria alerta de degradação em ALERTA tab
     */
    async _createDegradationAlert(alert, aggregation, timeWindow) {
        try {
            await securitySheets.createAlert({
                timestamp: new Date().toISOString(),
                tipoAlerta: `Pilar 3 - ${alert.type}`,
                severidade: alert.severity,
                leadId: 'SISTEMA',
                descricao: `${alert.metric} no período ${timeWindow}. ${alert.count} ocorrências.`,
                acaoAutomatica: alert.type === 'REJECT_DEGRADATION' ? 'REVISAR_IMEDIATAMENTE' : 'MONITORAR',
                notas: alert.recommendation
            });
            logger.warn(`[PILAR3_DEGRADATION_ALERT] ${alert.type}: ${alert.metric}`);
        } catch (err) {
            logger.warn(`[MetricsAggregator] Falha ao criar alerta: ${err.message}`);
        }
    }

    /**
     * Retorna início do período (hora/dia atual)
     */
    _getPeriodStart(now, timeWindow) {
        if (timeWindow === 'hourly') {
            const start = new Date(now);
            start.setMinutes(0, 0, 0);
            // Retorna início da última hora completa
            start.setHours(start.getHours() - 1);
            return start;
        } else if (timeWindow === 'daily') {
            const start = new Date(now);
            start.setHours(0, 0, 0, 0);
            // Retorna início do dia anterior
            start.setDate(start.getDate() - 1);
            return start;
        }
        return now;
    }

    /**
     * Retorna duração do período em ms
     */
    _getPeriodMs(timeWindow) {
        if (timeWindow === 'hourly') return 60 * 60 * 1000; // 1 hora
        if (timeWindow === 'daily') return 24 * 60 * 60 * 1000; // 1 dia
        return 60 * 60 * 1000;
    }

    /**
     * Configura thresholds customizados
     */
    setDegradationThresholds(thresholds) {
        Object.assign(this._degradationThresholds, thresholds);
        logger.info(`[MetricsAggregator] Thresholds atualizados: ${JSON.stringify(this._degradationThresholds)}`);
    }
}

module.exports = new MetricsAggregator();
