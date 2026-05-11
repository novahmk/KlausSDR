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
     * Avalia o lead e gera qual deve ser a próxima mensagem a ser enviada
     * @param {Object} lead - Dados atuais do lead
     * @returns {Object} { novaTemperatura, novoFluxo, proximaMensagem }
     */
    async generateNextAction(lead) {
        logger.info(`[SDR] Gerando próxima ação para o número ${lead.numero}...`);

        const fase = this._normalizarFase(lead.fluxo);
        const objecao = normalizeObjecao(this._detectarObjecao(lead.ultimaResposta));
        const contexto = [
            lead.nome,
            lead.temperatura,
            lead.fluxo,
            lead.ultimaResposta
        ].filter(Boolean).join(' | ');

        const analise = { objecao };
        const antiRep = this._buildAntiRep(lead);
        const sdrContext = buildSdrContext({
            fase,
            fluxo: lead.fluxo,
            score: this._estimateLeadScore(lead),
            temperatura: lead.temperatura,
            historico: this._buildHistorico(lead),
            objecoes: this._extractObjecoes(lead, objecao)
        }, analise, antiRep);

        const playbook = sdrLearning.buscarPlaybook(contexto, fase, objecao);
        if (playbook) {
            this._auditIntelligence({
                lead,
                fase,
                objecao,
                origem: 'playbook',
                scorePlaybook: Number(playbook.score.toFixed(3))
            });

            return {
                novaTemperatura: lead.temperatura || 'A definir',
                novoFluxo: lead.fluxo || 'Cenário 1',
                proximaMensagem: playbook.mensagem,
                origem: 'playbook',
                scorePlaybook: Number(playbook.score.toFixed(3)),
                playbookId: playbook.playbookId
            };
        }

        const completion = await this.openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: 'system',
                    content: `${SDR_SCRIPT}\n\nCONTEXTO ESPECIALIZADO SDR:\n${sdrContext}\n\nDIRETRIZ DE ESTILO:\n- Seja criativo na formulacao da mensagem sem perder clareza e objetividade.\n- Evite respostas roboticas ou repetitivas; varie abertura e CTA dentro da fase.\n- Mantenha o foco em conversao com tom humano e profissional.\n\nRetorne um JSON valido com: novaTemperatura (Quente, Frio, A definir), novoFluxo (Cenario atual do fluxo), proximaMensagem (texto da mensagem exata que a automacao devera enviar).`
                },
                {
                    role: 'user',
                    content: `
DADOS DO LEAD:
Número: ${lead.numero}
Nome: ${lead.nome || 'Desconhecido'}
Fluxo Atual: ${lead.fluxo || 'Novo'}
Temperatura: ${lead.temperatura || 'N/A'}
Última Resposta do Lead: ${lead.ultimaResposta || 'Nenhuma (Primeiro contato)'}
Objeção Detectada: ${objecao || 'nenhuma'}

Por favor, gere a próxima mensagem baseada na evolução natural dos dias (Se Novo -> Vá para Cenário 1. Se em Follow-up D1 e sem resposta -> Vá para D5, etc.)`
                }
            ],
            temperature: this._getCreativityTemperature(fase),
            response_format: { type: 'json_object' }
        });

        const action = JSON.parse(completion.choices[0].message.content);
        this._auditIntelligence({
            lead,
            fase,
            objecao,
            origem: 'openai',
            novoFluxo: action.novoFluxo,
            novaTemperatura: action.novaTemperatura
        });

        return {
            ...action,
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

    _buildHistorico(lead) {
        const parts = [lead.fluxo, lead.proximaMensagemAtual, lead.ultimaResposta].filter(Boolean);
        return parts.map((item, idx) => ({ id: idx + 1, text: String(item) }));
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
        if (normalized.includes('fase_1')) return 0.72;
        if (normalized.includes('fase_2')) return 0.63;
        if (normalized.includes('fase_3')) return 0.56;
        return 0.6;
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
