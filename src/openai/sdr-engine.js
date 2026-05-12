/**
 * SDR Engine
 * Processa a lógica de SDR (Sales Development Representative)
 * baseada nos cenários de abordagem e follow-up.
 */

const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const analysisLog = require('../sheets/analysis-log');
const contextCache = require('../cache/context-cache');
const contextCompressor = require('../cache/context-compressor');
const personaSelector = require('../personas/persona-selector');
const { EscalationRulesEngine } = require('../escalation/escalation-rules');
const notificationBuilder = require('../escalation/notification-builder');

// ─── Inlined: sdr-learning ────────────────────────────────────────────────────
const PLAYBOOK_FILE = path.join(__dirname, '..', '..', 'data', 'sdr_playbooks.json');
const SIMILARITY_THRESHOLD = 0.58;
const STRICT_MATCH_THRESHOLD = 0.82;
const SUCCESS_RATE_MIN = 0.70;
const MAX_PLAYBOOKS = 200;
const SAVE_DEBOUNCE_MS = 5000;

const _playbookDataDir = path.dirname(PLAYBOOK_FILE);
if (!fs.existsSync(_playbookDataDir)) fs.mkdirSync(_playbookDataDir, { recursive: true });

class SDRLearning {
    constructor() {
        this._playbooks = this._load();
        this._dirty = false;
        this._saveTimer = null;
        this._registerShutdownHooks();
    }

