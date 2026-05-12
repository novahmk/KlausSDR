'use strict';

/**
 * PERSONA SELECTOR
 * Seleciona persona dinâmica baseado no estado do lead.
 * Integra com o sistema de fases existente em sdr-engine.js
 * (FASE_CONTEXTS / OBJECTION_CONTEXTS) sem duplicar lógica.
 */

const PERSONAS = require('./persona-templates');

class PersonaSelector {
    /**
     * Seleciona a persona mais adequada para o lead e contexto atual.
     * @param {object} opts
     * @param {string} opts.fase    - fase detectada pelo detectarFase() do sdr-engine
     * @param {string} opts.objecao - objeção normalizada (ou vazia)
     * @param {number} opts.score   - score do lead (0-100)
     * @param {number} opts.numObjecoes - total de objeções registradas
     * @returns {{ key: string } & PersonaTemplate}
     */
    select({ fase = '', objecao = '', score = 50, numObjecoes = 0 } = {}) {
        const scores = {};

        for (const [key, persona] of Object.entries(PERSONAS)) {
            scores[key] = this._score(persona, { fase, objecao, score, numObjecoes });
        }

        const bestKey = Object.keys(scores).reduce((a, b) => scores[a] >= scores[b] ? a : b);

        return { key: bestKey, matchScore: scores[bestKey], ...PERSONAS[bestKey] };
    }

    /**
     * Calcula pontuação de adequação de uma persona ao contexto.
     * @private
     */
    _score(persona, { fase, objecao, score, numObjecoes }) {
        const t = persona.triggers;
        let pts = 0;

        // Fase bate com o trigger
        if (Array.isArray(t.phases) && t.phases.includes(fase)) pts += 35;

        // Objeção atual corresponde
        if (Array.isArray(t.objections) && objecao && t.objections.includes(objecao)) pts += 30;

        // Score mínimo satisfeito
        if (t.scoreMin !== undefined && score >= t.scoreMin) pts += 20;

        // Score máximo não excedido
        if (t.scoreMax !== undefined && score <= t.scoreMax) pts += 10;

        // Múltiplas objeções → favorece EMPATIA
        if (t.multipleObjections && numObjecoes >= 2) pts += 25;

        return pts;
    }

    /**
     * Gera bloco de instrução de persona para injetar no system prompt.
     * @param {object} persona - resultado de select()
     * @param {object} context - { ultimaResposta?, fluxo?, nome? }
     * @returns {string}
     */
    generatePromptBlock(persona, context = {}) {
        const opening = this._pick(persona.openings);
        const example = this._pick(persona.examples);
        const closing = this._pick(persona.closing);

        return [
            `[PERSONA ATIVA: ${persona.name}]`,
            `Tom: ${persona.style.tone}`,
            `Regras: máx ${persona.style.sentence_max} frases | ${persona.style.emoji_count} emoji | ${persona.style.question_per_message} pergunta por mensagem`,
            `Abordagem: ${persona.style.approach}`,
            `Abertura sugerida: "${opening}"`,
            `Exemplo de resposta ideal: "${example}"`,
            `Fechamento sugerido: "${closing}"`,
            '[FIM DA PERSONA]'
        ].join('\n');
    }

    /**
     * Seleciona um item aleatório de um array.
     * @private
     */
    _pick(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return '';
        return arr[Math.floor(Math.random() * arr.length)];
    }
}

module.exports = new PersonaSelector();
