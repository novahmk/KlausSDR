'use strict';

/**
 * CONTEXT CACHE
 * Cache inteligente com TTL (Time To Live) para contextos de leads.
 * Reduz chamadas ao Google Sheets em ~80%.
 * TTL padrão: 10 minutos.
 */

class ContextCache {
    constructor(ttl = 600_000) {
        this._cache = new Map();
        this._ttl = ttl;
        this._stats = { hits: 0, misses: 0, sets: 0 };
    }

    /**
     * Obter contexto do cache.
     * @param {string} leadId
     * @returns {any|null} dados ou null se expirado/ausente
     */
    get(leadId) {
        const entry = this._cache.get(leadId);
        if (!entry) {
            this._stats.misses++;
            return null;
        }
        if (Date.now() - entry.timestamp > this._ttl) {
            this._cache.delete(leadId);
            this._stats.misses++;
            return null;
        }
        this._stats.hits++;
        return entry.data;
    }

    /**
     * Armazenar contexto no cache.
     * @param {string} leadId
     * @param {any} data
     */
    set(leadId, data) {
        this._cache.set(leadId, { data, timestamp: Date.now() });
        this._stats.sets++;
    }

    /**
     * Invalidar cache de um lead específico.
     * @param {string} leadId
     */
    invalidate(leadId) {
        this._cache.delete(leadId);
    }

    /**
     * Limpar todo o cache e zerar estatísticas.
     */
    clearAll() {
        this._cache.clear();
        this._stats = { hits: 0, misses: 0, sets: 0 };
    }

    /**
     * Retorna estatísticas de hit/miss.
     * @returns {object}
     */
    getStats() {
        const total = this._stats.hits + this._stats.misses;
        const hitRate = total > 0 ? ((this._stats.hits / total) * 100).toFixed(2) : '0.00';
        return { ...this._stats, hitRate: `${hitRate}%`, cacheSize: this._cache.size };
    }

    /**
     * Alterar TTL em runtime (ms).
     * @param {number} ttl
     */
    setTTL(ttl) {
        this._ttl = ttl;
    }
}

module.exports = new ContextCache();
