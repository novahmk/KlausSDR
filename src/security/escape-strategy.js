/**
 * ESCAPE STRATEGY MODULE
 * Quando BOT é detectado, tenta contatar humano por canais alternativos.
 *
 * FLUXO DE ESCAPE (por prioridade):
 *  1. SMS para número principal
 *  2. SMS para número alternativo
 *  3. Ligação (Twilio Voice)
 *  4. WhatsApp alternativo
 *  5. Escalamento para operador humano (sempre garante sucesso)
 *
 * Cada tentativa é registada em AUDIT_LOG via securitySheets.
 * O resultado final é persistido em BOT_DETECCOES via o caller.
 */

const logger = require('../config/logger');
const { crmSheets, CRM_TABS } = require('../sheets/crm-sheets');
const { securitySheets } = require('../sheets/security-sheets');

// Canais em ordem de prioridade
const ESCAPE_CHANNELS = [
    { channel: 'SMS_PRIMARY',    priority: 1 },
    { channel: 'SMS_ALTERNATIVE', priority: 2 },
    { channel: 'CALL',           priority: 3 },
    { channel: 'WHATSAPP_ALT',   priority: 4 },
    { channel: 'HUMAN',          priority: 5 },
];

class EscapeStrategy {
    constructor() {
        this.maxRetries = 3;
        // leadId → [{ channel, success, timestamp, error? }]
        this.escapeAttempts = new Map();
        // Referência ao cliente WhatsApp (injetada por sdr-whatsapp ao inicializar)
        this.whatsappClient = null;
    }

    /**
     * Injeta o cliente WhatsApp para uso no canal WHATSAPP_ALT.
     * Chamado por sdr-whatsapp após o cliente estar pronto.
     * @param {Object} client - instância whatsapp-web.js
     */
    setWhatsAppClient(client) {
        this.whatsappClient = client;
    }

    // ─────────────────────────────────────────────────────────
    // MÉTODO PRINCIPAL
    // ─────────────────────────────────────────────────────────

    /**
     * Executa a sequência de escape quando um BOT é detectado.
     *
     * @param {string} leadId         - número/ID do lead
     * @param {Object} leadData       - dados do lead (nome, telefone, empresa…)
     * @param {number} botConfidence  - score de confiança 0-100
     *
     * @returns {Promise<Object>} { success, channelUsed, attemptNumber, details, timestamp, humanNotified }
     */
    async executeEscape(leadId, leadData, botConfidence) {
        logger.info(`[ESCAPE] Iniciando escape para lead ${leadId} (confiança: ${botConfidence}%)`);

        if (!this.escapeAttempts.has(leadId)) {
            this.escapeAttempts.set(leadId, []);
        }
        const attempts = this.escapeAttempts.get(leadId);

        // Já esgotou as tentativas → escala direto para humano
        if (attempts.length >= this.maxRetries) {
            logger.warn(`[ESCAPE] Limite (${this.maxRetries}) atingido para ${leadId}. Escalando para humano.`);
            return this._escalateToHuman(leadId, leadData, botConfidence, 'Máximo de tentativas excedido');
        }

        for (const { channel } of ESCAPE_CHANNELS) {
            try {
                logger.info(`[ESCAPE] Tentativa ${attempts.length + 1} via ${channel} para ${leadId}`);
                const result = await this._executeChannel(channel, leadId, leadData);

                attempts.push({
                    channel,
                    success: result.success,
                    timestamp: new Date().toISOString(),
                    error: result.error || null
                });

                await this._logAudit(leadId, channel, result.success ? 'SUCESSO' : 'FALHA', result.details || result.error || '', botConfidence);

                if (result.success) {
                    logger.info(`[ESCAPE] ✅ Sucesso via ${channel} para lead ${leadId}`);
                    return {
                        success: true,
                        channelUsed: channel,
                        attemptNumber: attempts.length,
                        details: result.details,
                        timestamp: new Date().toISOString(),
                        humanNotified: channel === 'HUMAN'
                    };
                }

                logger.warn(`[ESCAPE] ⚠️ Falha via ${channel}: ${result.error}`);
            } catch (err) {
                logger.error(`[ESCAPE] Erro inesperado no canal ${channel}: ${err.message}`);
                attempts.push({ channel, success: false, timestamp: new Date().toISOString(), error: err.message });
            }
        }

        // Todos os canais falharam → escala para humano (sempre garante resultado)
        logger.error(`[ESCAPE] Todos os canais falharam para ${leadId}. Escalando.`);
        return this._escalateToHuman(leadId, leadData, botConfidence, 'Todos os canais falharam');
    }

    // ─────────────────────────────────────────────────────────
    // DISPATCHER DE CANAIS
    // ─────────────────────────────────────────────────────────

