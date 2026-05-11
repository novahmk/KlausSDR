'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../config/logger');

const CONTROL_FILE = process.env.SDR_REMOTE_CONTROL_FILE
    ? path.resolve(process.env.SDR_REMOTE_CONTROL_FILE)
    : path.join(__dirname, '..', '..', 'data', 'sdr_remote_control.json');

const DEFAULT_STATE = {
    enabled: true,
    pauseUntil: null,
    lastUpdatedAt: new Date().toISOString(),
    lastPingAt: null,
    lastCallAlerts: {}
};

class SDRRemoteControl {
    constructor() {
        this.state = this._load();
        if (this.state.pauseUntil && new Date(this.state.pauseUntil).getTime() > Date.now()) {
            this._scheduleResumeTimer();
        }
    }

    isEnabled() {
        this._refreshPauseState();
        return !!this.state.enabled;
    }

    setEnabled(enabled) {
        this.state.enabled = !!enabled;
        if (enabled) {
            this.state.pauseUntil = null;
        }
        this.state.lastUpdatedAt = new Date().toISOString();
        this._save();
        return this.state.enabled;
    }

    pauseFor(durationMs, label = '') {
        const ms = Number(durationMs);
        if (!Number.isFinite(ms) || ms <= 0) {
            throw new Error('Duracao invalida para pausa');
        }

        this.state.enabled = false;
        this.state.pauseUntil = new Date(Date.now() + ms).toISOString();
        this.state.lastUpdatedAt = new Date().toISOString();
        this._save();
        this._scheduleResumeTimer();

        return {
            pauseUntil: this.state.pauseUntil,
            label,
            durationMs: ms
        };
    }

    toggle() {
        return this.setEnabled(!this.isEnabled());
    }

    markPing() {
        this.state.lastPingAt = new Date().toISOString();
        this._save();
    }

    getStatus() {
        this._refreshPauseState();
        return {
            enabled: this.isEnabled(),
            pauseUntil: this.state.pauseUntil,
            lastUpdatedAt: this.state.lastUpdatedAt,
            lastPingAt: this.state.lastPingAt,
            adminNumbers: this.getAdminNumbers()
        };
    }

    getAdminNumbers() {
        const raw = process.env.SDR_ADMIN_WHATSAPP_NUMBERS || process.env.SDR_ADMIN_WHATSAPP_NUMBER || '';
        return raw
            .split(',')
            .map(item => this._normalizePhone(item))
            .filter(Boolean);
    }

    isAdmin(from) {
        const normalized = this._normalizePhone(from);
        return this.getAdminNumbers().includes(normalized);
    }

    async handleCommand({ from, body, sendReply, broadcast }) {
        const commandText = String(body || '').trim();
        if (!this.isAdmin(from)) {
            return { handled: false };
        }

        const normalized = this._normalizeCommand(commandText);
        if (!normalized.startsWith('!sdr')) {
            return { handled: false };
        }

        if (normalized === '!sdr ping') {
            this.markPing();
            const reply = this._formatPingReply();
            await sendReply(reply);
            return { handled: true, reply };
        }

        if (normalized === '!sdr on' || normalized === '!sdr ativar' || normalized === '!sdr ligar') {
            this.setEnabled(true);
            const reply = '✅ Sistema SDR ativado. O atendimento automático voltou a responder.';
            await sendReply(reply);
            return { handled: true, reply };
        }

        if (normalized === '!sdr off' || normalized === '!sdr desativar' || normalized === '!sdr desligar') {
            this.setEnabled(false);
            const reply = '⏸️ Sistema SDR desativado. O bot continua recebendo mensagens, mas não responde automaticamente.';
            await sendReply(reply);
            return { handled: true, reply };
        }

        if (normalized === '!sdr status') {
            const reply = this._formatStatusReply();
            await sendReply(reply);
            return { handled: true, reply };
        }

        if (normalized.startsWith('!sdr call ')) {
            const payload = commandText.slice(commandText.toLowerCase().indexOf('!sdr call ') + '!sdr call '.length).trim();
            const message = this._formatManualCallAlert({ from, payload });
            if (typeof broadcast === 'function') {
                await broadcast(message);
            }

            const reply = this._formatCallCommandAck(payload);
            await sendReply(reply);
            return { handled: true, reply };
        }

        if (normalized === '!sdr help' || normalized === '!sdr ajuda') {
            const reply = this._formatHelpReply();
            await sendReply(reply);
            return { handled: true, reply };
        }

        const reply = [
            'Comando nao reconhecido.',
            'Use: !sdr help',
            'Comandos disponiveis: ping, on, off, status, call'
        ].join('\n');
        await sendReply(reply);
        return { handled: true, reply };
    }

    shouldNotifyCall({ text, analysis, lead }) {
        const normalized = this._normalizeText(text);
        const positive = String(analysis && analysis.tipo || '').toLowerCase() === 'resposta_positiva';
        const hasCallIntent = this._matchesAny(normalized, [
            'pode me ligar',
            'pode ligar',
            'me liga',
            'me ligue',
            'ligar',
            'chamada',
            'call',
            'telefone',
            'conversar por telefone',
            'falar por telefone',
            'podemos falar'
        ]);

        return positive || hasCallIntent || this._isLeadRequestingCall(normalized);
    }

