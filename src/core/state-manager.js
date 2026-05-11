/**
 * State Manager
 * Centralized runtime state for the multi-agent system
 */

const logger = require('../config/logger');

class StateManager {
    constructor() {
        this._state = {
            isRunning: false,
            currentCycle: 0,
            lastCycleAt: null,
            lastAnalysis: null,
            currentTask: null,
            errors: []
        };
    }

    /**
     * Get current state snapshot
     * @returns {Object}
     */
    get() {
        return { ...this._state };
    }

    /**
     * Set a specific key in state
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
        this._state[key] = value;
        logger.debug(`[StateManager] ${key} = ${JSON.stringify(value)}`);
    }

    /**
     * Record cycle start
     */
    startCycle() {
        this._state.currentCycle++;
        this._state.isRunning = true;
        this._state.lastCycleAt = new Date().toISOString();
        logger.info(`[StateManager] Cycle #${this._state.currentCycle} started`);
    }

    /**
     * Record cycle completion
     * @param {boolean} success
     */
    endCycle(success = true) {
        this._state.isRunning = false;
        logger.info(
            `[StateManager] Cycle #${this._state.currentCycle} ${success ? 'completed' : 'failed'}`
        );
    }

    /**
     * Record an error
     * @param {Error} error
     */
    recordError(error) {
        this._state.errors.push({
            message: error.message,
            timestamp: new Date().toISOString()
        });
        // Keep only last 20 errors
        if (this._state.errors.length > 20) {
            this._state.errors = this._state.errors.slice(-20);
        }
    }

    /**
     * Check if system is healthy
     * @returns {boolean}
     */
    isHealthy() {
        const recentErrors = this._state.errors.filter(e => {
            const age = Date.now() - new Date(e.timestamp).getTime();
            return age < 60 * 60 * 1000; // last 1 hour
        });
        return recentErrors.length < 3;
    }
}

module.exports = new StateManager();
