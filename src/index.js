/**
 * IA Multi-Agente — Entry Point
 * Initializes environment, validates deps, and starts orchestrator
 *
 * Usage:
 *   npm start              → one full cycle
 *   LOOP=true npm start    → continuous loop mode
 */

require('dotenv').config();

const env = require('./config/env');
const logger = require('./config/logger');
const stateManager = require('./core/state-manager');
const { separator } = require('./utils/formatters');

// Módulos SDR ativos
const SDRWhatsApp = require('./sdr-whatsapp');
const Scheduler = require('./sdr/sdr-scheduler');

class IASystem {
    /**
     * Boot the system
     */
    async start() {
        logger.info(`\n${separator()}`);
        logger.info('🤖  KLAUS MULTI-AGENTE  |  Manager + Attendant System');
        logger.info(separator());

        // 1. Validate required env vars
        env.validate();

        // 2. Display startup config
        logger.info(`Mode: ${process.env.LOOP === 'true' ? 'LOOP' : 'ONE-SHOT'}`);
        logger.info(`Log Level: ${process.env.LOG_LEVEL || 'info'}`);
        logger.info(`Cycle Interval: ${env.CYCLE_INTERVAL_MINUTES} min`);

        // 3. Run
        stateManager.startCycle();

        try {
            // 4. Inicializa o WhatsApp e espera ele pedir QR Code e Autenticar
            logger.info('Iniciando o subsistema WhatsApp SDR...');
            await SDRWhatsApp.iniciar();

            // Fica aguardando o cliente ficar verde (isReady = true)
            logger.info('⏳ Aguardando leitura do QR Code ou carregamento da sessão...');
            while (!SDRWhatsApp.isReady) {
                await new Promise(r => setTimeout(r, 2000));
            }

            Scheduler.start({ whatsappClient: SDRWhatsApp.whatsapp });

            if (process.env.LOOP === 'true') {
                const intervalMs = env.CYCLE_INTERVAL_MINUTES * 60 * 1000;
                logger.info(`🔄 Loop ativo. O sistema de WhatsApp está escutando respostas... E checará novos leads na planilha a cada ${env.CYCLE_INTERVAL_MINUTES} minuto(s).`);

                while (true) {
                    await SDRWhatsApp.iniciarAbordagensDeNovosLeads();
                    await new Promise(r => setTimeout(r, intervalMs));
                }
            } else {
                // Modo disparo apenas (lê e envia) e fica ouvindo
                logger.info('Rotina SDR única... Lendo aba LEADS!');
                await SDRWhatsApp.iniciarAbordagensDeNovosLeads();
                logger.info('✅ Abordagens ativas enviadas. O SDR continuará rodando para responder a quem mandar mensagem no WhatsApp!!');
                // IMPORTANTE: NÃO matamos o processo aqui, pois o webSocket do whatsapp precisa ficar ativo
                // Só saímos se fechar via Terminal.
            }

            // Removendo stateManager.endCycle e process.exit para manter o app vivo!

        } catch (error) {
            stateManager.endCycle(false);
            stateManager.recordError(error);
            logger.error('Fatal error', { message: error.message });
            process.exit(1);
        }
    }

    /**
     * Graceful shutdown handler
     */
    stop() {
        logger.info('\n🛑 System shutting down...');
        Scheduler.stop();
        stateManager.set('isRunning', false);
    }
}

// Signal handlers
const system = new IASystem();
process.on('SIGINT', () => system.stop());
process.on('SIGTERM', () => system.stop());

// Only run when this file is the main entry point
if (require.main === module) {
    system.start().catch(err => {
        console.error('\n❌ Unhandled boot error:', err.message);
        process.exit(1);
    });
}

module.exports = IASystem;
