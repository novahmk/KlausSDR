/* DEPRECATED — Não utilizado no fluxo SDR ativo.
 * Este arquivo foi parte do ciclo multi-agente Manager/Attendant (código-gerador).
 * O fluxo SDR atual utiliza: sdr-whatsapp.js → sdr-state-machine.js → openai/sdr-engine.js
 * Mantido apenas para referência histórica. Não instanciar em produção.
 */

/**
 * System Orchestrator
 * Coordinates the full Manager → Attendant → Manager cycle
 */

const managerAnalyzer = require('../agents/manager/analyzer');
const taskAssigner = require('../agents/manager/task-assigner');
const decisionMaker = require('../agents/manager/decision-maker');
const attendantExecutor = require('../agents/attendant/executor');
const performance = require('../sheets/performance');
const logger = require('../config/logger');

class Orchestrator {
    /**
     * Run one full cycle:
     * Phase 1 Manager Analysis →
     * Phase 2 Task Generation →
     * Phase 3 Attendant Execution →
     * Phase 4 Manager Validation →
     * Phase 5 Performance Recording
     *
     * @returns {Object} cycle result summary
     */
    async runFullCycle() {
        const SEP = '═'.repeat(60);
        logger.info(`\n${SEP}\n🚀 ORCHESTRATOR: Full cycle starting\n${SEP}`);

        const cycleStart = Date.now();
        const result = {};

        try {
            // ── PHASE 0: Leads Sync ──────────────────────────────────
            logger.info('\n━━━ PHASE 0: Interação com Leads ━━━\n');
            const leadsList = require('../sheets/leads-list');
            const sdrEngine = require('../openai/sdr-engine');
            const sdrLearning = require('../openai/sdr-learning');

            // Verifica o interativo REINICIAR na J2
            await leadsList.checkForRestartTag();

            // Pega leads pendentes
            const pendingLeads = await leadsList.getPendingLeads();
            if (pendingLeads.length > 0) {
                logger.info(`Encontrei ${pendingLeads.length} leads precisando de atenção do SDR!`);

                for (const lead of pendingLeads) {
                    try {
                        if (lead.ultimaResposta && lead.proximaMensagemAtual) {
                            const faseAtual = String(lead.fluxo || 'indefinida');
                            const objecao = this._inferObjecao(lead.ultimaResposta);

                            if (this._isPositiveLeadReply(lead.ultimaResposta)) {
                                sdrLearning.registrarSucesso({
                                    telefone: lead.numero,
                                    mensagemEnviada: lead.proximaMensagemAtual,
                                    objecao,
                                    fase: faseAtual,
                                    resposta: lead.ultimaResposta
                                });
                            } else {
                                sdrLearning.registrarFalha(
                                    lead.proximaMensagemAtual,
                                    faseAtual,
                                    objecao
                                );
                            }
                        }

                        // IA analisa e gera a próxima ação/mensagem 
                        const action = await sdrEngine.generateNextAction(lead);

                        // Salva o resultado na planilha
                        await leadsList.updateLead(lead.numero, {
                            fluxo: action.novoFluxo,
                            temperatura: action.novaTemperatura,
                            proximaMensagem: action.proximaMensagem,
                            apagarResposta: !!lead.ultimaResposta // Se tinha resposta nova, agora limpa pois já processou
                        });

                        // Dá uma pausa pequena para não estourar rate limit da OpenAI 
                        await new Promise(r => setTimeout(r, 1000));
                    } catch (err) {
                        logger.error(`Erro ao gerar ação SDR para lead ${lead.numero}: ${err.message}`);
                    }
                }
            } else {
                logger.info('Nenhum lead pendente de ação SDR no momento.');
            }

            // ── PHASE 1: Manager analyses project state ──────────────
            logger.info('\n━━━ PHASE 1: Manager Analysis ━━━\n');
            result.analysis = await managerAnalyzer.analyzeDailyStatus();
            logger.info(`✅ Phase 1 done — confidence: ${result.analysis.confidence}%`);

            // ── PHASE 2: Manager generates next task ─────────────────
            logger.info('\n━━━ PHASE 2: Task Generation ━━━\n');
            const { taskId, task } = await taskAssigner.generateNextTask(result.analysis);
            result.task = { taskId, task };
            logger.info(`✅ Phase 2 done — task: ${taskId}`);

            // ── PHASE 3: Attendant fetches and executes task ─────────
            logger.info('\n━━━ PHASE 3: Attendant Execution ━━━\n');
            const nextTask = await attendantExecutor.getNextTask();

            if (!nextTask) {
                logger.info('✅ No pending tasks — cycle complete early');
                return result;
            }

            result.execution = await attendantExecutor.executeTask(
                nextTask.id,
                nextTask.spec
            );
            logger.info(`✅ Phase 3 done — code: ${result.execution.codeId}`);

            // ── PHASE 4: Manager validates Attendant output ──────────
            logger.info('\n━━━ PHASE 4: Manager Validation ━━━\n');
            result.validation = await taskAssigner.validateCodeFromAttendant(
                result.execution.codeId,
                result.execution.code
            );
            logger.info(`✅ Phase 4 done — approved: ${result.validation.approved}`);

            // ── PHASE 5: Record performance ──────────────────────────
            const elapsed = Math.round((Date.now() - cycleStart) / 60000);
            await performance.record({
                tasksCompleted: 1,
                successRate: result.validation.approved ? 100 : 0,
                bugsFound: (result.validation.issues || []).length,
                codeOptimization: 0,
                avgTimeMinutes: elapsed,
                learnings: 1,
                overallConfidence: result.validation.score || 80,
                notes: `Cycle OK — ${result.execution.filename}`
            });

            logger.info(`\n${SEP}\n✅ ORCHESTRATOR: Cycle complete in ~${elapsed} min\n${SEP}`);
            return result;

        } catch (error) {
            logger.error('ORCHESTRATOR: Cycle failed', { message: error.message });

            await performance.record({
                tasksCompleted: 0,
                successRate: 0,
                bugsFound: 1,
                overallConfidence: 0,
                notes: `Error: ${error.message}`
            });

            throw error;
        }
    }

