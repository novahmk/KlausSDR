'use strict';

const logger = require('../config/logger');
const env = require('../config/env');
const sdrStateMachine = require('./sdr-state-machine');
const remoteControl = require('./sdr-remote-control');

class SDRScheduler {
    constructor() {
        this._timer = null;
        this._running = false;
        this._whatsappClient = null;
    }

    start({ whatsappClient } = {}) {
        this._whatsappClient = whatsappClient || this._whatsappClient;
        if (this._running) return;
        this._running = true;
        this._scheduleNextRun(true);
        logger.info('[SDR Scheduler] Agendador de follow-up iniciado.');
    }

    stop() {
        this._running = false;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        logger.info('[SDR Scheduler] Agendador de follow-up parado.');
    }

    async runNow() {
        if (!this._whatsappClient) {
            logger.warn('[SDR Scheduler] WhatsApp client nao configurado; pulando execucao.');
            return [];
        }

        if (env.SDR_REMOTE_CONTROL_ENABLED === false || !remoteControl.isEnabled()) {
            logger.info('[SDR Scheduler] Controle remoto desativado por env.');
            return [];
        }

        const results = await sdrStateMachine.runFollowUpScan({ whatsappClient: this._whatsappClient });
        logger.info(`[SDR Scheduler] Scan concluido. ${results.length} evento(s) processado(s).`);
        return results;
    }

    _scheduleNextRun(runImmediately = false) {
        if (!this._running) return;

        if (runImmediately) {
            setImmediate(() => this._runAndReschedule());
            return;
        }

        const delay = this._getDelayUntilNextRun();
        this._timer = setTimeout(() => this._runAndReschedule(), delay);
        if (typeof this._timer.unref === 'function') this._timer.unref();
    }

    async _runAndReschedule() {
        if (!this._running) return;

        try {
            await this.runNow();
        } catch (err) {
            logger.error(`[SDR Scheduler] Falha no job de follow-up: ${err.message}`);
        } finally {
            this._scheduleNextRun(false);
        }
    }

    _getDelayUntilNextRun() {
        const hour = Number.parseInt(process.env.SDR_DAILY_FOLLOWUP_HOUR || '9', 10);
        const minute = Number.parseInt(process.env.SDR_DAILY_FOLLOWUP_MINUTE || '0', 10);
        const now = new Date();
        const next = new Date(now);
        next.setHours(hour, minute, 0, 0);

        if (next.getTime() <= now.getTime()) {
            next.setDate(next.getDate() + 1);
        }

        return next.getTime() - now.getTime();
    }
}

module.exports = new SDRScheduler();
