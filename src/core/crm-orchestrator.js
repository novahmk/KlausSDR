/**
 * CRM Orchestrator
 * Coordena as 6 fases da iteração de SDR CRM (Leads -> Pipeline -> Análise -> Execução -> Log)
 */

const { crmSheets, CRM_TABS } = require('../sheets/crm-sheets');
const crmAi = require('../openai/crm-ai');
const whatsappClient = require('../whatsapp/client');
const logger = require('../config/logger');

class CrmOrchestrator {

    /**
     * Executa a rotina onde o SDR varre a planilha LEADS,
     * pega todo mundo que precisa de follow-up e gera o próximo contato.
     */
    async processLeadsDaily() {
        logger.info('\n════════════════════════════════════════════════════════════');
        logger.info('🚀 KLAUS CRM: Iniciando Rotina Diária de SDR');
        logger.info('════════════════════════════════════════════════════════════\n');

        try {
            // 1. Carrega Templates
            const rawTemplates = await crmSheets.getAll(CRM_TABS.TEMPLATES);
            // Transform array de arrays em um array de objetos p/ a IA
            const templateHeaders = rawTemplates[0] || [];
            const templates = rawTemplates.slice(1).map(row => {
                let obj = {};
                row.forEach((val, i) => obj[templateHeaders[i]] = val);
                return obj;
            });

            // 2. Lê Leads da aba LEADS
            const leadsRaw = await crmSheets.getAll(CRM_TABS.LEADS);
            if (leadsRaw.length < 2) {
                logger.info('Nenhum Lead encontrado em LEADS.');
                return;
            }

            const leadsHeaders = leadsRaw[0].map(h => String(h).toLowerCase());
            const idIdx = leadsHeaders.findIndex(h => h.includes('id') || h === 'lead_id' || h === 'lead id');
            const nomeIdx = leadsHeaders.findIndex(h => h.includes('nome'));

            for (let r = 1; r < leadsRaw.length; r++) {
                const leadRow = leadsRaw[r];
                const leadId = leadRow[idIdx];
                if (!leadId) continue; // Ignora linhas vazias

                const leadData = {
                    id: leadId,
                    nome: leadRow[nomeIdx] || 'Indefinido',
                    raw: leadRow
                };

                logger.info(`🔍 Analisando Lead ID: ${leadId} (${leadData.nome})`);

                // 3. Carrega o Contexto Completo das 7 Abas
                const pipeline = await this._getRowObj(CRM_TABS.PIPELINE, leadId);
                const interacoes = await this._getManyObj(CRM_TABS.INTERACOES, leadId);
                const analise = await this._getRowObj(CRM_TABS.ANALISE, leadId);
                const pensamentoAnterior = await this._getLastObj(CRM_TABS.PENSAMENTO_IA, leadId);

                // Dica: A IA processa interações antigas, então precisamos ver se tem algo pendente para HOJE.
                // Aqui você integraria uma função "deveMandarMensagemHoje(pipeline, analise)" (baseado na aba FOLLOW-UP).
                // Para manter interativo na validação: Vamos pedir pra IA agir e guardar a mensagem no final!

                const fullContext = {
                    lead: leadData,
                    pipeline,
                    interacoes,
                    analise,
                    pensamentoAnterior,
                    templates
                };

                // Passo 4 e 5: IA Escolhe e Executa a lógica
                const iaResponse = await crmAi.generateLeadResponse(fullContext);

                if (!iaResponse || !iaResponse.mensagem_gerada) {
                    logger.warn(`Falha na IA ou mensagem não gerada para o lead ${leadId}. Pulando...`);
                    continue;
                }

                logger.info(`✅ Mensagem Gerada para Lead ${leadId} (Confiança: ${iaResponse.confianca}%)`);

                // DISPARO WHATSAPP: Envia a mensagem gerada para o WhatsApp do cara!
                const sentSuccess = await whatsappClient.sendMessage(leadId, iaResponse.mensagem_gerada);
                const statusEnvio = sentSuccess ? 'Enviado Sucesso' : 'Falha no Envio WebJS';

                // Passo 6: Loga no PENSAMENTO_IA 
                await crmSheets.appendRow(CRM_TABS.PENSAMENTO_IA, {
                    lead_id: leadId,
                    ultimo_status: pipeline?.status_atual || 'Novo',
                    padrao_detectado: iaResponse.padrao_detectado,
                    comportamento: iaResponse.comportamento,
                    proxima_acao_recomendada: iaResponse.proxima_acao_recomendada,
                    confianca: `${iaResponse.confianca}%`,
                    notas_ia: iaResponse.notas_ia,
                    data_analise: new Date().toISOString()
                });

                // Passo 6: Loga na INTERAÇÕES a mensagem enviada
                await crmSheets.appendRow(CRM_TABS.INTERACOES, {
                    id: `int_${Date.now()}`,
                    lead_id: leadId,
                    data: new Date().toLocaleDateString('pt-BR'),
                    hora: new Date().toLocaleTimeString('pt-BR'),
                    tipo_contato: `WhatsApp [${statusEnvio}]`,
                    mensagem_enviada: iaResponse.mensagem_gerada,
                    resposta_recebida: '',
                    tempo_resposta: '',
                    resposta_positiva: '',
                    objecao_levantada: '',
                    notas: `Status/Cenário aplicado: ${iaResponse.cenario}`
                });

                logger.info(`💾 Logs salvos em PENSAMENTO_IA e INTERAÇÕES para o Lead ${leadId}.`);

                // Delay para limites da API
                await new Promise(res => setTimeout(res, 1500));
            }

            logger.info('\n✅ Rotina de Leads Finalizada. Consultas Registradas!');

        } catch (error) {
            logger.error(`Erro crítico no orquestrador de CRM: ${error.message}`);
        }
    }

    // --- Helpers de Parsing 

    async _getRowObj(tabName, leadId) {
        const rows = await crmSheets.getAll(tabName);
        if (rows.length < 2) return null;
        const headers = rows[0].map(h => String(h).toLowerCase());
        const row = rows.find(r => String(r[0]) === String(leadId) || String(r[1]) === String(leadId));
        if (!row) return null;
        let obj = {};
        row.forEach((val, i) => obj[headers[i]] = val);
        return obj;
    }

    async _getManyObj(tabName, leadId) {
        const rows = await crmSheets.getAll(tabName);
        if (rows.length < 2) return [];
        const headers = rows[0].map(h => String(h).toLowerCase());
        const leadRows = rows.filter(r => String(r[0]) === String(leadId) || String(r[1]) === String(leadId));
        return leadRows.map(row => {
            let obj = {};
            row.forEach((val, i) => obj[headers[i]] = val);
            return obj;
        });
    }

    async _getLastObj(tabName, leadId) {
        const objs = await this._getManyObj(tabName, leadId);
        return objs[objs.length - 1] || null;
    }
}

module.exports = new CrmOrchestrator();
