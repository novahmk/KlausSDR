'use strict';

/**
 * SESSION MANAGER
 * Centraliza o isolamento de sessões do WhatsApp SDR.
 *
 * O mecanismo primário já existia em sdr-whatsapp.js via SYSTEM_ACTIVATION
 * (timestamp do evento 'ready'). Este módulo encapsula e expande essa lógica,
 * tornando-a testável e reutilizável por outros módulos.
 *
 * Fluxo:
 *   1. Evento 'qr'    → prepara nova sessão (pendente)
 *   2. Evento 'ready' → ativa sessão com timestamp definitivo
 *   3. Cada mensagem  → isMessageFromCurrentSession() descarta as antigas
 */

const crypto = require('crypto');
const logger = require('../config/logger');

class SessionManager {
    constructor() {
        this._session = null;
        this._history = [];
    }

    // ── Ciclo de vida da sessão ──────────────────────────────────────────────

    /**
     * Deve ser chamado no evento 'qr' do WhatsApp client.
     * Invalida sessão anterior e cria uma nova (ainda pendente de autenticação).
     */
    onQRGenerated() {
        if (this._session && this._session.status === 'ACTIVE') {
            this._invalidate('nova sessão QR iniciada');
        }

        const sessionId = `sess_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        this._session = {
            id: sessionId,
            status: 'PENDING',
            createdAt: Date.now(),
            activatedAt: null,
            messageCount: 0,
            leads: new Set()
        };

        logger.info(`[SESSION] Nova sessão iniciada (pendente): ${sessionId}`);
        return sessionId;
    }

    /**
     * Deve ser chamado no evento 'ready' do WhatsApp client.
     * Ativa a sessão e registra o timestamp de ativação (equivalente ao SYSTEM_ACTIVATION).
     * @returns {number} timestamp de ativação (ms)
     */
    onReady() {
        if (!this._session) this.onQRGenerated();

        this._session.status = 'ACTIVE';
        this._session.activatedAt = Date.now();
        this._history.push({ ...this._session, leads: Array.from(this._session.leads) });

        logger.info(`[SESSION] Sessão ativada: ${this._session.id} em ${new Date(this._session.activatedAt).toISOString()}`);
        return this._session.activatedAt;
    }

    // ── Validação de mensagens ───────────────────────────────────────────────

    /**
     * Verifica se uma mensagem pertence à sessão atual.
     * Rejeita mensagens anteriores ao timestamp de ativação.
     *
     * @param {number} msgTimestampMs - timestamp da mensagem em ms
     * @returns {boolean}
     */
    isMessageFromCurrentSession(msgTimestampMs) {
        if (!this._session || this._session.status !== 'ACTIVE') return false;
        return msgTimestampMs >= this._session.activatedAt - 1000;
    }

    // ── Registro de leads ────────────────────────────────────────────────────

    /** Registra que um lead foi abordado nesta sessão. */
    registerLead(leadId) {
        if (this._session) this._session.leads.add(String(leadId));
    }

    /** Incrementa o contador de mensagens processadas nesta sessão. */
    incrementMessageCount() {
        if (this._session) this._session.messageCount++;
    }

    // ── Leitura de estado ────────────────────────────────────────────────────

    getCurrentSession() {
        return this._session ? { ...this._session, leads: Array.from(this._session.leads) } : null;
    }

    getSessionHistory() {
        return this._history;
    }

    /** Timestamp de ativação da sessão atual (equivalente ao SYSTEM_ACTIVATION legado). */
    getActivationTimestamp() {
        return this._session && this._session.activatedAt ? this._session.activatedAt : 0;
    }

    getStats() {
        if (!this._session) return null;
        const uptimeMs = this._session.activatedAt ? Date.now() - this._session.activatedAt : 0;
        const h = Math.floor(uptimeMs / 3_600_000);
        const m = Math.floor((uptimeMs % 3_600_000) / 60_000);
        return {
            sessionId: this._session.id,
            status: this._session.status,
            activatedAt: this._session.activatedAt ? new Date(this._session.activatedAt).toISOString() : null,
            messageCount: this._session.messageCount,
            leadsRegistered: this._session.leads.size,
            uptime: `${h}h ${m}m`
        };
    }

    // ── Interno ──────────────────────────────────────────────────────────────

    _invalidate(reason) {
        if (!this._session) return;
        logger.info(`[SESSION] Encerrando sessão ${this._session.id}: ${reason}`);
        this._session.status = 'INVALIDATED';
        this._session.invalidatedAt = Date.now();
    }

    /** Reseta estado completo (usado em testes). */
    clear() {
        this._session = null;
        this._history = [];
    }
}

module.exports = new SessionManager();