    async notifyCallNeeded({ whatsappClient, lead, text, analysis, reason = 'call_required' }) {
        const leadId = this._normalizePhone(lead && (lead.numero || lead.phone || lead.phoneNumber || lead.id));
        if (!leadId) return false;

        const payloadSignature = crypto
            .createHash('sha1')
            .update([leadId, text || '', reason].join('|'))
            .digest('hex');

        const lastSignature = this.state.lastCallAlerts[leadId];
        if (lastSignature === payloadSignature) {
            return false;
        }

        this.state.lastCallAlerts[leadId] = payloadSignature;
        this._save();

        const alert = this._formatCallAlert({ lead, text, analysis, reason });
        await this._broadcast(whatsappClient, alert);
        return true;
    }

    async broadcastAdminMessage(whatsappClient, message) {
        return this._broadcast(whatsappClient, message);
    }

    async notifyAdminPayload(whatsappClient, payload) {
        const admins = this.getAdminNumbers();
        if (!admins.length) {
            logger.warn('[SDR Control] Nenhum admin configurado para receber payloads.');
            return false;
        }

        const normalizedPayload = {
            to: payload?.to || admins[0],
            message: payload?.message || '',
            action: payload?.action || 'LIGAR_AGORA'
        };

        const messageText = [
            normalizedPayload.message,
            '',
            `Action: ${normalizedPayload.action}`,
            `Payload: ${JSON.stringify(normalizedPayload)}`
        ].join('\n');

        for (const admin of admins) {
            try {
                await whatsappClient.sendMessage(`${admin}@c.us`, messageText);
            } catch (err) {
                logger.warn(`[SDR Control] Falha ao notificar payload para ${admin}: ${err.message}`);
            }
        }

        return true;
    }

    _formatPingReply() {
        const status = this.getStatus();
        return [
            '🏓 Pong! Sistema online.',
            `Estado: ${status.enabled ? 'ATIVO' : 'PAUSADO'}`,
            `Atualizado em: ${status.lastUpdatedAt}`,
            `Admins: ${status.adminNumbers.length ? status.adminNumbers.join(', ') : 'nao configurados'}`
        ].join('\n');
    }

    _formatStatusReply() {
        const status = this.getStatus();
        return [
            '📡 Status do SDR',
            `Automacao: ${status.enabled ? 'ATIVA' : 'DESATIVADA'}`,
            `Ultima atualizacao: ${status.lastUpdatedAt}`,
            `Pausa ate: ${status.pauseUntil || 'nenhuma'}`,
            `Ultimo ping: ${status.lastPingAt || 'nunca'}`,
            `Admins: ${status.adminNumbers.length ? status.adminNumbers.join(', ') : 'nao configurados'}`
        ].join('\n');
    }

    _formatHelpReply() {
        return [
            'Comandos disponiveis:',
            '!sdr ping - verifica se o sistema esta online',
            '!sdr on | !sdr ativar | !sdr ligar - ativa a automacao',
            '!sdr off | !sdr desativar | !sdr desligar - desativa a automacao',
            '!sdr pause 2h | !sdr pause 30m | !sdr pause 1h30m - pausa temporariamente',
            '!sdr resume | !sdr retomar | !sdr voltar - reativa a automacao',
            '!sdr status - mostra o estado atual',
            '!sdr call <motivo> - envia alerta de ligacao/manual follow-up',
            '!sdr help | !sdr ajuda - mostra esta ajuda'
        ].join('\n');
    }

    _formatCallCommandAck(payload) {
        return [
            '📞 Alerta de ligacao registrado.',
            payload ? `Motivo: ${payload}` : 'Motivo: nao informado',
            'O sistema vai notificar os admins configurados.'
        ].join('\n');
    }

    _formatManualCallAlert({ from, payload }) {
        return [
            '📞 ALERTA MANUAL DE LIGACAO',
            `Solicitado por: ${this._normalizePhone(from) || from}`,
            payload ? `Motivo: ${payload}` : 'Motivo: nao informado',
            `Hora: ${new Date().toISOString()}`
        ].join('\n');
    }

    _formatCallAlert({ lead, text, analysis, reason }) {
        const leadName = lead && (lead.nome || lead.leadNome || lead.nome_lead) || 'Lead';
        const leadNumber = lead && (lead.numero || lead.phone || lead.phoneNumber) || 'desconhecido';
        const objecao = analysis && analysis.objecao ? analysis.objecao : 'nenhuma';
        const score = analysis && analysis.sentimento ? analysis.sentimento : 'n/a';

        return [
            '🚨 ALERTA DE LIGACAO NECESSARIA',
            `Lead: ${leadName}`,
            `Numero: ${leadNumber}`,
            `Motivo: ${reason}`,
            `Sentimento: ${score}`,
            `Objeção: ${objecao}`,
            text ? `Ultima mensagem: ${text.slice(0, 240)}` : ''
        ].filter(Boolean).join('\n');
    }