    registrarSucesso({ telefone, mensagemEnviada, objecao, fase, resposta }) {
        const faseSafe = this._sanitizeText(fase, 80) || 'indefinida';
        const objecaoSafe = this._sanitizeText(objecao, 80);
        const mensagem = this._sanitizeText(mensagemEnviada, 800);
        if (!mensagem) { logger.warn('[SDRLearning] Ignorado sucesso sem mensagemEnviada valida'); return; }
        const now = new Date().toISOString();
        const existing = this._findBestMatch(mensagem, faseSafe, objecaoSafe, STRICT_MATCH_THRESHOLD);
        if (existing) {
            existing.successCount = (existing.successCount || 0) + 1;
            existing.usageCount = (existing.usageCount || 0) + 1;
            existing.successRate = this._computeSuccessRate(existing);
            existing.lastSuccessAt = now; existing.lastUsedAt = now;
            existing.lastResponse = this._sanitizeText(resposta, 200);
        } else {
            const created = {
                id: `pb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                pattern: this._normalizar(mensagem), raw: this._extractRawMessage(mensagem),
                fase: faseSafe, objecao: objecaoSafe || '', successRate: 1,
                successCount: 1, usageCount: 1, createdAt: now, lastSuccessAt: now,
                lastUsedAt: now, lastResponse: this._sanitizeText(resposta, 200)
            };
            this._playbooks.push(created);
            this._prunePlaybooks();
        }
        this._dirty = true; this._scheduleSave();
        this._audit('sdr_learning_success', { telefone, fase: faseSafe, objecao: objecaoSafe, mensagem: mensagem.slice(0, 200) });
    }

    registrarFalha(mensagemEnviada, fase, objecao) {
        const faseSafe = this._sanitizeText(fase, 80) || 'indefinida';
        const objecaoSafe = this._sanitizeText(objecao, 80);
        const mensagem = this._sanitizeText(mensagemEnviada, 800);
        if (!mensagem) return;
        const existing = this._findBestMatch(mensagem, faseSafe, objecaoSafe, STRICT_MATCH_THRESHOLD);
        if (!existing) return;
        existing.usageCount = (existing.usageCount || 0) + 1;
        existing.successRate = this._computeSuccessRate(existing);
        existing.lastFailureAt = new Date().toISOString();
        this._dirty = true; this._scheduleSave();
        this._audit('sdr_learning_failure', { fase: faseSafe, objecao: objecaoSafe, playbookId: existing.id });
    }

    buscarPlaybook(contexto, fase, objecao) {
        const faseSafe = this._sanitizeText(fase, 80) || 'indefinida';
        const objecaoSafe = this._sanitizeText(objecao, 80);
        const ctx = this._sanitizeText(contexto, 1200);
        if (!ctx) return null;
        const candidatos = this._playbooks.filter(pb =>
            (pb.successRate || 0) >= SUCCESS_RATE_MIN &&
            (pb.usageCount || 0) >= 2 &&
            pb.fase === faseSafe &&
            !(objecaoSafe && pb.objecao && pb.objecao !== objecaoSafe)
        );
        if (candidatos.length === 0) return null;
        const normalCtx = this._normalizar(ctx);
        let melhor = null; let melhorScore = 0;
        for (const pb of candidatos) {
            const score = this._similaridade(normalCtx, pb.pattern);
            if (score > melhorScore) { melhor = pb; melhorScore = score; }
        }
        if (!melhor || melhorScore < SIMILARITY_THRESHOLD) return null;
        melhor.lastUsedAt = new Date().toISOString();
        this._dirty = true; this._scheduleSave();
        return { mensagem: melhor.raw, score: melhorScore, playbookId: melhor.id };
    }

    getTop(n = 10) {
        const topN = Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
        return [...this._playbooks].sort((a, b) => this._qualityScore(b) - this._qualityScore(a)).slice(0, topN);
    }

    _registerShutdownHooks() {
        if (SDRLearning._hooksRegistered) return;
        const flushAndExit = (code) => { try { this._flushSync(); } finally { process.exit(code); } };
        process.on('exit', () => this._flushSync());
        process.on('SIGINT', () => flushAndExit(0));
        process.on('SIGTERM', () => flushAndExit(0));
        SDRLearning._hooksRegistered = true;
    }

    _findBestMatch(mensagem, fase, objecao, minScore) {
        const pattern = this._normalizar(mensagem);
        let melhor = null; let melhorScore = 0;
        for (const pb of this._playbooks) {
            if (pb.fase !== fase) continue;
            if (objecao && pb.objecao && pb.objecao !== objecao) continue;
            const score = this._similaridade(pattern, pb.pattern || '');
            if (score > melhorScore) { melhor = pb; melhorScore = score; }
        }
        return (!melhor || melhorScore < minScore) ? null : melhor;
    }

    _normalizar(text) {
        return (text || '').toLowerCase().normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    _similaridade(a, b) {
        if (!a || !b) return 0;
        return (this._tokenDice(a, b) * 0.7) + (this._trigramJaccard(a, b) * 0.3);
    }

    _tokenDice(a, b) {
        const setA = new Set(a.split(' ').filter(w => w.length >= 3));
        const setB = new Set(b.split(' ').filter(w => w.length >= 3));
        if (setA.size === 0 || setB.size === 0) return 0;
        let common = 0;
        for (const token of setA) { if (setB.has(token)) common += 1; }
        return (2 * common) / (setA.size + setB.size);
    }

    _trigramJaccard(a, b) {
        const gramsA = this._ngrams(a, 3); const gramsB = this._ngrams(b, 3);
        if (gramsA.size === 0 || gramsB.size === 0) return 0;
        let intersection = 0;
        for (const gram of gramsA) { if (gramsB.has(gram)) intersection += 1; }
        const union = gramsA.size + gramsB.size - intersection;
        return union === 0 ? 0 : (intersection / union);
    }

    _ngrams(text, n) {
        const compact = (text || '').replace(/\s+/g, ' ');
        const result = new Set();
        if (compact.length < n) return result;
        for (let i = 0; i <= compact.length - n; i += 1) result.add(compact.slice(i, i + n));
        return result;
    }

    _scheduleSave() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => { this._saveTimer = null; this._flushSync(); }, SAVE_DEBOUNCE_MS);
        if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
    }

    _load() {
        try {
            if (!fs.existsSync(PLAYBOOK_FILE)) return [];
            const parsed = JSON.parse(fs.readFileSync(PLAYBOOK_FILE, 'utf8'));
            if (!Array.isArray(parsed)) { logger.warn('[SDRLearning] Arquivo invalido. Reiniciando.'); return []; }
            return parsed.map(pb => this._sanitizePlaybook(pb)).filter(Boolean);
        } catch (err) { logger.warn(`[SDRLearning] Erro ao carregar: ${err.message}`); return []; }
    }

    _flushSync() {
        if (!this._dirty) return;
        try {
            const tmpFile = `${PLAYBOOK_FILE}.tmp`;
            fs.writeFileSync(tmpFile, JSON.stringify(this._playbooks, null, 2), 'utf8');
            fs.renameSync(tmpFile, PLAYBOOK_FILE);
            this._dirty = false;
        } catch (err) { logger.error(`[SDRLearning] Erro ao salvar: ${err.message}`); }
    }

    _sanitizePlaybook(pb) {
        if (!pb || typeof pb !== 'object') return null;
        const pattern = this._normalizar(pb.pattern || pb.raw || '');
        const raw = this._extractRawMessage(pb.raw || pb.pattern || '');
        const fase = this._sanitizeText(pb.fase, 80) || 'indefinida';
        if (!pattern || !raw) return null;
        const successCount = this._safeInt(pb.successCount, 0);
        const usageCount = Math.max(this._safeInt(pb.usageCount, 0), successCount);
        const sanitized = {
            id: this._sanitizeText(pb.id, 80) || `pb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            pattern, raw, fase, objecao: this._sanitizeText(pb.objecao, 80) || '',
            successCount, usageCount, successRate: 0,
            createdAt: this._safeDate(pb.createdAt),
            lastUsedAt: this._safeDate(pb.lastUsedAt || pb.lastSuccessAt),
            lastSuccessAt: this._safeDate(pb.lastSuccessAt || pb.lastSuccess),
            lastFailureAt: this._safeDate(pb.lastFailureAt),
            lastResponse: this._sanitizeText(pb.lastResponse, 200)
        };
        sanitized.successRate = this._computeSuccessRate(sanitized);
        return sanitized;
    }

    _prunePlaybooks() {
        if (this._playbooks.length <= MAX_PLAYBOOKS) return;
        this._playbooks.sort((a, b) => this._qualityScore(a) - this._qualityScore(b));
        this._playbooks.splice(0, this._playbooks.length - MAX_PLAYBOOKS);
    }

    _qualityScore(pb) {
        return Math.max(0, Math.min(1, Number(pb.successRate) || 0)) * Math.log2(Math.max(1, this._safeInt(pb.usageCount, 1)) + 1);
    }

    _computeSuccessRate(pb) {
        const usage = this._safeInt(pb.usageCount, 0);
        return usage <= 0 ? 0 : this._safeInt(pb.successCount, 0) / usage;
    }

    _extractRawMessage(text) { return this._sanitizeText(text, 300); }

    _sanitizeText(value, maxLen) {
        if (value === null || value === undefined) return '';
        const normalized = String(value).replace(/\s+/g, ' ').trim();
        if (!normalized) return '';
        return maxLen && normalized.length > maxLen ? normalized.slice(0, maxLen) : normalized;
    }

    _safeDate(value) {
        if (!value) return new Date().toISOString();
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    }

    _safeInt(value, fallback) {
        const parsed = Number.parseInt(value, 10);
        return (!Number.isFinite(parsed) || parsed < 0) ? fallback : parsed;
    }

    _audit(type, payload) {
        Promise.resolve()
            .then(() => analysisLog.log({ type, agent: 'SDRLearning', subject: 'Playbook update', discoveries: JSON.stringify(payload), confidence: 85, reference: 'sdr_playbooks' }))
            .catch(err => logger.warn(`[SDRLearning] Falha no log: ${err.message}`));
    }
}

SDRLearning._hooksRegistered = false;
const sdrLearning = new SDRLearning();

// ─── Inlined: sdr-intelligence ───────────────────────────────────────────────
const FASE_CONTEXTS = Object.freeze({
    fase_1_abordagem: ['[FASE CONVERSACIONAL 1 - ABORDAGEM INICIAL]', 'Objetivo: despertar interesse com abertura direta e personalizada.', 'Nao mencione precos, detalhes tecnicos profundos ou pressione por reuniao na primeira mensagem.', 'Seja breve (maximo 3 linhas) e foque em uma dor relevante do mercado.', 'Encerre com uma pergunta aberta que convide resposta.', '[FIM DA FASE 1]'].join('\n'),
    fase_2_qualificacao: ['[FASE CONVERSACIONAL 2 - QUALIFICACAO]', 'Objetivo: aprofundar contexto do lead com leveza e escuta ativa.', 'Demonstre entendimento antes de perguntar.', 'Faca no maximo uma pergunta por mensagem.', 'Descubra: decisor, problema atual e urgencia percebida.', '[FIM DA FASE 2]'].join('\n'),
    fase_3_conversao: ['[FASE CONVERSACIONAL 3 - CONVERSAO/AGENDAMENTO]', 'Objetivo: propor o proximo passo (call/reuniao de 20-30 min).', 'Se houver interesse ou fit, sugira dia e horario especificos.', 'Reforce o valor da conversa rapida versus envio de material generico.', '[FIM DA FASE 3]'].join('\n')
});

const OBJECTION_CONTEXTS = Object.freeze({
    sem_budget: ['[OBJECAO: SEM ORCAMENTO]', 'Estrategia:', '1. Valide a preocupacao sem descartar.', '2. Reframe: qual o custo de nao resolver agora?', '3. Evite falar de preco; proponha conversa curta para entender contexto.', '4. Deixe porta aberta para novo contato em 30 dias.', '[FIM DA ESTRATEGIA]'].join('\n'),
    fornecedor_existente: ['[OBJECAO: JA POSSUI FORNECEDOR]', 'Estrategia:', '1. Valide a escolha atual sem atacar concorrente.', '2. Pergunte o que ainda pode melhorar na solucao atual.', '3. Posicione um diferencial especifico e relevante.', '4. Proponha conversa comparativa rapida, sem compromisso.', '[FIM DA ESTRATEGIA]'].join('\n'),
    enviar_email: ['[OBJECAO: PREFERE EMAIL]', 'Estrategia:', '1. Aceite o pedido e explique que 10 min melhoram a personalizacao.', '2. Reforce que email generico perde contexto.', '3. Ofereca dois horarios objetivos para conversa rapida.', '[FIM DA ESTRATEGIA]'].join('\n'),
    nao_interesse: ['[OBJECAO: SEM INTERESSE/NAO E MOMENTO]', 'Estrategia:', '1. Respeite o momento e nao force.', '2. Plante uma semente com resultado de mercado generico e plausivel.', '3. Pergunte permissao para retomar em alguns meses.', '4. Feche com tom positivo e profissional.', '[FIM DA ESTRATEGIA]'].join('\n'),
    satisfeito: ['[OBJECAO: SATISFEITO COM STATUS ATUAL]', 'Estrategia:', '1. Reconheca o bom momento do lead.', '2. Pergunte o que esta funcionando para gerar escuta ativa.', '3. Traga um gap potencial com sutileza.', '4. Convide para conversa de benchmarking.', '[FIM DA ESTRATEGIA]'].join('\n'),
    sem_contacto: ['[OBJECAO: ATENDENTE NAO PASSA AO DECISOR]', 'Estrategia:', '1. Seja empatico com o atendente.', '2. Peca nome e melhor forma de contato do responsavel.', '3. Ofereca agendar horario objetivo para a area responsavel.', '4. Deixe um gancho de valor facil de repassar.', '[FIM DA ESTRATEGIA]'].join('\n')
});

const PHASE_BY_FLOW_ALIAS = Object.freeze({ 'novo': 'fase_1_abordagem', 'cenario 1': 'fase_1_abordagem', 'follow up d1': 'fase_2_qualificacao', 'cenario 2': 'fase_2_qualificacao', 'follow up d5': 'fase_2_qualificacao', 'cenario 3': 'fase_2_qualificacao', 'follow up d10': 'fase_2_qualificacao', 'cenario 4': 'fase_2_qualificacao', 'cenario 5': 'fase_2_qualificacao', 'cenario 6': 'fase_3_conversao', 'abordagem inicial': 'fase_1_abordagem', 'qualificacao': 'fase_2_qualificacao', 'conversao': 'fase_3_conversao', 'agendamento': 'fase_3_conversao' });
const OBJECTION_ALIAS = Object.freeze({ 'sem interesse': 'nao_interesse', 'nao interesse': 'nao_interesse', 'nao tenho interesse': 'nao_interesse', 'nao preciso': 'nao_interesse', 'nao quero': 'nao_interesse', 'agora nao': 'nao_interesse', 'sem prioridade': 'nao_interesse', 'nao e momento': 'nao_interesse', 'retornar depois': 'nao_interesse', 'me chama depois': 'nao_interesse', 'enviar email': 'enviar_email', 'envie por email': 'enviar_email', 'prefere email': 'enviar_email', 'manda por email': 'enviar_email', 'me mande por email': 'enviar_email', 'ja tem fornecedor': 'fornecedor_existente', 'ja possuo fornecedor': 'fornecedor_existente', 'fornecedor': 'fornecedor_existente', 'atendido por agencia': 'fornecedor_existente', 'atendido por agencia parceira': 'fornecedor_existente', 'sem orcamento': 'sem_budget', 'sem budget': 'sem_budget', 'sem verba': 'sem_budget', 'sem caixa': 'sem_budget', 'nao tenho verba': 'sem_budget', 'nao tenho orcamento': 'sem_budget', 'satisfeito': 'satisfeito', 'estou satisfeito': 'satisfeito', 'esta tudo bem assim': 'satisfeito', 'fale com atendente': 'sem_contacto', 'nao posso passar contato': 'sem_contacto', 'nao sou o responsavel': 'sem_contacto', 'fale com recepcao': 'sem_contacto' });

function _sdrClean(value) { return (value === null || value === undefined) ? '' : String(value).replace(/\s+/g, ' ').trim(); }
function _sdrNormalizeKey(value) { return _sdrClean(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
function _sdrClampNumber(value, fallback, min, max) { const num = Number(value); return !Number.isFinite(num) ? fallback : Math.min(max, Math.max(min, Math.round(num))); }
function _sdrInferObjecao(key) {
    if (key.includes('email') || key.includes('e mail')) return 'enviar_email';
    if (key.includes('fornecedor') || key.includes('agencia')) return 'fornecedor_existente';
    if (key.includes('orcamento') || key.includes('budget') || key.includes('verba') || key.includes('sem caixa')) return 'sem_budget';
    if (key.includes('sem interesse') || key.includes('nao quero') || key.includes('nao tenho interesse') || key.includes('nao e momento') || key.includes('retornar depois')) return 'nao_interesse';
    if (key.includes('satisfeito') || key.includes('esta bom') || key.includes('tudo bem assim')) return 'satisfeito';
    if (key.includes('nao sou o responsavel') || key.includes('nao posso passar contato') || key.includes('fale com recepcao') || key.includes('fale com atendente')) return 'sem_contacto';
    return '';
}

function normalizeObjecao(objecao) {
    const key = _sdrNormalizeKey(objecao);
    if (!key) return '';
    return OBJECTION_ALIAS[key] || _sdrInferObjecao(key) || key;
}

function getFaseContext(fase) { return FASE_CONTEXTS[fase] || FASE_CONTEXTS.fase_2_qualificacao; }
function getObjecaoContext(objecao) { return OBJECTION_CONTEXTS[normalizeObjecao(objecao)] || ''; }
function detectarFase(lead) {
    const faseSalva = _sdrClean(lead && lead.fase);
    if (faseSalva && FASE_CONTEXTS[faseSalva]) return faseSalva;
    const fluxo = _sdrNormalizeKey(lead && lead.fluxo);
    if (fluxo && PHASE_BY_FLOW_ALIAS[fluxo]) return PHASE_BY_FLOW_ALIAS[fluxo];
    const interacoes = Array.isArray(lead && lead.historico) ? lead.historico.length : Number(lead && lead.interacoes) || 0;
    const score = _sdrClampNumber(lead && lead.score, 50, 0, 100);
    if (interacoes === 0) return 'fase_1_abordagem';
    if (score >= 65 && interacoes >= 2) return 'fase_3_conversao';
    return 'fase_2_qualificacao';
}

function buildSdrContext(lead, analise, antiRep) {
    const safeLead = lead || {}; const safeAnalise = analise || {};
    const fase = detectarFase(safeLead);
    const faseCtx = getFaseContext(fase);
    const objecCtx = getObjecaoContext(safeAnalise.objecao);
    const score = _sdrClampNumber(safeLead.score, 50, 0, 100);
    const temperatura = _sdrClean(safeLead.temperatura) || 'Frio';
    const scoreInfo = `[SCORE DO LEAD: ${score}/100 | Temperatura: ${temperatura}]`;
    const objecoes = Array.isArray(safeLead.objecoes) ? safeLead.objecoes.map(o => normalizeObjecao(o)).filter(Boolean) : [];
    const objecoesAnteriores = objecoes.length > 0 ? `[OBJECOES ANTERIORES: ${objecoes.join(', ')}] Nao repetir exatamente a mesma abordagem.` : '';
    return [scoreInfo, faseCtx, objecCtx, objecoesAnteriores, _sdrClean(antiRep)].filter(Boolean).join('\n\n');
}

const SDR_SCRIPT = `
Você é o SDR IA da [Nome da Empresa]. Seu objetivo é agendar reuniões com os tomadores de decisão (marketing/gestão) de clínicas (ex: clínicas odontológicas).

# Cenário 1: Abordagem Inicial (Via Atendente)
- SDR: "Olá! Sou o SDR IA da [Empresa]. Gostaria de falar brevemente com o responsável pela captação de pacientes..."
- Se o atendente bloquear: Peça para agendar uma reunião em um dia/hora específico.
- Se pedir email: Ofereça uma breve conversa de 5 min para personalizar o conteúdo do email.

# Cenário 2: Follow-up D1
- SDR: "Olá [Nome], espero que esteja bem. Estava pensando na nossa conversa... Conseguiu ver o material?"

# Cenário 3: Follow-up D5
- SDR: "Olá [Nome], apenas verificando se conseguiu um momento para falarmos sobre a otimização de pacientes..."

# Cenário 4: Follow-up D10 (Transição Humana)
- SDR: "Olá, como não obtivemos resposta, vou passar seu contato para nossa equipe de especialistas..."

# Cenário 5: Tratamento de Objeção (Com o Responsável)
- Se "não tem interesse": Diga que compreende, mas cite desafios comuns do mercado (luxo constante de clientes) e ofereça uma conversa focada em inovação.
- Se "envie por email": Reforce que a call de 5 min ajuda a enviar um material mais direto ao ponto.

# Cenário 6: Qualificação Final (Agendamento)
- SDR: Sugira ativamente um dia e horário de 30 minutos na próxima semana.

REGRA TÉCNICA DE COMPORTAMENTO:
Sempre identifique o "Estágio" do lead. Com base no histórico e no novo evento (nenhuma resposta no D1, ou objeção do atendente), elabore SUA PRÓXIMA RESPOSTA de forma humanizada, seguindo estritamente esse roteiro. Não invente promoções ou preços.
`;

class SDREngine {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    /**
     * Avalia o lead e gera qual deve ser a próxima mensagem a ser enviada.
     * Realiza a análise de intenção e a geração da resposta em uma ÚNICA chamada ao GPT-4o.
     * O histórico da conversa é passado como array multi-turn [{role, content}].
     * @param {Object} lead - Dados atuais do lead
     * @returns {Object} { novaTemperatura, novoFluxo, proximaMensagem, analise, origem }
     */
    async generateNextAction(lead) {
        logger.info(`[SDR] Gerando próxima ação para o número ${lead.numero}...`);

        // Cache key baseado no estado atual do lead (fluxo + última resposta)
        const cacheKey = `${lead.numero}::${lead.fluxo}::${lead.ultimaResposta || ''}`;
        const cached = contextCache.get(cacheKey);
        if (cached) {
            logger.info(`[SDR] Cache hit para ${lead.numero} — reutilizando ação anterior`);
            return cached;
        }

        const fase = this._normalizarFase(lead.fluxo);
        const antiRep = this._buildAntiRep(lead);
        const multiTurnHistorico = this._buildMultiTurnHistorico(lead);

        const sdrContext = buildSdrContext({
            fase,
            fluxo: lead.fluxo,
            score: this._estimateLeadScore(lead),
            temperatura: lead.temperatura,
            historico: multiTurnHistorico.map((m, i) => ({ id: i + 1, text: m.content })),
            objecoes: this._extractObjecoes(lead, '')
        }, {}, antiRep);

        const contexto = [lead.nome, lead.temperatura, lead.fluxo, lead.ultimaResposta]
            .filter(Boolean).join(' | ');

        const playbook = sdrLearning.buscarPlaybook(contexto, fase, '');
        if (playbook) {
            this._auditIntelligence({
                lead,
                fase,
                objecao: '',
                origem: 'playbook',
                scorePlaybook: Number(playbook.score.toFixed(3))
            });

            const playbookResult = {
                novaTemperatura: lead.temperatura || 'A definir',
                novoFluxo: lead.fluxo || 'Cenário 1',
                proximaMensagem: playbook.mensagem,
                analise: {},
                origem: 'playbook',
                scorePlaybook: Number(playbook.score.toFixed(3)),
                playbookId: playbook.playbookId
            };
            contextCache.set(cacheKey, playbookResult);
            return playbookResult;
        }

        const persona = personaSelector.select({
            fase,
            objecao: this._extractObjecoes(lead, '')[0] || '',
            score: this._estimateLeadScore(lead),
            numObjecoes: this._extractObjecoes(lead, '').length
        });
        const personaBlock = personaSelector.generatePromptBlock(persona, lead);

        const systemPrompt = [
            SDR_SCRIPT,
            `\nCONTEXTO ESPECIALIZADO SDR:\n${sdrContext}`,
            `\n${personaBlock}`,
            '\nDIRETRIZ DE ESTILO:',
            '- Seja criativo na formulacao da mensagem sem perder clareza e objetividade.',
            '- Evite respostas roboticas ou repetitivas; varie abertura e CTA dentro da fase.',
            '- Mantenha o foco em conversao com tom humano e profissional.',
            '\nRetorne um JSON valido com EXATAMENTE dois campos:',
            '1. "analise": { "fase": string, "objecao": string|null, "intencao": string, "scoreEstimado": number (0-100) }',
            '2. "resposta": { "novaTemperatura": string (Quente|Frio|A definir), "novoFluxo": string, "proximaMensagem": string }'
        ].join('\n');

        const previousMessages = multiTurnHistorico
            .filter(m => m.role === 'assistant')
            .map(m => String(m.content || '').slice(0, 120));

        const variabilityInstruction = previousMessages.length > 0
            ? `ATENÇÃO: Responda de forma natural e diferente das mensagens anteriores. Evite repetir frases, aberturas ou call-to-actions já usados. Mensagens anteriores do SDR: ${JSON.stringify(previousMessages)}`
            : 'ATENÇÃO: Responda de forma natural e humana. Evite frases genéricas ou repetitivas.';

        const userMessage = [
            variabilityInstruction,
            '',
            'DADOS DO LEAD:',
            `Número: ${lead.numero}`,
            `Nome: ${lead.nome || 'Desconhecido'}`,
            `Fluxo Atual: ${lead.fluxo || 'Novo'}`,
            `Temperatura: ${lead.temperatura || 'N/A'}`,
            '',
            'Com base no histórico da conversa acima, analise a intenção do lead e gere a próxima mensagem.',
            'Siga a evolução natural dos dias (Novo → Cenário 1 → Follow-up D1 → D5 → D10, etc.).',
            'Preencha os campos "analise" e "resposta" conforme instruído.'
        ].join('\n');

        const completion = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                ...multiTurnHistorico,
                { role: 'user', content: userMessage }
            ],
            temperature: this._getCreativityTemperature(fase),
            top_p: 0.9,
            response_format: { type: 'json_object' }
        });

        const result = JSON.parse(completion.choices[0].message.content);
        const analise = result.analise || {};
        const resposta = result.resposta || result;

        this._auditIntelligence({
            lead,
            fase: analise.fase || fase,
            objecao: analise.objecao || '',
            origem: 'openai',
            novoFluxo: resposta.novoFluxo,
            novaTemperatura: resposta.novaTemperatura
        });

        const openaiResult = {
            novaTemperatura: resposta.novaTemperatura,
            novoFluxo: resposta.novoFluxo,
            proximaMensagem: resposta.proximaMensagem,
            analise,
            origem: 'openai'
        };

        // Enriquecer com avaliação de escalação (não altera fluxo existente)
        const escalationEval = EscalationRulesEngine.evaluate(lead, { currentText: lead.ultimaResposta, analysis: analise, stage: fase });
        if (escalationEval.action !== 'CONTINUE' && escalationEval.score >= 50) {
            openaiResult.escalation = {
                action: escalationEval.action,
                reason: escalationEval.reason,
                score: escalationEval.score,
                notification: escalationEval.action === 'HANDOFF'
                    ? notificationBuilder.buildQualifiedLeadNotification(lead, escalationEval)
                    : notificationBuilder.buildEscalationNotification(lead, escalationEval)
            };
            logger.info(`[SDR] Escalação detectada: ${escalationEval.action} (${escalationEval.reason}, score=${escalationEval.score})`);
        }

        contextCache.set(cacheKey, openaiResult);
        return openaiResult;
    }

