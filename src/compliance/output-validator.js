'use strict';

/**
 * OUTPUT VALIDATOR
 * Valida compliance comercial de toda resposta antes de enviar ao lead.
 * 
 * Regras aplicadas:
 * 1. Comprimento ≤ 150 chars (WhatsApp preview = ~160 chars)
 * 2. Máximo 1 pergunta
 * 3. Máximo 3 linhas visíveis
 * 4. Máximo 1 emoji
 * 5. Zero "AI markers" genéricos
 * 6. Se houver CTA, deve ser específico (data/hora, ação clara)
 * 7. Máximo 20 palavras sem CTA
 */

const logger = require('../config/logger');

class OutputValidator {
    
    /**
     * Valida compliance de uma mensagem
     * @param {string} reply - mensagem proposta
     * @param {Object} context - { stage, followUpDay }
     * @returns {Object} { valid, issues, score, recommendation }
     */
    validate(reply, context = {}) {
        const issues = [];
        const reply_str = String(reply || '').trim();
        
        if (!reply_str) {
            return {
                valid: false,
                issues: ['EMPTY: Resposta vazia'],
                score: 0,
                recommendation: 'USE_FALLBACK'
            };
        }
        
        // ─────────────────────────────────────────────────────────────────
        // RULE 1: Comprimento ≤ 150 caracteres
        // ─────────────────────────────────────────────────────────────────
        if (reply_str.length > 150) {
            issues.push(`LONG: ${reply_str.length} chars (max 150)`);
        }
        
        // ─────────────────────────────────────────────────────────────────
        // RULE 2: Máximo 1 pergunta
        // ─────────────────────────────────────────────────────────────────
        const questionCount = (reply_str.match(/\?/g) || []).length;
        if (questionCount > 1) {
            issues.push(`QUESTIONS: ${questionCount} found (max 1)`);
        }
        
        // ─────────────────────────────────────────────────────────────────
        // RULE 3: Máximo 3 linhas visíveis
        // ─────────────────────────────────────────────────────────────────
        const lineCount = reply_str.split('\n').length;
        if (lineCount > 3) {
            issues.push(`LINES: ${lineCount} (max 3)`);
        }
        
        // ─────────────────────────────────────────────────────────────────
        // RULE 4: Máximo 1 emoji (ou 0)
        // ─────────────────────────────────────────────────────────────────
        const emojiCount = (reply_str.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
        if (emojiCount > 1) {
            issues.push(`EMOJIS: ${emojiCount} (max 1)`);
        }
        
        // ─────────────────────────────────────────────────────────────────
        // RULE 5: Zero AI markers genéricos
        // ─────────────────────────────────────────────────────────────────
        const aiMarkers = [
            'assistente de ia',
            'como um assistente',
            'compreendo', 'entendo perfeitamente', 'gostaria', 
            'felizmente', 'certamente', 'agradecidamente', 'respeitosamente',
            'poderia ser interessante', 'teria prazer', 'seria ótimo',
            'tenho o prazer', 'fico feliz', 'adoraria'
        ];
        const foundMarker = aiMarkers.find(m => reply_str.toLowerCase().includes(m));
        if (foundMarker) {
            issues.push(`AI_TONE: "${foundMarker}" detected. Use direct language.`);
        }

        // ─────────────────────────────────────────────────────────────────
        // RULE 5.1: Bloquear placeholders/texto de template vazando ao lead
        // ─────────────────────────────────────────────────────────────────
        const unresolvedPlaceholder = /\{[^}]+\}|\[[^\]]+\]/.test(reply_str);
        const placeholderTokens = [
            'nome da empresa',
            'company name',
            'nome do lead',
            'lead name'
        ];
        const hasPlaceholderToken = placeholderTokens.some(t => reply_str.toLowerCase().includes(t));

        if (unresolvedPlaceholder || hasPlaceholderToken) {
            issues.push('PLACEHOLDER: unresolved template token detected.');
        }
        