    async _executeChannel(channel, leadId, leadData) {
        switch (channel) {
            case 'SMS_PRIMARY':      return this._sendSMS(leadData.telefone, leadData);
            case 'SMS_ALTERNATIVE':  return this._sendSMS(leadData.telefone_alternativo, leadData);
            case 'CALL':             return this._initiateCall(leadData);
            case 'WHATSAPP_ALT':     return this._tryAlternativeWhatsApp(leadData);
            case 'HUMAN':            return this._escalateToHuman(leadId, leadData, 0, 'Fallback após canais');
            default:                 return { success: false, error: `Canal desconhecido: ${channel}` };
        }
    }

    // ─────────────────────────────────────────────────────────
    // CANAL 1 & 2: SMS
    // ─────────────────────────────────────────────────────────

    async _sendSMS(phoneNumber, leadData) {
        if (!phoneNumber || !phoneNumber.trim()) {
            return { success: false, error: 'Número de telefone não disponível' };
        }

        const formatted = this._formatPhone(phoneNumber);
        if (!formatted) {
            return { success: false, error: `Número inválido: ${phoneNumber}` };
        }

        // Verificar se provedor está configurado
        if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
            logger.info(`[ESCAPE SMS] Provedor SMS não configurado. Número alvo: ${formatted.slice(-4)}`);
            return { success: false, error: 'SMS_PROVIDER_NOT_CONFIGURED: defina TWILIO_ACCOUNT_SID e TWILIO_AUTH_TOKEN no .env' };
        }