    _normalizarFase(fluxo) {
        if (!fluxo) return 'indefinida';
        return String(fluxo).trim();
    }

    _detectarObjecao(texto) {
        const t = String(texto || '').toLowerCase();
        if (!t) return '';
        if (t.includes('email') || t.includes('e-mail')) return 'enviar_email';
        if (t.includes('sem interesse') || t.includes('nao tenho interesse') || t.includes('não tenho interesse')) return 'nao_interesse';
        if (t.includes('nao agora') || t.includes('não agora') || t.includes('depois')) return 'nao_interesse';
        if (t.includes('fornecedor')) return 'fornecedor_existente';
        if (t.includes('orcamento') || t.includes('orçamento') || t.includes('budget')) return 'sem_budget';
        if (t.includes('satisfeito') || t.includes('esta bom') || t.includes('está bom')) return 'satisfeito';
        if (t.includes('falar com atendente') || t.includes('nao posso passar') || t.includes('não posso passar')) return 'sem_contacto';
        return '';
    }

    _estimateLeadScore(lead) {
        if (!lead || !lead.ultimaResposta) return 45;
        const text = String(lead.ultimaResposta).toLowerCase();
        if (text.includes('interesse') || text.includes('marcar') || text.includes('agenda')) return 75;
        if (text.includes('email') || text.includes('fornecedor') || text.includes('orcamento') || text.includes('orçamento')) return 55;
        return 50;
    }

