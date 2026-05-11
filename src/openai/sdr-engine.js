/**
 * SDR Engine
 * Processa a lógica de SDR (Sales Development Representative)
 * baseada nos cenários de abordagem e follow-up.
 */

const { OpenAI } = require('openai');
const logger = require('../config/logger');
const analysisLog = require('../sheets/analysis-log');
const sdrLearning = require('./sdr-learning');
const { buildSdrContext, normalizeObjecao } = require('./sdr-intelligence');

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

            return {
                novaTemperatura: lead.temperatura || 'A definir',
                novoFluxo: lead.fluxo || 'Cenário 1',
                proximaMensagem: playbook.mensagem,
                analise: {},
                origem: 'playbook',
                scorePlaybook: Number(playbook.score.toFixed(3)),
                playbookId: playbook.playbookId
            };
        }

        const systemPrompt = [
            SDR_SCRIPT,
            `\nCONTEXTO ESPECIALIZADO SDR:\n${sdrContext}`,
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

        return {
            novaTemperatura: resposta.novaTemperatura,
            novoFluxo: resposta.novoFluxo,
            proximaMensagem: resposta.proximaMensagem,
            analise,
            origem: 'openai'
        };
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
        const messages = [];

        if (Array.isArray(lead.historico) && lead.historico.length > 0) {
            for (const item of lead.historico) {
                if (item.role && item.content) {
                    messages.push({ role: item.role, content: String(item.content) });
                }
            }
            if (messages.length > 0) return messages;
        }

        if (lead.proximaMensagemAtual) {
            messages.push({ role: 'assistant', content: String(lead.proximaMensagemAtual) });
        }
        if (lead.ultimaResposta) {
            messages.push({ role: 'user', content: String(lead.ultimaResposta) });
        }

        return messages;
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
