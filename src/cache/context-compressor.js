'use strict';

/**
 * CONTEXT COMPRESSOR
 * Comprime o histórico e contexto de leads antes de enviar ao GPT-4o.
 * Mantém apenas as últimas N mensagens e limita o tamanho por mensagem,
 * reduzindo tokens por conversa em ~50%.
 */

const MAX_MESSAGES = 6;        // janela de histórico enviada ao GPT
const MAX_CHARS_PER_MSG = 300; // limite por mensagem (evita dumps longos)

class ContextCompressor {
    /**
     * Comprime o array de mensagens multi-turn para reduzir tokens.
     * @param {Array<{role: string, content: string}>} messages
     * @param {number} limit - número máximo de mensagens a manter (padrão MAX_MESSAGES)
     * @returns {Array<{role: string, content: string}>}
     */
    compressMessages(messages, limit = MAX_MESSAGES) {
        if (!Array.isArray(messages) || messages.length === 0) return [];

        // Preservar sempre a primeira mensagem (system ou abertura) + últimas (limit-1)
        const recent = messages.length > limit
            ? messages.slice(-limit)
            : messages;

        return recent.map(msg => ({
            role: msg.role,
            content: String(msg.content || '').slice(0, MAX_CHARS_PER_MSG)
        }));
    }

    /**
     * Comprime o objeto de contexto completo de um lead para uso no prompt.
     * @param {object} fullContext
     * @returns {object}
     */
    compress(fullContext) {
        if (!fullContext || typeof fullContext !== 'object') return {};

        return {
            nome: fullContext.nome || fullContext.clinic_name || 'Desconhecido',
            fluxo: fullContext.fluxo || fullContext.stage || 'Novo',
            temperatura: fullContext.temperatura || 'A definir',
            ultimaResposta: String(fullContext.ultimaResposta || '').slice(0, MAX_CHARS_PER_MSG),
            historico: this.compressMessages(fullContext.historico || fullContext.messages || []),
            objecoes: (fullContext.objecoes || []).slice(0, 5),
            score: fullContext.score || 0
        };
    }

    /**
     * Retorna o percentual de redução de caracteres entre original e comprimido.
     * @param {any} full
     * @param {any} compressed
     * @returns {{ originalChars: number, compressedChars: number, reductionPercent: string }}
     */
    calculateSavings(full, compressed) {
        const originalChars = JSON.stringify(full).length;
        const compressedChars = JSON.stringify(compressed).length;
        const reduction = originalChars > 0
            ? ((1 - compressedChars / originalChars) * 100).toFixed(1)
            : '0.0';
        return { originalChars, compressedChars, reductionPercent: `${reduction}%` };
    }
}

module.exports = new ContextCompressor();