        // ─────────────────────────────────────────────────────────────────
        // RULE 6: Se houver CTA, deve ser específico
        // ─────────────────────────────────────────────────────────────────
        const vagueClosings = ['quando quiser', 'se tiver horário', 'quando puder', 'sem pressa', 'quando conseguir'];
        const hasVagueCTA = vagueClosings.some(v => reply_str.toLowerCase().includes(v));
        if (hasVagueCTA && context.stage !== 'TOP_OF_FUNNEL') {
            issues.push('VAGUE_CTA: Use specific time or action.');
        }

        const genericClosings = [
            'aguardo seu feedback',
            'fico no aguardo',
            'qualquer coisa me avise',
            'vamos ver o que fazemos'
        ];
        const hasGenericClosing = genericClosings.some(v => reply_str.toLowerCase().includes(v));
        if (hasGenericClosing) {
            issues.push('GENERIC_CLOSE: closing too generic for SDR conversation.');
        }
        
        // ─────────────────────────────────────────────────────────────────
        // RULE 7: Máximo 20 palavras SEM CTA claro
        // ─────────────────────────────────────────────────────────────────
        const wordCount = reply_str.split(/\s+/).filter(w => w.length > 0).length;
        const hasClearCTA = this._hasClearCTA(reply_str);
        if (wordCount > 20 && !hasClearCTA && context.stage !== 'TOP_OF_FUNNEL') {
            issues.push(`EXPLANATION: ${wordCount} words without clear CTA.`);
        }
        
        // ─────────────────────────────────────────────────────────────────
        // RULE 8: D10 não pode deixar porta aberta
        // ─────────────────────────────────────────────────────────────────
        if (context.followUpDay === 10) {
            const openDoor = ['fico à disposição', 'deixo aberto', 'qualquer coisa', 'me chame'];
            const leavesOpen = openDoor.some(p => reply_str.toLowerCase().includes(p));
            if (leavesOpen) {
                issues.push('D10_NOT_FINAL: Day 10 must be terminal. No open door.');
            }
        }
        
        // ─────────────────────────────────────────────────────────────────
        // SCORE & RECOMMENDATION
        // ─────────────────────────────────────────────────────────────────
        const score = Math.max(0, 100 - issues.length * 15);
        
        return {
            valid: issues.length === 0,
            issues,
            score,
            recommendation: issues.length === 0 ? 'APPROVE' : 'REJECT_USE_FALLBACK',
            reply_length: reply_str.length,
            questions: questionCount,
            lines: lineCount,
            emojis: emojiCount
        };
    }
    
    /**
     * Retorna fallback seguro baseado no contexto
     */
    useFallback(context = {}) {
        const fallbacks = {
            'TOP_OF_FUNNEL': 'Oi! Sou SDR aqui da Klaus. Você teria 10 minutos pra conversa rápida?',
            'MIDDLE_OF_FUNNEL': 'Entendo. Qual seria o melhor horário essa semana pra gente conversar?',
            'BOTTOM_OF_FUNNEL': 'Perfeito! Segunda às 14h ou terça às 10h? Qual funciona?',
            'OBJECTION': 'Faz total sentido. Posso deixar uma opção: conversa de 20 min depois?',
            'D10_FINAL': 'Responde aí se fizer sentido — caso contrário, tudo bem. Fica meu contato aí.'
        };
        
        // Se é D10, usar fallback final
        if (context.followUpDay === 10) {
            return fallbacks['D10_FINAL'];
        }
        
        return fallbacks[context.stage] || fallbacks['MIDDLE_OF_FUNNEL'];
    }
    
    /**
     * Detecta se há CTA claro na mensagem
     */
    _hasClearCTA(text) {
        const ctas = [
            'marca', 'agende', 'confirma', 'segunda', 'terça', 'quarta', 'quinta', 'sexta',
            'horário', 'qual dia', 'qual horário', 'me liga', 'me ligue', 'pode me ligar',
            'vamos', 'podemos', 'call', 'minuto', 'min', 'conversa',
            '14h', '10h', '9h', '11h', '15h', '16h',  // horários específicos
            'agenda', 'marcar', 'agendar'
        ];
        return ctas.some(cta => text.toLowerCase().includes(cta));
    }
}

module.exports = new OutputValidator();
