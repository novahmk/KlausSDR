'use strict';

/**
 * ESCALATION RULES
 * Critérios plugáveis de handoff e escalação para o SDR Klaus.
 *
 * Extrai a lógica que estava inline em sdr-state-machine.js
 * (_isHumanRequest, _isComplexObjection, _isQualificationComplete,
 *  _shouldEscalateToHuman) tornando-a reutilizável e testável.
 *
 * A state-machine continua sendo o orquestrador — estas regras
 * são consultadas por ela (ou por qualquer outro módulo).
 */

// ─── Critérios individuais ────────────────────────────────────────────────────

const ESCALATION_RULES = {

    // ── Lead pronto para Closer ──────────────────────────────────────────────
    HANDOFF: {
        name: 'Lead Qualificado',
        description: 'Lead demonstrou interesse em agendar reunião e tem decisor identificado.',
        action: 'HANDOFF',
        priority: 'IMMEDIATE',
        notification_template: 'QUALIFIED_LEAD',
        criteria: [
            {
                name: 'Score Alto',
                weight: 30,
                condition: lead => Number(lead.score || 0) >= 80
            },
            {
                name: 'Contato do Decisor',
                weight: 35,
                condition: lead => !!(lead.decisor_contact || lead.decision_maker_contact)
            },
            {
                name: 'Interesse Explícito em Agenda',
                weight: 20,
                condition: (lead, ctx) => {
                    const text = String(ctx && ctx.currentText || '').toLowerCase();
                    return _containsAny(text, ['agenda', 'marcar', 'reunião', 'reuniao', 'call', 'horário', 'horario', 'segunda', 'terça', 'terca'])
                        || String(ctx && ctx.analysis && ctx.analysis.tipo || '').toLowerCase() === 'resposta_positiva';
                }
            },
            {
                name: 'Fase Bottom of Funnel',
                weight: 15,
                condition: (lead, ctx) => String(ctx && ctx.stage || '').toUpperCase() === 'BOTTOM_OF_FUNNEL'
            }
        ]
    },

    // ── Lead preso com gatekeeper ────────────────────────────────────────────
    ESCALATION_LOOPING: {
        name: 'Escalonamento por Looping',
        description: 'Lead preso com gatekeeper resistente após várias interações.',
        action: 'ESCALATE',
        priority: 'HIGH',
        notification_template: 'ESCALATION_LOOPING',
        criteria: [
            {
                name: 'Muitas mensagens sem progresso',
                weight: 40,
                condition: lead => Number(lead.interacoes || lead.message_count || 0) >= 5
            },
            {
                name: 'Sem contato do decisor após 4 msgs',
                weight: 30,
                condition: lead => !lead.decisor_contact && !lead.decision_maker_contact
                    && Number(lead.interacoes || lead.message_count || 0) >= 4
            },
            {
                name: 'Múltiplas objeções',
                weight: 30,
                condition: lead => {
                    const objs = Array.isArray(lead.objecoes) ? lead.objecoes.length : 0;
                    return objs >= 2;
                }
            }
        ]
    },

    // ── Objeção técnica / pedido de humano ───────────────────────────────────
    ESCALATION_TECHNICAL: {
        name: 'Escalonamento Técnico',
        description: 'Lead com objeção técnica ou pediu falar com humano.',
        action: 'ESCALATE',
        priority: 'HIGH',
        notification_template: 'ESCALATION_TECHNICAL',
        criteria: [
            {
                name: 'Pedido de humano explícito',
                weight: 50,
                condition: (lead, ctx) => {
                    const text = String(ctx && ctx.currentText || '').toLowerCase();
                    return _containsAny(text, [
                        'falar com humano', 'quero falar com alguém', 'quero falar com alguem',
                        'pessoa real', 'atendente', 'humano', 'ligar', 'me liga', 'me ligue'
                    ]);
                }
            },
            {
                name: 'Objeção técnica/orçamento',
                weight: 50,
                condition: (lead, ctx) => {
                    const text = String(ctx && ctx.currentText || '').toLowerCase();
                    const objecao = String(ctx && ctx.analysis && ctx.analysis.objecao || '');
                    return _containsAny(text, ['jurídico', 'juridico', 'concorrente', 'contrato',
                        'integração', 'integracao', 'preço', 'preco', 'budget', 'orçamento', 'orcamento'])
                        || objecao === 'sem_budget';
                }
            }
        ]
    },

    // ── Rejeição definitiva ──────────────────────────────────────────────────
    REJECTION: {
        name: 'Rejeição',
        description: 'Lead rejeitou explicitamente a abordagem.',
        action: 'REJECT',
        priority: 'LOW',
        notification_template: null,
        criteria: [
            {
                name: 'Rejeição explícita',
                weight: 100,
                condition: (lead, ctx) => {
                    const text = String(ctx && ctx.currentText || '').toLowerCase();
                    return !!(lead.rejected)
                        || _containsAny(text, ['não tenho interesse', 'nao tenho interesse',
                            'sem interesse', 'me tira da lista', 'não entre em contato',
                            'não me contacte', 'pode parar de mandar']);
                }
            }
        ]
    }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _containsAny(text, keywords) {
    return keywords.some(kw => text.includes(kw));
}

function _evaluateRule(rule, lead, ctx) {
    let totalScore = 0;
    let totalWeight = 0;
    const matched = [];

    for (const criterion of rule.criteria) {
        totalWeight += criterion.weight;
        try {
            if (criterion.condition(lead, ctx)) {
                totalScore += criterion.weight;
                matched.push(criterion.name);
            }
        } catch (_) { /* critério ignorado por dados incompletos */ }
    }

    const pct = totalWeight > 0 ? Math.round((totalScore / totalWeight) * 100) : 0;
    return { action: rule.action, priority: rule.priority, score: pct, matched, notification_template: rule.notification_template };
}

// ─── Engine ───────────────────────────────────────────────────────────────────

class EscalationRulesEngine {
    /**
     * Avalia todas as regras e retorna a de maior score.
     * @param {object} lead
     * @param {object} [ctx] - { currentText, analysis, stage }
     * @returns {{ action, reason, priority, score, notification_template, matched }}
     */
    evaluate(lead = {}, ctx = {}) {
        let best = { score: -1 };
        let bestKey = '';

        for (const [key, rule] of Object.entries(ESCALATION_RULES)) {
            const result = _evaluateRule(rule, lead, ctx);
            if (result.score > best.score) {
                best = result;
                bestKey = key;
            }
        }

        return { ...best, reason: bestKey };
    }

    /** Retorna true se o lead deve ser entregue ao Closer (handoff). */
    shouldHandoff(lead, ctx) {
        const ev = this.evaluate(lead, ctx);
        return ev.action === 'HANDOFF' && ev.score >= 70;
    }

    /** Retorna true se o lead precisa de intervenção humana (escalação). */
    shouldEscalate(lead, ctx) {
        const ev = this.evaluate(lead, ctx);
        return ev.action === 'ESCALATE' && ev.score >= 50;
    }

    /** Retorna true se o lead deve ser marcado como rejeitado. */
    shouldReject(lead, ctx) {
        const ev = this.evaluate(lead, ctx);
        return ev.action === 'REJECT' && ev.score >= 60;
    }
}

module.exports = {
    ESCALATION_RULES,
    EscalationRulesEngine: new EscalationRulesEngine()
};