        try {
            // Integração Twilio (activa quando env vars estão presentes)
            const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            const msg = await twilio.messages.create({
                to: formatted,
                from: process.env.TWILIO_PHONE_NUMBER,
                body: this._buildSMSMessage(leadData)
            });
            return { success: true, details: `SMS enviado — SID: ${msg.sid} → ...${formatted.slice(-4)}` };
        } catch (err) {
            return { success: false, error: `Twilio SMS error: ${err.message}` };
        }
    }

    // ─────────────────────────────────────────────────────────
    // CANAL 3: Ligação
    // ─────────────────────────────────────────────────────────

    async _initiateCall(leadData) {
        const formatted = this._formatPhone(leadData.telefone);
        if (!formatted) {
            return { success: false, error: 'Número inválido para ligação' };
        }

        if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_VOICE_URL) {
            logger.info(`[ESCAPE CALL] Twilio Voice não configurado. Alvo: ${formatted.slice(-4)}`);
            return { success: false, error: 'CALL_PROVIDER_NOT_CONFIGURED: defina TWILIO_ACCOUNT_SID e TWILIO_VOICE_URL no .env' };
        }

        try {
            const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            const call = await twilio.calls.create({
                to: formatted,
                from: process.env.TWILIO_PHONE_NUMBER,
                url: process.env.TWILIO_VOICE_URL,
                timeout: 15,
                statusCallback: process.env.BASE_URL ? `${process.env.BASE_URL}/api/call-status` : undefined,
                statusCallbackEvent: ['completed']
            });
            return { success: true, details: `Ligação iniciada — SID: ${call.sid} → ...${formatted.slice(-4)}` };
        } catch (err) {
            return { success: false, error: `Twilio Call error: ${err.message}` };
        }
    }

    // ─────────────────────────────────────────────────────────
    // CANAL 4: WhatsApp alternativo
    // ─────────────────────────────────────────────────────────

    async _tryAlternativeWhatsApp(leadData) {
        const altNumber = leadData.whatsapp_alternativo;
        if (!altNumber || !altNumber.trim()) {
            return { success: false, error: 'WhatsApp alternativo não registado' };
        }

        const clean = altNumber.replace(/\D/g, '');
        if (clean.length < 10) {
            return { success: false, error: `WhatsApp alternativo inválido: ${altNumber}` };
        }

        if (!this.whatsappClient) {
            return { success: false, error: 'WhatsApp client não disponível (não injectado)' };
        }

        try {
            const chatId = `${clean}@c.us`;
            await this.whatsappClient.sendMessage(chatId, this._buildWhatsAppMessage(leadData));
            return { success: true, details: `WhatsApp enviado para ...${clean.slice(-4)}` };
        } catch (err) {
            return { success: false, error: `WhatsApp alt error: ${err.message}` };
        }
    }

    // ─────────────────────────────────────────────────────────
    // CANAL 5: Escalamento para operador humano
    // ─────────────────────────────────────────────────────────

    async _escalateToHuman(leadId, leadData, botConfidence, reason) {
        const msg = this._buildEscalationMessage(leadId, leadData, botConfidence, reason);

        try {
            await securitySheets.createAlert({
                tipoAlerta: 'Contato Alternativo Necessário',
                severidade: 'Crítico',
                leadId,
                descricao: msg,
                acaoAutomatica: 'ESCALAR_PARA_OPERADOR'
            });
        } catch (err) {
            logger.warn(`[ESCAPE HUMAN] Erro ao criar alerta: ${err.message}`);
        }

        // Notificação para operador (Slack/Email — activa quando configurado)
        this._notifyOperator({ leadId, leadData, botConfidence, reason, msg }).catch(() => {});

        logger.warn(`[ESCAPE HUMAN] Lead ${leadId} escalado para operador: ${reason}`);
        return {
            success: true,
            details: `Operador notificado: ${reason}`,
            humanNotified: true
        };
    }

    // ─────────────────────────────────────────────────────────
    // NOTIFICAÇÃO DE OPERADOR
    // ─────────────────────────────────────────────────────────

    async _notifyOperator({ leadId, leadData, botConfidence, reason, msg }) {
        if (!process.env.SLACK_WEBHOOK_ESCALATION) {
            logger.debug('[ESCAPE NOTIFY] SLACK_WEBHOOK_ESCALATION não configurado — pulando notificação Slack');
            return;
        }

        try {
            const https = require('https');
            const url = new URL(process.env.SLACK_WEBHOOK_ESCALATION);
            const payload = JSON.stringify({
                blocks: [
                    { type: 'header', text: { type: 'plain_text', text: '🔴 ESCALATION: BOT Detectado' } },
                    {
                        type: 'section',
                        fields: [
                            { type: 'mrkdwn', text: `*Lead:* ${leadData.nome || leadId}` },
                            { type: 'mrkdwn', text: `*Empresa:* ${leadData.empresa || 'N/A'}` },
                            { type: 'mrkdwn', text: `*Confiança BOT:* ${botConfidence}%` },
                            { type: 'mrkdwn', text: `*Razão:* ${reason}` }
                        ]
                    },
                    { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${msg}\`\`\`` } }
                ]
            });

            await new Promise((resolve, reject) => {
                const req = https.request(
                    { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } },
                    (res) => resolve(res.statusCode)
                );
                req.on('error', reject);
                req.write(payload);
                req.end();
            });

            logger.info('[ESCAPE NOTIFY] Notificação Slack enviada para operador');
        } catch (err) {
            logger.warn(`[ESCAPE NOTIFY] Erro ao enviar Slack: ${err.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────
    // LOG DE AUDITORIA
    // ─────────────────────────────────────────────────────────

    async _logAudit(leadId, canal, resultado, detalhes, botConfidence) {
        try {
            await securitySheets.appendAuditLog({
                leadId,
                acao: `BOT Escape — canal ${canal}`,
                tipoAcao: 'Escape Strategy',
                statusAntes: 'BOT_DETECTADO',
                statusDepois: resultado,
                autorizado: resultado === 'SUCESSO' ? 'Sim' : 'Não',
                motivo: `${detalhes} | Confiança BOT: ${botConfidence}%`,
                usuarioIa: 'SDR_IA_EscapeStrategy_v1.0'
            });
        } catch (err) {
            logger.warn(`[ESCAPE] Erro ao gravar AUDIT_LOG: ${err.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────

    _formatPhone(phone) {
        if (!phone) return null;
        const clean = phone.replace(/\D/g, '');
        if (clean.length < 10) return null;
        if (clean.startsWith('55') && clean.length >= 12) return `+${clean}`;
        if (clean.length === 11) return `+55${clean}`;
        if (clean.length === 10) return `+550${clean}`;
        return `+${clean}`;
    }

    _buildSMSMessage(leadData) {
        const name = leadData.nome || 'olá';
        return `${name}, tudo bem? Tentei entrar em contacto pelo WhatsApp mas recebi resposta automática. Posso falar consigo brevemente? Klaus SDR 🤝`;
    }

    _buildWhatsAppMessage(leadData) {
        const name = leadData.nome || 'olá';
        return `${name} 👋 Tentei contactar pelo outro WhatsApp mas recebi uma resposta automática. Posso falar consigo aqui? Tenho algo relevante para partilhar! 🚀`;
    }

    _buildEscalationMessage(leadId, leadData, botConfidence, reason) {
        return [
            `⚠️ BOT DETECTADO — CONTACTO ALTERNATIVO NECESSÁRIO`,
            `Lead: ${leadData.nome || 'N/A'} | Empresa: ${leadData.empresa || 'N/A'} | ID: ${leadId}`,
            `Confiança BOT: ${botConfidence}% | Razão: ${reason}`,
            ``,
            `Contactos disponíveis:`,
            `  Telefone: ${leadData.telefone || 'N/A'}`,
            `  WhatsApp Alt: ${leadData.whatsapp_alternativo || 'N/A'}`,
            `  Email: ${leadData.email || 'N/A'}`,
            ``,
            `Acções sugeridas:`,
            `  1. Ligar directamente`,
            `  2. Enviar email personalizado`,
            `  3. Registar resultado em BOT_DETECCOES`
        ].join('\n');
    }
}

module.exports = new EscapeStrategy();
