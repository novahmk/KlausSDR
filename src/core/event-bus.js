/* DEPRECATED — Não utilizado no fluxo SDR ativo.
 * Este arquivo foi parte do ciclo multi-agente Manager/Attendant (código-gerador).
 * O fluxo SDR atual utiliza: sdr-whatsapp.js → sdr-state-machine.js → openai/sdr-engine.js
 * Mantido apenas para referência histórica. Não instanciar em produção.
 */

/**
 * Event Bus
 * Publish/subscribe event system for agent coordination
 */

const logger = require('../config/logger');

class EventBus {
    constructor() {
        this._listeners = {};
        this._history = [];
    }

    /**
     * Subscribe to an event
     * @param {string} event - event name
     * @param {string} listenerId - unique listener ID
     * @param {Function} handler - async handler(payload)
     */
    on(event, listenerId, handler) {
        if (!this._listeners[event]) this._listeners[event] = {};
        this._listeners[event][listenerId] = handler;
        logger.debug(`[EventBus] ${listenerId} subscribed to "${event}"`);
    }

    /**
     * Unsubscribe from an event
     * @param {string} event
     * @param {string} listenerId
     */
    off(event, listenerId) {
        if (this._listeners[event]) {
            delete this._listeners[event][listenerId];
        }
    }

    /**
     * Emit an event to all subscribers
     * @param {string} event - event name
     * @param {Object} payload - event data
     */
    async emit(event, payload = {}) {
        logger.debug(`[EventBus] Emitting: ${event}`);

        this._history.push({
            event,
            payload,
            timestamp: new Date().toISOString()
        });

        const listeners = this._listeners[event] || {};
        const handlers = Object.values(listeners);

        if (!handlers.length) {
            logger.debug(`[EventBus] No listeners for "${event}"`);
            return;
        }

        await Promise.all(handlers.map(h => h(payload).catch(err =>
            logger.error(`[EventBus] Handler error on "${event}":`, err)
        )));
    }

    /**
     * Get event history
     * @param {number} limit
     * @returns {Array}
     */
    getHistory(limit = 20) {
        return this._history.slice(-limit);
    }
}

module.exports = new EventBus();