    /**
     * Constrói o histórico da conversa no formato multi-turn para a API do OpenAI.
     * Alterna entre mensagens do assistente (bot) e do usuário (lead).
     * @param {Object} lead
     * @returns {Array<{role: string, content: string}>}
     */
    _buildMultiTurnHistorico(lead) {
        const raw = [];

        if (Array.isArray(lead.historico) && lead.historico.length > 0) {
            for (const item of lead.historico) {
                if (item.role && item.content) {
                    raw.push({ role: item.role, content: String(item.content) });
                }
            }
            if (raw.length > 0) return contextCompressor.compressMessages(raw);
        }

        if (lead.proximaMensagemAtual) {
            raw.push({ role: 'assistant', content: String(lead.proximaMensagemAtual) });
        }
        if (lead.ultimaResposta) {
            raw.push({ role: 'user', content: String(lead.ultimaResposta) });
        }

        return contextCompressor.compressMessages(raw);
    }

    _extractObjecoes(lead, objecaoAtual) {
        const list = [];

        if (lead && Array.isArray(lead.objecoes)) {
            list.push(...lead.objecoes);
        }

        if (lead && typeof lead.objecoes === 'string') {
            list.push(...lead.objecoes.split(',').map(s => s.trim()).filter(Boolean));
        }

        if (objecaoAtual) {
            list.push(objecaoAtual);
        }

        return Array.from(new Set(list.map(item => normalizeObjecao(item)).filter(Boolean)));
    }

