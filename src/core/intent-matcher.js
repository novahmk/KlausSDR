'use strict';

/**
 * IntentMatcher — intercepts simple messages BEFORE calling GPT-4o.
 *
 * Fluxo:
 *   1. match(text) compara a mensagem com padrões regex por ordem de prioridade
 *   2. Se houver match, retorna { matched: true, intent, response, escalate }
 *   3. Caso contrário, retorna { matched: false } → o chamador deve chamar GPT-4o
 *
 * Ganho estimado: ~60% das mensagens resolvidas sem custo de API.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Definição de intents (ordem importa — primeiro match vence)
// ─────────────────────────────────────────────────────────────────────────────
const INTENTS = [

    // --- Recusas e finalizações ---
    {
        name: 'recusa_definitiva',
        patterns: [
            /n[ãa]o[,\s]+(obrigad[oa]|quero|preciso|tenho\s+interesse)/i,
            /sem\s+interesse/i,
            /n[ãa]o\s+tenho\s+interesse/i,
            /pode\s+parar\s+de\s+(me\s+)?mandar/i,
            /me\s+tira\s+da\s+lista/i,
            /n[ãa]o\s+me\s+contacte/i,
            /por\s+favor\s+n[ãa]o\s+me\s+(mande|envie)/i
        ],
        responses: [
            'Entendo, sem problema. Desculpe o incômodo e sucesso no seu trabalho!',
            'Tudo bem, sem pressão. Se mudar de ideia, fico à disposição!'
        ],
        escalate: false
    },

    // --- Agradecimentos ---
    {
        name: 'agradecimento',
        patterns: [
            /^(obrigad[oa]|obg|valeu|thanks?|muito\s+obrigad[oa]|mt\s+obg|grato|grata)[\s!.]*$/i,
            /^(ok[,\s]*)?(obrigad[oa]|valeu|grato|grata)[\s!.]*$/i
        ],
        responses: [
            'Disponha! Pode contar comigo.',
            'Por nada! Qualquer coisa é só chamar.',
            'Fico à disposição sempre que precisar!'
        ],
        escalate: false
    },

    // --- Confirmações simples (precisam de contexto → passa ao GPT) ---
    {
        name: 'confirmacao_simples',
        patterns: [
            /^(sim|yes|ok|certo|combinado|pode\s+ser|claro|com\s+certeza|perfeito|[oó]timo|t[aá]\s+bom|ta|tá|blz|beleza)[\s!.]*$/i
        ],
        responses: null  // null = delegar ao GPT para resposta contextual
    },

    // --- Saudações isoladas (contexto necessário → passa ao GPT) ---
    {
        name: 'saudacao',
        patterns: [
            /^(ol[aá]|oi|e\s+a[íi]|bom\s+dia|boa\s+tarde|boa\s+noite|hey|opa|eae|oie)[\s!.,]*$/i
        ],
        responses: null  // delegar ao GPT
    },

    // --- Pedido de horário de funcionamento ---
    {
        name: 'horario_funcionamento',
        patterns: [
            /qual\s*(é|e|o)\s*(o\s*)?hor[aá]rio/i,
            /hor[aá]rio\s*de\s*(atendimento|funcionamento|trabalho)/i,
            /que\s*horas?\s*(voc[eê]s?|aten[dt]em|abrem|fecham)/i,
            /quando\s*(voc[eê]s?\s*)?(atendem|abrem|fecham)/i
        ],
        responses: [
            'Nosso atendimento é de segunda a sexta, das 9h às 18h. Posso marcar uma conversa de 20 min para te apresentar melhor — qual o melhor dia para você?'
        ],
        escalate: false
    },

    // --- Consulta de agendamento ---
    {
        name: 'agendamento_query',
        patterns: [
            /cad[eê]\s*(o\s*|meu\s*)?agendamento/i,
            /quando\s*[eé]\s*(a|nossa|o)\s*(reuni[aã]o|call|conversa|bate[\s-]papo)/i,
            /que\s*horas?\s*[eé]\s*(a|nossa|o)\s*(reuni[aã]o|call|conversa)/i,
            /agendamento\s*(confirmado|marcado|ok)\??/i,
            /confirm[ae][ir]?\s*(a\s*)?(reuni[aã]o|call|conversa)/i
        ],
        responses: [
            'Deixa eu verificar aqui! Para localizar mais rápido — pode me confirmar seu nome completo?'
        ],
        requiresLookup: true,
        escalate: false
    },

    // --- Pedido de contato/email da empresa ---
    {
        name: 'contato_empresa',
        patterns: [
            /qual\s*(é|e|o)\s*(o\s*)?(email|e-mail|telefone|contato)\s*(de\s*voc[eê]s?)?/i,
            /(manda|envia|passa)\s*(o\s*)?(email|e-mail|telefone|contato)/i,
            /como\s*(eu\s*)?(entro\s*em\s*)?(contato|falo)\s*com\s*voc[eê]s?/i
        ],
        responses: [
            'O melhor jeito é conversarmos diretamente! Tenho um slot de 20 min essa semana — quer marcar para eu te passar tudo em detalhe?'
        ],
        escalate: false
    },

    // --- Mensagem vazia ou mídia sem texto ---
    {
        name: 'mensagem_vazia',
        patterns: [
            /^\[midia\s*(recebida|sem\s*transcricao)?\]$/i,
            /^\[mensagem\s*vazia\]$/i
        ],
        responses: [
            'Recebi aqui! Se quiser enviar uma mensagem de texto, fico à disposição.'
        ],
        escalate: false
    },

    // --- Aguardar / "já volto" ---
    {
        name: 'aguarde',
        patterns: [
            /^(um\s*momento|aguarda|espera\s*a[íi]|j[aá]\s*volto|vou\s*ver|vou\s*verif)[\s!.]*$/i
        ],
        responses: [
            'Claro, sem pressa! Estou aqui.',
            'Pode ir com calma, aguardo!'
        ],
        escalate: false
    },

    // --- Ok / entendido (acknowledgement sem conteúdo) ---
    {
        name: 'acknowledgement',
        patterns: [
            /^(entend[ií]|entendido|entendo|ciente|ok[\s!.]*|certo[\s!.]*)$/i
        ],
        responses: [
            'Ótimo! Fico por aqui se precisar de algo.',
            'Perfeito. Qualquer dúvida é só chamar!'
        ],
        escalate: false
    }
];

// ─────────────────────────────────────────────────────────────────────────────
// Classe principal
// ─────────────────────────────────────────────────────────────────────────────
class IntentMatcher {
    /**
     * Tenta encontrar um intent para a mensagem recebida.
     * @param {string} text  - Texto da mensagem do lead
     * @returns {{ matched: boolean, intent?: string, response?: string|null, escalate?: boolean, requiresLookup?: boolean }}
     */
    match(text) {
        const normalized = String(text || '').trim();
        if (!normalized) {
            return { matched: false };
        }

        for (const intent of INTENTS) {
            const hit = intent.patterns.some(pattern => pattern.test(normalized));
            if (!hit) continue;

            // Intent com responses=null → sinaliza que deve ir ao GPT mas registra o intent detectado
            if (intent.responses === null) {
                return {
                    matched: false,
                    intentDetected: intent.name
                };
            }

            return {
                matched: true,
                intent: intent.name,
                response: this._pickResponse(intent.responses),
                escalate: intent.escalate !== false ? true : false,
                requiresLookup: intent.requiresLookup || false
            };
        }

        return { matched: false };
    }

    /**
     * Seleciona uma resposta aleatória do array para adicionar variabilidade.
     * @param {string[]} responses
     * @returns {string}
     */
    _pickResponse(responses) {
        if (!Array.isArray(responses) || responses.length === 0) return '';
        return responses[Math.floor(Math.random() * responses.length)];
    }
}

module.exports = new IntentMatcher();
