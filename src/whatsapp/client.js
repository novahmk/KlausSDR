/**
 * WhatsApp Client Manager
 * Responsável por conectar via QR Code (whatsapp-web.js) e enviar mensagens.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const logger = require('../config/logger');

class WhatsAppManager {
    constructor() {
        this.client = new Client({
            authStrategy: new LocalAuth({ clientId: 'klaus-crm' }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu'
                ]
            }
        });

        this.isAuthenticated = false;
        this.isReady = false;

        this._setupListeners();
    }

    _setupListeners() {
        // Gerar QR Code no terminal
        this.client.on('qr', (qr) => {
            logger.info('\n📱 [WhatsApp] NOVO QR CODE GERADO. Escaneie com seu celular:');
            qrcode.generate(qr, { small: true });
        });

        // Autenticado com sucesso
        this.client.on('authenticated', () => {
            logger.info('✅ [WhatsApp] Autenticado com sucesso!');
            this.isAuthenticated = true;
        });

        // Cliente pronto para envio
        this.client.on('ready', () => {
            logger.info('🟢 [WhatsApp] Sistema pronto para disparar mensagens!');
            this.isReady = true;
        });

        // Desconectado
        this.client.on('disconnected', (reason) => {
            logger.warn(`🔴 [WhatsApp] Desconectado: ${reason}`);
            this.isAuthenticated = false;
            this.isReady = false;
        });
    }

    /**
     * Inicializa a instância do WhatsApp
     */
    async initialize() {
        logger.info('🔄 [WhatsApp] Inicializando cliente (Buscando sessão salva ou gerando QR)...');
        return this.client.initialize();
    }

    /**
     * Envia uma mensagem de texto para o número fornecido
     * @param {string} phone - Número do telefone (ex: 5511999999999)
     * @param {string} message - Mensagem a ser enviada
     * @returns {Promise<boolean>} Sucesso ou falha
     */
    async sendMessage(phone, message) {
        if (!this.isReady) {
            logger.warn('⚠️ [WhatsApp] Cliente não está pronto. Não foi possível enviar.');
            return false;
        }

        try {
            // Formata o número para o padrão de ID do WhatsApp Web (número@c.us)
            // Remove quaisquer caracteres não numéricos.
            const cleanPhone = phone.replace(/\D/g, '');
            const chatId = `${cleanPhone}@c.us`;

            logger.info(`✉️ [WhatsApp] Enviando mensagem para ${cleanPhone}...`);
            await this.client.sendMessage(chatId, message);
            logger.info(`✅ [WhatsApp] Mensagem enviada com sucesso para ${cleanPhone}!`);
            return true;
        } catch (error) {
            logger.error(`❌ [WhatsApp] Falha ao enviar para ${phone}: ${error.message}`);
            return false;
        }
    }
}

module.exports = new WhatsAppManager();
