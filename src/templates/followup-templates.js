'use strict';

/**
 * FOLLOW-UP TEMPLATES
 * Templates estruturadas para D1, D5, D10 sem chamada GPT.
 * 
 * Reduz custo em 100% e garante consistência comercial.
 * Usa seleção por: objeção + dias_decorridos + contexto.
 */

const logger = require('../config/logger');

const FOLLOWUP_TEMPLATES = {
    D1: {
        // Sem resposta, deixa porta aberta
        silent_no_response: {
            template: `Oi {nome}, deixo em aberto para quando fizer sentido na {empresa}. Se quiser, me chama por aqui.`,
            description: 'Lead silencioso — soft approach, não pressiona'
        },
        
        // Budget objection detected
        budget_objection: {
            template: `{nome}, entendo a questão de orçamento. Muitas vezes, o foco está no retorno. Faz sentido uma conversa rápida de 10 min?`,
            description: 'Lead com objeção de orçamento — reframe para value'
        },
        
        // Email request
        email_request: {
            template: `Claro. Para não te enviar algo genérico, prefiro alinhar em 10 min. Qual dia é melhor para você?`,
            description: 'Lead pediu email — ofereça call no lugar'
        },
        
        // No contact / gatekeeping
        gatekeeper: {
            template: `Perfeito. Você pode me indicar o responsável e o melhor contato para falar com ele?`,
            description: 'Lead é gatekeeper — pedir passagem para decisor'
        }
    },
    
    D5: {
        // Continue gentle (5 dias depois)
        continue_gentle: {
            template: `{nome}, sei que a rotina da {empresa} é corrida. Se fizer sentido retomar esse tema, estou por aqui.`,
            description: 'D5 silencioso — empatia + deixa porta aberta'
        },
        
        // Resposta negativa clara
        clear_rejection: {
            template: `Respeito sua decisão {nome}. Boa sorte na {empresa}! Se mudar de ideia, fico aqui.`,
            description: 'Lead respondeu não — respeitar + deixar aberto'
        },
        
        // Budget still blocking
        budget_still_blocking: {
            template: `{nome}, entendo. Posso te fazer uma pergunta rápida: qual o impacto de não resolver isso nas próximas semanas?`,
            description: 'Budget ainda é objeção — questionar custo de inação'
        }
    },
    
    D10: {
        // FINAL ATTEMPT — único chance
        final_last_touch: {
            template: `{nome}, esse é nosso último contato com a {empresa}. Se quiser conversar, responde aqui; se não, tudo bem.`,
            description: 'D10 — último toque, sem volta'
        },
        
        // Final mas empático
        final_empathetic: {
            template: `{nome}, entendo que timing pode não ser agora. Se mudar de ideia, você tem meu contato. Boa sorte na {empresa}!`,
            description: 'D10 empático — encerrar com marca positiva'
        }
    }
};

/**
 * Renderiza template substituindo variáveis
 * @param {string} dayKey - 'D1', 'D5', 'D10'
 * @param {string} templateName - nome do template (silent_no_response, budget_objection, etc)
 * @param {Object} vars - variáveis { nome, empresa, objecao, etc }
 * @returns {string} template renderizado
 */
function renderTemplate(dayKey, templateName, vars = {}) {
    const dayTemplates = FOLLOWUP_TEMPLATES[dayKey];
    
    if (!dayTemplates) {
        logger.error(`[TEMPLATES] Day not found: ${dayKey}. Using D5 generic.`);
        return renderTemplate('D5', 'continue_gentle', vars);
    }
    
    const template = dayTemplates[templateName];
    
    if (!template) {
        logger.warn(`[TEMPLATES] Template not found: ${dayKey}.${templateName}. Using generic D-${dayKey.slice(1)}.`);
        // Fallback para primeiro template do dia
        const firstTemplate = Object.values(dayTemplates)[0];
        return renderTemplate(dayKey, Object.keys(dayTemplates)[0], vars);
    }
    
    let result = template.template;
    
    // Substituir variáveis
    const safeVars = {
        nome: vars.nome || 'você',
        empresa: vars.empresa || 'sua empresa',
        ...vars
    };

    Object.entries(safeVars).forEach(([key, value]) => {
        const placeholder = `{${key}}`;
        result = result.replace(new RegExp(placeholder, 'g'), value || '');
    });

    // Remove placeholders que eventualmente sobrarem por variável ausente
    result = result.replace(/\{[^}]+\}/g, '').replace(/\s{2,}/g, ' ');
    
    return result.trim();
}

/**
 * Seleciona melhor template baseado em contexto
 * @param {string} dayKey - 'D1', 'D5', 'D10'
 * @param {Object} leadState - estado do lead (objections_met, etc)
 * @returns {string} nome do template a usar
 */
function selectTemplate(dayKey, leadState = {}) {
    const objections = leadState.objections_met || [];
    
    // D1 — 1º follow-up
    if (dayKey === 'D1') {
        if (objections.includes('budget')) return 'budget_objection';
        if (objections.includes('other')) return 'email_request';
        if (objections.includes('sem_budget')) return 'budget_objection';
        if (objections.includes('enviar_email')) return 'email_request';
        if (objections.includes('sem_contacto')) return 'gatekeeper';
        return 'silent_no_response';  // default
    }
    
    // D5 — 2º follow-up
    if (dayKey === 'D5') {
        if (objections.includes('nao_interesse')) return 'clear_rejection';
        if (objections.length >= 2 && objections.includes('sem_budget')) return 'budget_still_blocking';
        return 'continue_gentle';  // default
    }
    
    // D10 — FINAL
    if (dayKey === 'D10') {
        if (objections.includes('nao_interesse')) return 'final_empathetic';
        return 'final_last_touch';  // default (mais direto)
    }
    
    return 'continue_gentle';  // fallback universal
}

module.exports = {
    FOLLOWUP_TEMPLATES,
    renderTemplate,
    selectTemplate
};
