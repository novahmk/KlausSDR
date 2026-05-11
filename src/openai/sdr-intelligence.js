'use strict';

const FASE_CONTEXTS = Object.freeze({
    fase_1_abordagem: [
        '[FASE CONVERSACIONAL 1 - ABORDAGEM INICIAL]',
        'Objetivo: despertar interesse com abertura direta e personalizada.',
        'Nao mencione precos, detalhes tecnicos profundos ou pressione por reuniao na primeira mensagem.',
        'Seja breve (maximo 3 linhas) e foque em uma dor relevante do mercado.',
        'Encerre com uma pergunta aberta que convide resposta.',
        '[FIM DA FASE 1]'
    ].join('\n'),

    fase_2_qualificacao: [
        '[FASE CONVERSACIONAL 2 - QUALIFICACAO]',
        'Objetivo: aprofundar contexto do lead com leveza e escuta ativa.',
        'Demonstre entendimento antes de perguntar.',
        'Faca no maximo uma pergunta por mensagem.',
        'Descubra: decisor, problema atual e urgencia percebida.',
        '[FIM DA FASE 2]'
    ].join('\n'),

    fase_3_conversao: [
        '[FASE CONVERSACIONAL 3 - CONVERSAO/AGENDAMENTO]',
        'Objetivo: propor o proximo passo (call/reuniao de 20-30 min).',
        'Se houver interesse ou fit, sugira dia e horario especificos.',
        'Reforce o valor da conversa rapida versus envio de material generico.',
        '[FIM DA FASE 3]'
    ].join('\n')
});

const OBJECTION_CONTEXTS = Object.freeze({
    sem_budget: [
        '[OBJECAO: SEM ORCAMENTO]',
        'Estrategia:',
        '1. Valide a preocupacao sem descartar.',
        '2. Reframe: qual o custo de nao resolver agora?',
        '3. Evite falar de preco; proponha conversa curta para entender contexto.',
        '4. Deixe porta aberta para novo contato em 30 dias.',
        '[FIM DA ESTRATEGIA]'
    ].join('\n'),

    fornecedor_existente: [
        '[OBJECAO: JA POSSUI FORNECEDOR]',
        'Estrategia:',
        '1. Valide a escolha atual sem atacar concorrente.',
        '2. Pergunte o que ainda pode melhorar na solucao atual.',
        '3. Posicione um diferencial especifico e relevante.',
        '4. Proponha conversa comparativa rapida, sem compromisso.',
        '[FIM DA ESTRATEGIA]'
    ].join('\n'),

    enviar_email: [
        '[OBJECAO: PREFERE EMAIL]',
        'Estrategia:',
        '1. Aceite o pedido e explique que 10 min melhoram a personalizacao.',
        '2. Reforce que email generico perde contexto.',
        '3. Ofereca dois horarios objetivos para conversa rapida.',
        '[FIM DA ESTRATEGIA]'
    ].join('\n'),

    nao_interesse: [
        '[OBJECAO: SEM INTERESSE/NAO E MOMENTO]',
        'Estrategia:',
        '1. Respeite o momento e nao force.',
        '2. Plante uma semente com resultado de mercado generico e plausivel.',
        '3. Pergunte permissao para retomar em alguns meses.',
        '4. Feche com tom positivo e profissional.',
        '[FIM DA ESTRATEGIA]'
    ].join('\n'),

    satisfeito: [
        '[OBJECAO: SATISFEITO COM STATUS ATUAL]',
        'Estrategia:',
        '1. Reconheca o bom momento do lead.',
        '2. Pergunte o que esta funcionando para gerar escuta ativa.',
        '3. Traga um gap potencial com sutileza.',
        '4. Convide para conversa de benchmarking.',
        '[FIM DA ESTRATEGIA]'
    ].join('\n'),

    sem_contacto: [
        '[OBJECAO: ATENDENTE NAO PASSA AO DECISOR]',
        'Estrategia:',
        '1. Seja empatico com o atendente.',
        '2. Peca nome e melhor forma de contato do responsavel.',
        '3. Ofereca agendar horario objetivo para a area responsavel.',
        '4. Deixe um gancho de valor facil de repassar.',
        '[FIM DA ESTRATEGIA]'
    ].join('\n')
});

const PHASE_BY_FLOW_ALIAS = Object.freeze({
    'novo': 'fase_1_abordagem',
    'cenario 1': 'fase_1_abordagem',
    'follow up d1': 'fase_2_qualificacao',
    'cenario 2': 'fase_2_qualificacao',
    'follow up d5': 'fase_2_qualificacao',
    'cenario 3': 'fase_2_qualificacao',
    'follow up d10': 'fase_2_qualificacao',
    'cenario 4': 'fase_2_qualificacao',
    'cenario 5': 'fase_2_qualificacao',
    'cenario 6': 'fase_3_conversao',
    'abordagem inicial': 'fase_1_abordagem',
    'qualificacao': 'fase_2_qualificacao',
    'conversao': 'fase_3_conversao',
    'agendamento': 'fase_3_conversao'
});

