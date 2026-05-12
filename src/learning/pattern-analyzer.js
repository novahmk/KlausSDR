'use strict';

/**
 * PATTERN ANALYZER
 * Analisa padrões de conversas bem-sucedidas e gera recomendações.
 * Alimenta a atualização de personas, playbooks e regras de escalação.
 */

class PatternAnalyzer {
    /**
     * Analisa um array de conversas qualificadas e retorna insights.
     * Requer mínimo de 5 conversas para produzir resultados confiáveis.
     * @param {object[]} conversations
     * @returns {object}
     */
    analyzeSuccessPatterns(conversations) {
        if (!Array.isArray(conversations) || conversations.length < 5) {
            return {
                status: 'INSUFFICIENT_DATA',
                message: `Precisa de pelo menos 5 conversas (atual: ${(conversations || []).length})`
            };
        }

        return {
            status: 'OK',
            timestamp: new Date().toISOString(),
            total_conversations: conversations.length,
            persona_effectiveness: this.analyzePersonaEffectiveness(conversations),
            playbook_effectiveness: this.analyzePlaybookEffectiveness(conversations),
            message_patterns: this.analyzeMessagePatterns(conversations),
            timing_patterns: this.analyzeTimingPatterns(conversations),
            recommendations: this.generateRecommendations(conversations)
        };
    }

    /**
     * Efetividade por persona (média de score por persona usada).
     */
    analyzePersonaEffectiveness(conversations) {
        return this._aggregateByField(conversations, 'personas_used');
    }

    /**
     * Efetividade por playbook.
     */
    analyzePlaybookEffectiveness(conversations) {
        return this._aggregateByField(conversations, 'playbooks_used');
    }

    /**
     * Padrões relacionados ao número de mensagens por conversa.
     */
    analyzeMessagePatterns(conversations) {
        const counts = conversations.map(c => Number(c.message_count) || 0);
        return {
            average: Math.round(counts.reduce((a, b) => a + b, 0) / counts.length),
            min: Math.min(...counts),
            max: Math.max(...counts),
            median: this._median(counts),
            insight: 'Conversas mais curtas tendem a ter melhor taxa de conversão'
        };
    }

    /**
     * Padrões relacionados ao tempo até o outcome.
     */
    analyzeTimingPatterns(conversations) {
        const durations = conversations.map(c => Number(c.time_to_outcome_ms) || 0).filter(d => d > 0);
        if (!durations.length) return { insight: 'Sem dados de duração disponíveis' };

        const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
        return {
            average_ms: avg,
            average_min: Math.round(avg / 60_000),
            fastest_ms: Math.min(...durations),
            slowest_ms: Math.max(...durations),
            insight: 'Qualificações mais rápidas indicam leads mais quentes'
        };
    }

    /**
     * Recomendações automáticas baseadas nos padrões detectados.
     */
    generateRecommendations(conversations) {
        const recs = [];

        const avgMessages = conversations.reduce((s, c) => s + (Number(c.message_count) || 0), 0) / conversations.length;
        if (avgMessages > 8) {
            recs.push({
                priority: 'HIGH',
                type: 'MESSAGE_LENGTH',
                recommendation: 'Conversas estão longas demais. Qualificar com menos mensagens.',
                action: 'Revisar playbooks para detectar interesse mais cedo'
            });
        }

        const personaStats = this.analyzePersonaEffectiveness(conversations);
        const bestPersona = Object.entries(personaStats).sort((a, b) => b[1].avgScore - a[1].avgScore)[0];
        if (bestPersona) {
            recs.push({
                priority: 'MEDIUM',
                type: 'PERSONA_RECOMMENDATION',
                recommendation: `Persona "${bestPersona[0]}" tem score médio mais alto (${bestPersona[1].avgScore})`,
                action: 'Aumentar uso desta persona em conversas similares'
            });
        }

        return recs;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Agrega score médio por valor de um campo delimitado por vírgula.
     * Ex: campo "personas_used" = "CONSULTIVO,AUTORIDADE"
     */
    _aggregateByField(conversations, field) {
        const stats = {};
        conversations.forEach(conv => {
            const items = String(conv[field] || '').split(',').map(s => s.trim()).filter(Boolean);
            items.forEach(item => {
                if (!stats[item]) stats[item] = { count: 0, totalScore: 0 };
                stats[item].count++;
                stats[item].totalScore += Number(conv.score) || 0;
            });
        });
        const result = {};
        for (const [key, val] of Object.entries(stats)) {
            result[key] = { count: val.count, avgScore: Math.round(val.totalScore / val.count) };
        }
        return result;
    }

    _median(numbers) {
        const sorted = [...numbers].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
}

module.exports = new PatternAnalyzer();