    _buildAntiRep(lead) {
        const ultima = String(lead && lead.proximaMensagemAtual || '').trim();
        if (!ultima) return '';

        return [
            '[ANTI-REPETICAO]',
            `Evite repetir literalmente a ultima mensagem enviada: "${ultima.slice(0, 240)}"`,
            'Varie abertura, argumento central e call-to-action mantendo o objetivo da fase.',
            '[FIM ANTI-REPETICAO]'
        ].join('\n');
    }

    _getCreativityTemperature(fase) {
        const normalized = String(fase || '').toLowerCase();
        if (normalized.includes('fase_1')) return 0.80;  // abordagem inicial — mais criativo
        if (normalized.includes('fase_2')) return 0.75;  // qualificação — variado mas coerente
        if (normalized.includes('fase_3')) return 0.70;  // conversão — preciso, ainda variável
        return 0.75;
    }

    _auditIntelligence({ lead, fase, objecao, origem, scorePlaybook, novoFluxo, novaTemperatura }) {
        Promise.resolve()
            .then(() => analysisLog.log({
                type: 'sdr_intelligence_context',
                agent: 'SDREngine',
                subject: String((lead && lead.numero) || 'sem_numero'),
                discoveries: [
                    `fase=${fase || 'indefinida'}`,
                    `objecao=${objecao || 'nenhuma'}`,
                    `origem=${origem || 'desconhecida'}`,
                    Number.isFinite(scorePlaybook) ? `scorePlaybook=${scorePlaybook}` : ''
                ].filter(Boolean),
                recommendations: [
                    `novoFluxo=${novoFluxo || (lead && lead.fluxo) || 'n/a'}`,
                    `novaTemperatura=${novaTemperatura || (lead && lead.temperatura) || 'n/a'}`
                ],
                confidence: 88,
                reference: 'sdr-intelligence'
            }))
            .catch((err) => {
                logger.warn(`[SDR] Falha ao auditar contexto inteligente: ${err.message}`);
            });
    }
}

module.exports = new SDREngine();