const OBJECTION_ALIAS = Object.freeze({
    'sem interesse': 'nao_interesse',
    'nao interesse': 'nao_interesse',
    'nao tenho interesse': 'nao_interesse',
    'nao preciso': 'nao_interesse',
    'nao quero': 'nao_interesse',
    'agora nao': 'nao_interesse',
    'sem prioridade': 'nao_interesse',
    'nao e momento': 'nao_interesse',
    'retornar depois': 'nao_interesse',
    'me chama depois': 'nao_interesse',
    'enviar email': 'enviar_email',
    'envie por email': 'enviar_email',
    'prefere email': 'enviar_email',
    'manda por email': 'enviar_email',
    'me mande por email': 'enviar_email',
    'ja tem fornecedor': 'fornecedor_existente',
    'ja possuo fornecedor': 'fornecedor_existente',
    'fornecedor': 'fornecedor_existente',
    'atendido por agencia': 'fornecedor_existente',
    'atendido por agencia parceira': 'fornecedor_existente',
    'sem orcamento': 'sem_budget',
    'sem budget': 'sem_budget',
    'sem verba': 'sem_budget',
    'sem caixa': 'sem_budget',
    'nao tenho verba': 'sem_budget',
    'nao tenho orcamento': 'sem_budget',
    'satisfeito': 'satisfeito',
    'estou satisfeito': 'satisfeito',
    'esta tudo bem assim': 'satisfeito',
    'fale com atendente': 'sem_contacto',
    'nao posso passar contato': 'sem_contacto',
    'nao sou o responsavel': 'sem_contacto',
    'fale com recepcao': 'sem_contacto'
});

function detectarFase(lead) {
    const faseSalva = _clean(lead && lead.fase);
    if (faseSalva && FASE_CONTEXTS[faseSalva]) return faseSalva;

    const fluxo = _normalizeKey(lead && lead.fluxo);
    if (fluxo && PHASE_BY_FLOW_ALIAS[fluxo]) {
        return PHASE_BY_FLOW_ALIAS[fluxo];
    }

    const interacoes = Array.isArray(lead && lead.historico)
        ? lead.historico.length
        : Number(lead && lead.interacoes) || 0;

    const score = _clampNumber(lead && lead.score, 50, 0, 100);

    if (interacoes === 0) return 'fase_1_abordagem';
    if (score >= 65 && interacoes >= 2) return 'fase_3_conversao';
    return 'fase_2_qualificacao';
}

function getFaseContext(fase) {
    return FASE_CONTEXTS[fase] || FASE_CONTEXTS.fase_2_qualificacao;
}

function normalizeObjecao(objecao) {
    const key = _normalizeKey(objecao);
    if (!key) return '';
    if (OBJECTION_ALIAS[key]) return OBJECTION_ALIAS[key];

    const byKeyword = _inferObjecaoByKeywords(key);
    return byKeyword || key;
}

function getObjecaoContext(objecao) {
    const key = normalizeObjecao(objecao);
    return OBJECTION_CONTEXTS[key] || '';
}

function buildSdrContext(lead, analise, antiRep) {
    const safeLead = lead || {};
    const safeAnalise = analise || {};

    const fase = detectarFase(safeLead);
    const faseCtx = getFaseContext(fase);
    const objecCtx = getObjecaoContext(safeAnalise.objecao);

    const score = _clampNumber(safeLead.score, 50, 0, 100);
    const temperatura = _clean(safeLead.temperatura) || 'Frio';
    const scoreInfo = `[SCORE DO LEAD: ${score}/100 | Temperatura: ${temperatura}]`;

    const objecoes = Array.isArray(safeLead.objecoes)
        ? safeLead.objecoes.map(o => normalizeObjecao(o)).filter(Boolean)
        : [];

    const objecoesAnteriores = objecoes.length > 0
        ? `[OBJECOES ANTERIORES: ${objecoes.join(', ')}] Nao repetir exatamente a mesma abordagem.`
        : '';

    const antiRepeticao = _clean(antiRep);

    return [scoreInfo, faseCtx, objecCtx, objecoesAnteriores, antiRepeticao]
        .filter(Boolean)
        .join('\n\n');
}

function _clean(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\s+/g, ' ').trim();
}

function _normalizeKey(value) {
    return _clean(value)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _inferObjecaoByKeywords(key) {
    if (key.includes('email') || key.includes('e mail')) return 'enviar_email';
    if (key.includes('fornecedor') || key.includes('agencia')) return 'fornecedor_existente';
    if (
        key.includes('orcamento') ||
        key.includes('budget') ||
        key.includes('verba') ||
        key.includes('sem caixa')
    ) return 'sem_budget';
    if (
        key.includes('sem interesse') ||
        key.includes('nao quero') ||
        key.includes('nao tenho interesse') ||
        key.includes('nao e momento') ||
        key.includes('retornar depois')
    ) return 'nao_interesse';
    if (
        key.includes('satisfeito') ||
        key.includes('esta bom') ||
        key.includes('tudo bem assim')
    ) return 'satisfeito';
    if (
        key.includes('nao sou o responsavel') ||
        key.includes('nao posso passar contato') ||
        key.includes('fale com recepcao') ||
        key.includes('fale com atendente')
    ) return 'sem_contacto';

    return '';
}

function _clampNumber(value, fallback, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
}

module.exports = {
    detectarFase,
    getFaseContext,
    getObjecaoContext,
    normalizeObjecao,
    buildSdrContext,
    FASE_CONTEXTS,
    OBJECTION_CONTEXTS
};
