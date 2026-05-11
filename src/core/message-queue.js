/**
 * Message Queue
 * Simple in-memory queue for inter-agent communication
 */

const logger = require('../config/logger');

class MessageQueue {
    constructor() {
        this._queue = [];
    }

    /**
     * Enqueue a message
     * @param {string} from - sender agent
     * @param {string} to - recipient agent
     * @param {string} type - message type
     * @param {Object} payload - message data
     */
    enqueue(from, to, type, payload) {
        const message = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            from,
            to,
            type,
            payload,
            timestamp: new Date().toISOString(),
            read: false
        };
        this._queue.push(message);
        logger.debug(`[MessageQueue] ${from} → ${to}: ${type}`);
        return message.id;
    }

    /**
     * Dequeue next message for a recipient
     * @param {string} recipient
     * @returns {Object|null}
     */
    dequeue(recipient) {
        const idx = this._queue.findIndex(m => m.to === recipient && !m.read);
        if (idx === -1) return null;
        this._queue[idx].read = true;
        return this._queue[idx];
    }

    /**
     * Get all unread messages for a recipient
     * @param {string} recipient
     * @returns {Array<Object>}
     */
    peek(recipient) {
        return this._queue.filter(m => m.to === recipient && !m.read);
    }

    /**
     * Clear read messages from queue
     */
    cleanup() {
        this._queue = this._queue.filter(m => !m.read);
    }
}

module.exports = new MessageQueue();