    /**
     * Run loop mode: keep cycling until no pending tasks remain
     * @param {number} delayMs - delay between cycles (ms)
     */
    async runLoop(delayMs = 5000) {
        logger.info('🔄 ORCHESTRATOR: Loop mode started');

        let cycle = 1;

        while (true) {
            logger.info(`\n📍 CYCLE ${cycle}`);

            try {
                const result = await this.runFullCycle();

                if (!result.execution) {
                    logger.info('🎉 All tasks complete — exiting loop');
                    break;
                }

                if (!result.validation?.approved) {
                    logger.warn('⚠️ Validation failed — pausing loop');
                    break;
                }
            } catch (err) {
                logger.error(`Cycle ${cycle} error: ${err.message}`);
                break;
            }

            cycle++;
            logger.info(`⏳ Waiting ${delayMs / 1000}s before next cycle...`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }

    _isPositiveLeadReply(reply) {
        const text = String(reply || '').toLowerCase();
        if (!text) return false;

        const positiveHints = [
            'pode ser',
            'vamos marcar',
            'pode agendar',
            'tenho interesse',
            'sim',
            'ok',
            'podemos falar',
            'manda horario',
            'manda horário'
        ];

        const negativeHints = [
            'nao quero',
            'não quero',
            'sem interesse',
            'pare',
            'nao chamar',
            'não chamar',
            'remover',
            'cancelar'
        ];

        if (negativeHints.some(h => text.includes(h))) return false;
        return positiveHints.some(h => text.includes(h));
    }

    _inferObjecao(reply) {
        const text = String(reply || '').toLowerCase();
        if (!text) return '';
        if (text.includes('email') || text.includes('e-mail')) return 'envie por email';
        if (text.includes('sem interesse') || text.includes('nao tenho interesse') || text.includes('não tenho interesse')) return 'sem interesse';
        if (text.includes('fornecedor')) return 'ja tem fornecedor';
        if (text.includes('orcamento') || text.includes('orçamento')) return 'sem orcamento';
        if (text.includes('depois') || text.includes('nao agora') || text.includes('não agora')) return 'timing';
        return '';
    }
}

module.exports = new Orchestrator();
