'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const analysisLog = require('../sheets/analysis-log');

const PLAYBOOK_FILE = path.join(__dirname, '..', '..', 'data', 'sdr_playbooks.json');

const SIMILARITY_THRESHOLD = 0.58;
const STRICT_MATCH_THRESHOLD = 0.82;
const SUCCESS_RATE_MIN = 0.70;
const MAX_PLAYBOOKS = 200;
const SAVE_DEBOUNCE_MS = 5000;

const dataDir = path.dirname(PLAYBOOK_FILE);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

class SDRLearning {
    constructor() {
        this._playbooks = this._load();
        this._dirty = false;
        this._saveTimer = null;

        this._registerShutdownHooks();
    }

    /**
     * Registra interacao bem-sucedida e reforca o padrao.
     *
     * @param {Object} opts
     * @param {string} opts.telefone
     * @param {string} opts.mensagemEnviada
     * @param {string} opts.objecao
     * @param {string} opts.fase
     * @param {string} opts.resposta
     */
    registrarSucesso({ telefone, mensagemEnviada, objecao, fase, resposta }) {
        const faseSafe = this._sanitizeText(fase, 80) || 'indefinida';
        const objecaoSafe = this._sanitizeText(objecao, 80);
        const mensagem = this._sanitizeText(mensagemEnviada, 800);

        if (!mensagem) {
            logger.warn('[SDRLearning] Ignorado sucesso sem mensagemEnviada valida');
            return;
        }

        const now = new Date().toISOString();
        const existing = this._findBestMatch(mensagem, faseSafe, objecaoSafe, STRICT_MATCH_THRESHOLD);

        if (existing) {
            existing.successCount = (existing.successCount || 0) + 1;
            existing.usageCount = (existing.usageCount || 0) + 1;
            existing.successRate = this._computeSuccessRate(existing);
            existing.lastSuccessAt = now;
            existing.lastUsedAt = now;
            existing.lastResponse = this._sanitizeText(resposta, 200);
            logger.info(`[SDRLearning] Sucesso acumulado em playbook existente (${existing.id})`);
        } else {
            const created = {
                id: `pb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                pattern: this._normalizar(mensagem),
                raw: this._extractRawMessage(mensagem),
                fase: faseSafe,
                objecao: objecaoSafe || '',
                successRate: 1,
                successCount: 1,
                usageCount: 1,
                createdAt: now,
                lastSuccessAt: now,
                lastUsedAt: now,
                lastResponse: this._sanitizeText(resposta, 200)
            };

            this._playbooks.push(created);
            this._prunePlaybooks();
            logger.info(`[SDRLearning] Novo playbook criado (${created.id})`);
        }

        this._dirty = true;
        this._scheduleSave();
        this._audit('sdr_learning_success', {
            telefone,
            fase: faseSafe,
            objecao: objecaoSafe,
            mensagem: mensagem.slice(0, 200)
        });
    }

    /**
     * Registra falha para o padrao mais proximo.
     *
     * @param {string} mensagemEnviada
     * @param {string} fase
     * @param {string} objecao
     */
    registrarFalha(mensagemEnviada, fase, objecao) {
        const faseSafe = this._sanitizeText(fase, 80) || 'indefinida';
        const objecaoSafe = this._sanitizeText(objecao, 80);
        const mensagem = this._sanitizeText(mensagemEnviada, 800);

        if (!mensagem) return;

        const existing = this._findBestMatch(mensagem, faseSafe, objecaoSafe, STRICT_MATCH_THRESHOLD);
        if (!existing) return;

        existing.usageCount = (existing.usageCount || 0) + 1;
        existing.successRate = this._computeSuccessRate(existing);
        existing.lastFailureAt = new Date().toISOString();

        this._dirty = true;
        this._scheduleSave();
        this._audit('sdr_learning_failure', {
            fase: faseSafe,
            objecao: objecaoSafe,
            playbookId: existing.id
        });
    }

    /**
     * Busca playbook confiavel para contexto atual.
     *
     * @param {string} contexto
     * @param {string} fase
     * @param {string} objecao
     * @returns {{ mensagem: string, score: number, playbookId: string } | null}
     */
    buscarPlaybook(contexto, fase, objecao) {
        const faseSafe = this._sanitizeText(fase, 80) || 'indefinida';
        const objecaoSafe = this._sanitizeText(objecao, 80);
        const ctx = this._sanitizeText(contexto, 1200);
        if (!ctx) return null;

        const candidatos = this._playbooks.filter(pb => {
            if ((pb.successRate || 0) < SUCCESS_RATE_MIN) return false;
            if ((pb.usageCount || 0) < 2) return false;
            if (pb.fase !== faseSafe) return false;
            if (objecaoSafe && pb.objecao && pb.objecao !== objecaoSafe) return false;
            return true;
        });

        if (candidatos.length === 0) return null;

        const normalCtx = this._normalizar(ctx);
        let melhor = null;
        let melhorScore = 0;

        for (const pb of candidatos) {
            const score = this._similaridade(normalCtx, pb.pattern);
            if (score > melhorScore) {
                melhor = pb;
                melhorScore = score;
            }
        }

        if (!melhor || melhorScore < SIMILARITY_THRESHOLD) {
            return null;
        }

        melhor.lastUsedAt = new Date().toISOString();
        this._dirty = true;
        this._scheduleSave();

        logger.info(`[SDRLearning] Playbook reutilizado (${melhor.id}) score=${melhorScore.toFixed(2)} taxa=${(melhor.successRate * 100).toFixed(0)}%`);

        return {
            mensagem: melhor.raw,
            score: melhorScore,
            playbookId: melhor.id
        };
    }

    /**
     * Retorna os melhores playbooks por score combinado.
     * @param {number} n
     */
    getTop(n = 10) {
        const topN = Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
        return [...this._playbooks]
            .sort((a, b) => this._qualityScore(b) - this._qualityScore(a))
            .slice(0, topN);
    }

    _registerShutdownHooks() {
        if (SDRLearning._hooksRegistered) return;

        const flushAndExit = (code) => {
            try {
                this._flushSync();
            } finally {
                process.exit(code);
            }
        };

        process.on('exit', () => this._flushSync());
        process.on('SIGINT', () => flushAndExit(0));
        process.on('SIGTERM', () => flushAndExit(0));

        SDRLearning._hooksRegistered = true;
    }

    _findBestMatch(mensagem, fase, objecao, minScore) {
        const pattern = this._normalizar(mensagem);
        let melhor = null;
        let melhorScore = 0;

        for (const pb of this._playbooks) {
            if (pb.fase !== fase) continue;
            if (objecao && pb.objecao && pb.objecao !== objecao) continue;

            const score = this._similaridade(pattern, pb.pattern || '');
            if (score > melhorScore) {
                melhor = pb;
                melhorScore = score;
            }
        }

        if (!melhor || melhorScore < minScore) {
            return null;
        }

        return melhor;
    }

    _normalizar(text) {
        return (text || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _similaridade(a, b) {
        if (!a || !b) return 0;

        const tokenScore = this._tokenDice(a, b);
        const trigramScore = this._trigramJaccard(a, b);

        return (tokenScore * 0.7) + (trigramScore * 0.3);
    }

    _tokenDice(a, b) {
        const setA = new Set(a.split(' ').filter(w => w.length >= 3));
        const setB = new Set(b.split(' ').filter(w => w.length >= 3));

        if (setA.size === 0 || setB.size === 0) return 0;

        let common = 0;
        for (const token of setA) {
            if (setB.has(token)) common += 1;
        }

        return (2 * common) / (setA.size + setB.size);
    }

    _trigramJaccard(a, b) {
        const gramsA = this._ngrams(a, 3);
        const gramsB = this._ngrams(b, 3);

        if (gramsA.size === 0 || gramsB.size === 0) return 0;

        let intersection = 0;
        for (const gram of gramsA) {
            if (gramsB.has(gram)) intersection += 1;
        }

        const union = gramsA.size + gramsB.size - intersection;
        return union === 0 ? 0 : (intersection / union);
    }

    _ngrams(text, n) {
        const compact = (text || '').replace(/\s+/g, ' ');
        const result = new Set();

        if (compact.length < n) return result;
        for (let i = 0; i <= compact.length - n; i += 1) {
            result.add(compact.slice(i, i + n));
        }

        return result;
    }

    _scheduleSave() {
        if (this._saveTimer) return;

        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._flushSync();
        }, SAVE_DEBOUNCE_MS);

        if (typeof this._saveTimer.unref === 'function') {
            this._saveTimer.unref();
        }
    }

    _load() {
        try {
            if (!fs.existsSync(PLAYBOOK_FILE)) {
                return [];
            }

            const parsed = JSON.parse(fs.readFileSync(PLAYBOOK_FILE, 'utf8'));
            if (!Array.isArray(parsed)) {
                logger.warn('[SDRLearning] Arquivo de playbooks invalido (nao-array). Reiniciando.');
                return [];
            }

            const sanitized = parsed
                .map((pb) => this._sanitizePlaybook(pb))
                .filter(Boolean);

            if (sanitized.length !== parsed.length) {
                logger.warn('[SDRLearning] Alguns playbooks invalidos foram descartados no load.');
            }

            return sanitized;
        } catch (err) {
            logger.warn(`[SDRLearning] Erro ao carregar playbooks: ${err.message}`);
            return [];
        }
    }

    _flushSync() {
        if (!this._dirty) return;

        try {
            const tmpFile = `${PLAYBOOK_FILE}.tmp`;
            const body = JSON.stringify(this._playbooks, null, 2);
            fs.writeFileSync(tmpFile, body, 'utf8');
            fs.renameSync(tmpFile, PLAYBOOK_FILE);
            this._dirty = false;
        } catch (err) {
            logger.error(`[SDRLearning] Erro ao salvar playbooks: ${err.message}`);
        }
    }

    _sanitizePlaybook(pb) {
        if (!pb || typeof pb !== 'object') return null;

        const pattern = this._normalizar(pb.pattern || pb.raw || '');
        const raw = this._extractRawMessage(pb.raw || pb.pattern || '');
        const fase = this._sanitizeText(pb.fase, 80) || 'indefinida';

        if (!pattern || !raw) return null;

        const successCount = this._safeInt(pb.successCount, 0);
        const usageCount = this._safeInt(pb.usageCount, 0);
        const fixedUsage = Math.max(usageCount, successCount);

        const sanitized = {
            id: this._sanitizeText(pb.id, 80) || `pb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            pattern,
            raw,
            fase,
            objecao: this._sanitizeText(pb.objecao, 80) || '',
            successCount,
            usageCount: fixedUsage,
            successRate: 0,
            createdAt: this._safeDate(pb.createdAt),
            lastUsedAt: this._safeDate(pb.lastUsedAt || pb.lastSuccessAt),
            lastSuccessAt: this._safeDate(pb.lastSuccessAt || pb.lastSuccess),
            lastFailureAt: this._safeDate(pb.lastFailureAt),
            lastResponse: this._sanitizeText(pb.lastResponse, 200)
        };

        sanitized.successRate = this._computeSuccessRate(sanitized);
        return sanitized;
    }

    _prunePlaybooks() {
        if (this._playbooks.length <= MAX_PLAYBOOKS) return;

        this._playbooks.sort((a, b) => this._qualityScore(a) - this._qualityScore(b));
        this._playbooks.splice(0, this._playbooks.length - MAX_PLAYBOOKS);
    }

    _qualityScore(pb) {
        const usage = Math.max(1, this._safeInt(pb.usageCount, 1));
        const rate = Math.max(0, Math.min(1, Number(pb.successRate) || 0));
        return rate * Math.log2(usage + 1);
    }

    _computeSuccessRate(pb) {
        const usage = this._safeInt(pb.usageCount, 0);
        const success = this._safeInt(pb.successCount, 0);
        if (usage <= 0) return 0;
        return success / usage;
    }

    _extractRawMessage(text) {
        return this._sanitizeText(text, 300);
    }

    _sanitizeText(value, maxLen) {
        if (value === null || value === undefined) return '';
        const normalized = String(value).replace(/\s+/g, ' ').trim();
        if (!normalized) return '';
        if (maxLen && normalized.length > maxLen) {
            return normalized.slice(0, maxLen);
        }
        return normalized;
    }

    _safeDate(value) {
        if (!value) return new Date().toISOString();
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return new Date().toISOString();
        return d.toISOString();
    }

    _safeInt(value, fallback) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
            return fallback;
        }
        return parsed;
    }

    _audit(type, payload) {
        Promise.resolve()
            .then(() => analysisLog.log({
                type,
                agent: 'SDRLearning',
                subject: 'Playbook update',
                discoveries: JSON.stringify(payload),
                confidence: 85,
                reference: 'sdr_playbooks'
            }))
            .catch((err) => {
                logger.warn(`[SDRLearning] Falha no log de auditoria: ${err.message}`);
            });
    }
}

SDRLearning._hooksRegistered = false;

module.exports = new SDRLearning();
