/**
 * CRM SDR AI
 * A inteligência artificial que avalia o lead e seleciona/personaliza
 * as mensagens baseada no fluxo estruturado de 7 abas.
 */

const { OpenAI } = require('openai');
const logger = require('../config/logger');

class CrmAI {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    /**
     * Passo 5: Executa (Pensa na ação, busca template, gera texto)
     * e retorna os dados para logar no PENSAMENTO_IA e INTERAÇÔES
     */
    async generateLeadResponse(context) {
        logger.info(`[CrmAI] Analisando contexto para o Lead ID: ${context.lead.id}`);

        const systemInstruction = `
Você é uma IA de Sales Development Representative (SDR).
Seu objetivo é agendar reuniões com tomadores de decisão em clínicas usando empatia, timing e estratégia consultiva.

# BASE DE DADOS FORNECIDA
Você receberá os dados do LEAD, seu PIPELINE atual, os dados de ANÁLISE COMPORTAMENTAL do Lead, suas últimas INTERAÇÕES e os TEMPLATES disponíveis.

# SEU TRABALHO
1. Leia o histórico para entender o contexto exato e em qual 'Cenário' o lead se encontra.
2. Com base no Cenário sugerido pelo Pipeline e pelos templates fornecidos, GERE a mensagem ideal e exata que deve ser enviada.
3. Não envie placeholders (como [Nome da empresa]). Substitua pelos dados reais da base de dados.
4. Você deve agir e parecer humano: mensagens curtas, não como um robô que manda grandes e-mails engessados, mesmo que seja por e-mail.

# SAÍDA (Retorne apenas JSON válido com os seguintes campos):
{
  "mensagem_gerada": "Texto exato a ser enviado (Email ou WhatsApp)",
  "padrao_detectado": "Analise como ele vem respondendo (ex: ocupado mas não negou)",
  "comportamento": "ex: Passivo, Receptivo, Frio, Agressivo",
  "cenario": "Número do cenário que você acabou de aplicar (1 a 6)",
  "proxima_acao_recomendada": "O que devemos fazer a seguir e em quantos dias",
  "confianca": 85,
  "notas_ia": "Seu raciocínio interno (o porquê decidiu escrever assim)"
}
`;

        const userPayload = `
[DADOS DO LEAD]
Nome: ${context.lead.nome || 'Responsável'}
Empresa: ${context.lead.empresa || 'a Clínica'}

[PIPELINE]
Status Atual: ${context.pipeline?.status_atual || 'Início'}
Cenário Sugerido (1-6): ${context.pipeline?.cenario || '1'}

[ANÁLISE E MÉTRICAS]
- Taxa Resposta: ${context.analise?.taxa_resposta || '0%'}
- Melhor Hora: ${context.analise?.melhor_hora_contato || 'N/A'}
- Dias desde último contato: ${context.analise?.dias_sem_contato || '0'}

[ÚLTIMAS INTERAÇÕES (Histórico)]
${context.interacoes.length > 0
                ? context.interacoes.map(i => `Data: ${i.data} | Msg enviada: ${i.mensagem_enviada} | Resposta do Lead: ${i.resposta_recebida || 'Nenhuma'} | Objeção: ${i.objecao_levantada || 'Não'}`).join('\n')
                : 'Primeiro contato, nenhuma interação prévia.'}

[PENSAMENTO ANTERIOR DA IA SOBRE ESSE LEAD]
${context.pensamentoAnterior?.notas_ia || 'Nenhum histórico de pensamento.'}

[TEMPLATES DISPONÍVEIS]
${JSON.stringify(context.templates, null, 2)}

COMO AGIR: Use o template correspondente ao cenário apropriado e adapte ao contexto. Gere a próxima ação!
`;

        try {
            const completion = await this.openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: systemInstruction.trim() },
                    { role: 'user', content: userPayload.trim() }
                ],
                temperature: 0.5,
                response_format: { type: 'json_object' }
            });

            return JSON.parse(completion.choices[0].message.content);
        } catch (error) {
            logger.error(`Erro na OpenAI para Lead ${context.lead.id}: ${error.message}`);
            return null;
        }
    }
}

module.exports = new CrmAI();
