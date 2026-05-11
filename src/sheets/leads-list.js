/**
 * Leads List Sheet Manager
 * Manages Sheet 6: Lista leads (engagement pipeline)
 * 
 * Colunas esperadas no Google Sheets:
 * A: Numero
 * B: Nome
 * C: Temperatura (quente/frio)
 * D: Fluxo (Cenário atual de 1 a 6)
 * E: Proxima Mensagem (Gerada pela IA)
 * F: Resposta do Lead (Preenchida quando o lead responde)
 */

const { GoogleSheetsClient } = require('./client');
const { SHEETS } = require('../config/constants');
const logger = require('../config/logger');

const RANGE = `${SHEETS.LEADS_LIST}!A:J`;

class LeadsList {
    constructor() {
        this.sheets = new GoogleSheetsClient();
    }

    /**
     * Verifica se há a flag 'REINICIAR' em J2. 
     * Se houver, limpa o fluxo de todos para forçar reanálise e limpa a J2.
     */
    async checkForRestartTag() {
        try {
            const j2Value = await this.sheets.getRange(`${SHEETS.LEADS_LIST}!J2`);
            if (j2Value && j2Value[0] && j2Value[0][0] === 'REINICIAR') {
                logger.info('🔄 [Klaus.Leads] Comando REINICIAR detectado em J2! Resetando os leads...');

                const rows = await this.sheets.getRange(RANGE);
                if (rows.length > 1) {
                    const headers = rows[0] || [];
                    const fluxoCol = headers.findIndex(h => h.toLowerCase() === 'fluxo');

                    if (fluxoCol !== -1) {
                        const colLetter = String.fromCharCode(65 + fluxoCol);
                        // Limpa o fluxo para cada lead
                        for (let i = 1; i < rows.length; i++) {
                            if (rows[i][0]) { // Se existe número
                                await this.sheets.updateCell(`${SHEETS.LEADS_LIST}!${colLetter}${i + 1}`, '');
                            }
                        }
                    }
                }

                // Limpa a tag J2
                await this.sheets.updateCell(`${SHEETS.LEADS_LIST}!J2`, '');
                return true;
            }
        } catch (error) {
            // Ignora se der erro ou J2 estiver vazio
        }
        return false;
    }

    /**
     * Busca leads pendentes que precisem de interação 
     * (não têm Próxima Mensagem gerada ou a Fase permite nova ação)
     * @returns {Promise<Array>} Lista de leads pendentes
     */
    async getPendingLeads() {
        logger.info('[Klaus.Leads] Buscando leads para atualizar o fluxo...');

        try {
            const rows = await this.sheets.queryRange(RANGE);
            if (!rows.length) return [];

            // Um lead é pendente se, por exemplo, o "Proxima Mensagem" estiver vazio
            // Isso significa que nós não geramos o texto de contato para ele ainda
            // ou se chegou uma "Resposta do Lead" (F) e precisamos responder.
            const pending = rows.filter(row => {
                const numero = row.numero;
                const msg = row['proxima mensagem'] || row.proxima_mensagem || row.proximamensagem || row['próxima mensagem'];
                const resposta = row['resposta do lead'] || row.resposta_do_lead || row.respostadolead;

                // Se o número existe e NÃO há mensagem engatilhada, ou se tem uma nova resposta que precisa ser lida
                return numero && (!msg || resposta);
            }).map(row => ({
                numero: row.numero,
                nome: row.nome,
                temperatura: row.temperatura,
                fluxo: row.fluxo,
                ultimaResposta: row['resposta do lead'] || row.respostadolead,
                proximaMensagemAtual: row['proxima mensagem'] || row.proxima_mensagem || row.proximamensagem || row['próxima mensagem'] || ''
            }));

            logger.info(`[Klaus.Leads] Encontrou ${pending.length} leads precisando da inteligência do SDR.`);
            return pending;
        } catch (error) {
            logger.warn(`[Klaus.Leads] Erro ao buscar leads: ${error.message}`);
            return [];
        }
    }

    /**
     * Atualiza as informações processadas de um lead na planilha
     * @param {string} numero - Número do lead (Coluna A)
     * @param {Object} data - Dados para atualizar { nome, temperatura, fluxo, proximaMensagem, apagarResposta }
     */
    async updateLead(numero, data) {
        logger.info(`[Klaus.Leads] Salvando status SDR do lead: ${numero}`);

        try {
            const rows = await this.sheets.getRange(RANGE);
            const headers = rows[0] || ['numero', 'nome', 'temperatura', 'fluxo', 'proxima mensagem', 'resposta do lead'];

            const getColIdx = (aliases) => headers.findIndex(h => aliases.includes(h.toLowerCase().trim() || h));

            const numCol = getColIdx(['numero', 'número']);
            const nomeCol = getColIdx(['nome']);
            const tempCol = getColIdx(['temperatura']);
            const fluxoCol = getColIdx(['fluxo', 'fase']);
            const msgCol = getColIdx(['proxima mensagem', 'próxima mensagem', 'mensagem']);
            const respCol = getColIdx(['resposta do lead', 'resposta']);

            const rowIndex = rows.findIndex(
                (row, i) => i > 0 && row[numCol] === String(numero)
            );

            if (rowIndex === -1) {
                logger.warn(`[Klaus.Leads] Lead ${numero} não encontrado na planilha.`);
                return;
            }

            const sheetRow = rowIndex + 1; // 1-indexed

            // Atualiza Nome se existir
            if (data.nome && nomeCol !== -1) {
                const colLetter = String.fromCharCode(65 + nomeCol);
                await this.sheets.updateCell(`${SHEETS.LEADS_LIST}!${colLetter}${sheetRow}`, data.nome);
            }

            // Atualiza Temperatura se existir
            if (data.temperatura && tempCol !== -1) {
                const colLetter = String.fromCharCode(65 + tempCol);
                await this.sheets.updateCell(`${SHEETS.LEADS_LIST}!${colLetter}${sheetRow}`, data.temperatura);
            }

            // Atualiza Fluxo se existir
            if (data.fluxo && fluxoCol !== -1) {
                const colLetter = String.fromCharCode(65 + fluxoCol);
                await this.sheets.updateCell(`${SHEETS.LEADS_LIST}!${colLetter}${sheetRow}`, data.fluxo);
            }

            // Grava a Próxima Mensagem
            if (data.proximaMensagem && msgCol !== -1) {
                const colLetter = String.fromCharCode(65 + msgCol);
                await this.sheets.updateCell(`${SHEETS.LEADS_LIST}!${colLetter}${sheetRow}`, data.proximaMensagem);
            }

            // Limpa a Resposta do Lead (já que foi lida e processada)
            if (data.apagarResposta && respCol !== -1) {
                const colLetter = String.fromCharCode(65 + respCol);
                await this.sheets.updateCell(`${SHEETS.LEADS_LIST}!${colLetter}${sheetRow}`, '');
            }

            logger.info(`[Klaus.Leads] Lead ${numero} atualizado no Fluxo: ${data.fluxo}`);

        } catch (error) {
            logger.error(`[Klaus.Leads] Erro ao atualizar lead: ${error.message}`);
        }
    }
}

module.exports = new LeadsList();