    async _broadcast(whatsappClient, message) {
        const admins = this.getAdminNumbers();
        if (!admins.length) {
            logger.warn('[SDR Control] Nenhum admin configurado para receber notificacoes.');
            return false;
        }

        for (const admin of admins) {
            try {
                await whatsappClient.sendMessage(`${admin}@c.us`, message);
            } catch (err) {
                logger.warn(`[SDR Control] Falha ao notificar ${admin}: ${err.message}`);
            }
        }

        return true;
    }

    _load() {
        try {
            if (!fs.existsSync(CONTROL_FILE)) {
                return { ...DEFAULT_STATE };
            }

            const data = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
            return {
                ...DEFAULT_STATE,
                ...data,
                lastCallAlerts: data.lastCallAlerts || {}
            };
        } catch (err) {
            logger.warn(`[SDR Control] Falha ao carregar estado: ${err.message}`);
            return { ...DEFAULT_STATE };
        }
    }

    _save() {
        try {
            const dir = path.dirname(CONTROL_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(CONTROL_FILE, JSON.stringify(this.state, null, 2), 'utf8');
        } catch (err) {
            logger.warn(`[SDR Control] Falha ao salvar estado: ${err.message}`);
        }
    }

    _normalizePhone(value) {
        return String(value || '').replace(/\D/g, '');
    }

    _normalizeCommand(value) {
        return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    }

    _normalizeText(value) {
        return String(value || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _matchesAny(text, phrases) {
        return phrases.some(phrase => text.includes(this._normalizeText(phrase)));
    }

    _isLeadRequestingCall(text) {
        return this._matchesAny(text, [
            'pode me ligar',
            'me liga',
            'me ligue',
            'podemos falar por telefone',
            'pode telefonar',
            'gostaria de falar por telefone',
            'vamos falar por telefone',
            'quero uma ligação',
            'quero uma ligacao'
        ]);
    }

    _parseDurationText(value) {
        const text = this._normalizeText(value);
        if (!text) return null;

        const compactMatch = text.match(/^(\d+)h(?:(\d+)m?)?$/);
        const hoursOnlyMatch = text.match(/^(\d+)\s*(?:h|hora|horas)$/);
        const minutesOnlyMatch = text.match(/^(\d+)\s*(?:m|min|minuto|minutos)$/);
        const humanMatch = text.match(/^(?:(\d+)\s*h(?:oras?)?)?\s*(?:(\d+)\s*m(?:in(?:utos?)?)?)?$/);

        let hours = 0;
        let minutes = 0;

        if (compactMatch) {
            hours = Number(compactMatch[1] || 0);
            minutes = Number(compactMatch[2] || 0);
        } else if (hoursOnlyMatch) {
            hours = Number(hoursOnlyMatch[1] || 0);
        } else if (minutesOnlyMatch) {
            minutes = Number(minutesOnlyMatch[1] || 0);
        } else if (humanMatch && (humanMatch[1] || humanMatch[2])) {
            hours = Number(humanMatch[1] || 0);
            minutes = Number(humanMatch[2] || 0);
        } else {
            return null;
        }

        const totalMs = (hours * 60 * 60 * 1000) + (minutes * 60 * 1000);
        if (!Number.isFinite(totalMs) || totalMs <= 0) return null;

        const labelParts = [];
        if (hours > 0) labelParts.push(`${hours}h`);
        if (minutes > 0) labelParts.push(`${minutes}m`);

        return {
            ms: totalMs,
            humanLabel: labelParts.length ? labelParts.join(' ') : `${Math.round(totalMs / 60000)}m`
        };
    }

    _refreshPauseState() {
        if (!this.state.pauseUntil) return;

        const resumeAt = new Date(this.state.pauseUntil).getTime();
        if (!Number.isFinite(resumeAt)) {
            this.state.pauseUntil = null;
            this.state.enabled = true;
            this._save();
            return;
        }

        if (Date.now() >= resumeAt) {
            this.state.enabled = true;
            this.state.pauseUntil = null;
            this.state.lastUpdatedAt = new Date().toISOString();
            this._save();
            logger.info('[SDR Control] Pausa expirada. Sistema reativado automaticamente.');
        }
    }

    _scheduleResumeTimer() {
        if (this._resumeTimer) {
            clearTimeout(this._resumeTimer);
            this._resumeTimer = null;
        }

        if (!this.state.pauseUntil) return;

        const resumeAt = new Date(this.state.pauseUntil).getTime();
        const delay = resumeAt - Date.now();
        if (!Number.isFinite(delay) || delay <= 0) {
            this._refreshPauseState();
            return;
        }

        this._resumeTimer = setTimeout(() => {
            this._resumeTimer = null;
            this._refreshPauseState();
        }, delay);

        if (typeof this._resumeTimer.unref === 'function') {
            this._resumeTimer.unref();
        }
    }
}

module.exports = new SDRRemoteControl();
