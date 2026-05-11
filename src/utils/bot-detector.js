/**
 * BOT DETECTOR MODULE
 * Detecção avançada de BOTs com score de confiança (0-100)
 *
 * 6 SINAIS ANALISADOS:
 * 1. Tempo de resposta fixo (padrão estatístico)
 * 2. Mesma mensagem repetida no histórico do lead
 * 3. Apenas URLs sem contexto
 * 4. Resposta muito rápida (<5 segundos)
 * 5. Palavras-chave de automação ("resposta automática", "I'm a bot", etc.)
 * 6. Padrão de hora fixa de resposta
 */

const logger = require('../config/logger');
const { crmSheets, CRM_TABS } = require('../sheets/crm-sheets');

class BotDetector {
    constructor() {
        // Cache em memória para acelerar análises repetidas
        this.responseTimings = new Map(); // leadId -> [{ ts: Number, seconds: Number }]
        this.messageCache   = new Map();  // leadId -> [String]
    }

    // ─────────────────────────────────────────────────────────
    // MÉTODO PRINCIPAL
    // ─────────────────────────────────────────────────────────

    /**
     * Analisa uma mensagem recebida e retorna score de confiança de BOT.
     *
     * @param {Object} params
     * @param {string}   params.message                  - texto da mensagem
     * @param {string}   params.leadId                   - ID do lead
     * @param {number|null} params.responseTime          - segundos desde última mensagem enviada
     * @param {string[]} [params.previousMessages]       - histórico de mensagens recebidas
     * @param {number[]} [params.previousResponseTimes]  - histórico de segundos de resposta
     *
     * @returns {Promise<Object>}
     *   { confidence, isBot, signals, recommendation, timestamp, leadId }
     */
    async analyze(params) {
        const {
            message,
            leadId,
            responseTime = null,
            previousMessages = [],
            previousResponseTimes = []
        } = params;

        if (!message || typeof message !== 'string') {
            return this._emptyResponse(leadId);
        }

        let confidenceScore = 0;
        const detectedSignals = [];

        // Signal 1: Tempo de resposta fixo? (+40 pontos)
        const timingSignal = this._analyzeTimingPattern(leadId, responseTime, previousResponseTimes);
        if (timingSignal.detected) {
            confidenceScore += timingSignal.score;
            detectedSignals.push({ type: 'FIXED_TIMING', score: timingSignal.score, details: timingSignal.details });
        }

        // Signal 2: Mensagem duplicada no histórico? (+50 pontos)
        const duplicateSignal = this._analyzeMessageDuplicate(leadId, message, previousMessages);
        if (duplicateSignal.detected) {
            confidenceScore += duplicateSignal.score;
            detectedSignals.push({ type: 'DUPLICATE_MESSAGE', score: duplicateSignal.score, details: duplicateSignal.details });
        }

        // Signal 3: Apenas URLs sem contexto? (+30 pontos)
        const urlSignal = this._analyzeURLOnly(message);
        if (urlSignal.detected) {
            confidenceScore += urlSignal.score;
            detectedSignals.push({ type: 'URL_ONLY', score: urlSignal.score, details: urlSignal.details });
        }

        // Signal 4: Resposta muito rápida (<5 segundos)? (+25 pontos)
        const speedSignal = this._analyzeResponseSpeed(responseTime);
        if (speedSignal.detected) {
            confidenceScore += speedSignal.score;
            detectedSignals.push({ type: 'VERY_FAST_RESPONSE', score: speedSignal.score, details: speedSignal.details });
        }

        // Signal 5: Palavras-chave de automação? (+60 pontos)
        const keywordSignal = this._analyzeAutomationKeywords(message);
        if (keywordSignal.detected) {
            confidenceScore += keywordSignal.score;
            detectedSignals.push({ type: 'AUTOMATION_KEYWORDS', score: keywordSignal.score, details: keywordSignal.details });
        }

        // Signal 6: Hora fixa de resposta? (+35 pontos)
        const hourSignal = this._analyzeHourPattern(leadId, previousResponseTimes);
        if (hourSignal.detected) {
            confidenceScore += hourSignal.score;
            detectedSignals.push({ type: 'FIXED_HOUR_PATTERN', score: hourSignal.score, details: hourSignal.details });
        }

        confidenceScore = Math.min(100, confidenceScore);

        let recommendation = 'CONTINUE';
        if (confidenceScore > 85)       recommendation = 'ESCAPE';
        else if (confidenceScore >= 60) recommendation = 'MANUAL_REVIEW';

        // Atualiza cache em memória
        this._updateCache(leadId, message, responseTime);

        const result = {
            confidence: confidenceScore,
            isBot: confidenceScore >= 60,
            signals: detectedSignals,
            recommendation,
            timestamp: new Date().toISOString(),
            leadId
        };

        logger.info(`[BOT DETECTOR] Lead ${leadId}: Confidence ${confidenceScore}% → ${recommendation}`, {
            sinais: detectedSignals.length
        });

        return result;
    }

    // ─────────────────────────────────────────────────────────
    // SIGNAL 1: Padrão temporal fixo
    // ─────────────────────────────────────────────────────────

    _analyzeTimingPattern(leadId, currentResponseTime, previousTimes) {
        const allTimes = [...previousTimes];
        if (currentResponseTime !== null) allTimes.push(currentResponseTime);

        if (allTimes.length < 3) return { detected: false };

        const recent   = allTimes.slice(-5);
        const avg      = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((s, t) => s + Math.pow(t - avg, 2), 0) / recent.length;
        const stdDev   = Math.sqrt(variance);

        if (stdDev < 2 && recent.length >= 3) {
            return {
                detected: true,
                score: 40,
                details: `Padrão fixo: ${avg.toFixed(1)}s ± ${stdDev.toFixed(1)}s nas últimas ${recent.length} respostas`
            };
        }

        return { detected: false };
    }

    // ─────────────────────────────────────────────────────────
    // SIGNAL 2: Mensagem duplicada
    // ─────────────────────────────────────────────────────────

    _analyzeMessageDuplicate(leadId, message, previousMessages) {
        const normalizedCurrent = this._normalizeText(message);

        // Checar cache em memória primeiro (mais rápido)
        const cached = this.messageCache.get(leadId) || [];
        const allPrevious = [...cached, ...previousMessages];

        const isDuplicate = allPrevious.some(m => this._normalizeText(m) === normalizedCurrent);

        if (isDuplicate) {
            return {
                detected: true,
                score: 50,
                details: `Mensagem idêntica encontrada no histórico do lead`
            };
        }

        return { detected: false };
    }

    // ─────────────────────────────────────────────────────────
    // SIGNAL 3: Apenas URLs sem contexto
    // ─────────────────────────────────────────────────────────

    _analyzeURLOnly(message) {
        const urlRegex = /https?:\/\/[^\s]+/gi;
        const urls     = message.match(urlRegex) || [];

        if (urls.length === 0) return { detected: false };

        const textWithoutUrl = message.replace(urlRegex, '').trim();
        const wordCount      = textWithoutUrl.split(/\s+/).filter(Boolean).length;

        if (wordCount <= 3) {
            return {
                detected: true,
                score: 30,
                details: `${urls.length} URL(s) com apenas ${wordCount} palavra(s) de contexto`
            };
        }

        return { detected: false };
    }

    // ─────────────────────────────────────────────────────────
    // SIGNAL 4: Resposta muito rápida
    // ─────────────────────────────────────────────────────────

    _analyzeResponseSpeed(responseTime) {
        if (responseTime !== null && responseTime < 5) {
            return {
                detected: true,
                score: 25,
                details: `Resposta em ${responseTime}s (humano típico: 30-120s)`
            };
        }
        return { detected: false };
    }

    // ─────────────────────────────────────────────────────────
    // SIGNAL 5: Palavras-chave de automação
    // ─────────────────────────────────────────────────────────

    _analyzeAutomationKeywords(message) {
        const patterns = [
            /i['\s]?m\s+a\s+bot/i,
            /automated\s+response/i,
            /automatic\s+reply/i,
            /out\s+of\s+office/i,
            /thank you for your (message|email)/i,
            /we have received your (message|email)/i,
            /this is an automated (message|reply)/i,
            /chatbot/i,
            /virtual assistant/i,
            /resposta\s+autom[aá]tica/i,
            /mensagem\s+autom[aá]tica/i,
            /n[aã]o\s+entendi\s+sua\s+pergunta/i,
            /ausente\s+do\s+escrit[oó]rio/i,
            /fora\s+do\s+escrit[oó]rio/i,
            /estou\s+fora\s+do\s+ar/i
        ];

        for (const pattern of patterns) {
            if (pattern.test(message)) {
                return {
                    detected: true,
                    score: 60,
                    details: `Palavra-chave de automação detectada: "${message.substring(0, 60).trim()}..."`
                };
            }
        }

        return { detected: false };
    }

    // ─────────────────────────────────────────────────────────
    // SIGNAL 6: Hora fixa de resposta
    // ─────────────────────────────────────────────────────────

    _analyzeHourPattern(leadId, previousResponseTimes) {
        const cached = this.responseTimings.get(leadId) || [];
        if (cached.length < 3) return { detected: false };

        // Extrai hora de cada timestamp armazenado
        const hours = cached.map(e => new Date(e.ts).getHours());
        const uniqueHours = new Set(hours);

        // Se 80%+ das respostas são na mesma hora
        if (hours.length >= 3 && uniqueHours.size === 1) {
            return {
                detected: true,
                score: 35,
                details: `Todas as ${hours.length} respostas ocorreram às ${[...uniqueHours][0]}h (padrão suspeito)`
            };
        }

        return { detected: false };
    }

    // ─────────────────────────────────────────────────────────
    // Análise histórica de BOTs da mesma empresa
    // ─────────────────────────────────────────────────────────

    /**
     * Busca BOTs detectados anteriormente na mesma empresa e adiciona bonus.
     * @param {string} leadId
     * @param {string} company
     * @returns {Promise<{score: number, details: string}>}
     */
    async analyzeHistoricalPattern(leadId, company) {
        try {
            const rows = await crmSheets.getAll(CRM_TABS.BOT_DETECCOES);
            if (!rows || rows.length < 2) return { score: 0, details: 'Sem histórico' };

            const headers = rows[0].map(h => String(h).toLowerCase().trim());
            const companyIdx = headers.findIndex(h => h.includes('empresa') || h.includes('company'));
            const botIdx     = headers.findIndex(h => h.includes('é_bot') || h.includes('bot'));

            const previousBots = rows.slice(1).filter(row => {
                const rowCompany = String(row[companyIdx] || '').toLowerCase();
                const isBot      = String(row[botIdx] || '').toLowerCase();
                return company && rowCompany.includes(company.toLowerCase()) && isBot === 'sim';
            });

            if (previousBots.length === 0) return { score: 0, details: 'Nenhum padrão histórico desta empresa' };

            const bonusScore = Math.min(20, previousBots.length * 5);
            return {
                score: bonusScore,
                details: `${previousBots.length} BOT(s) detectado(s) anteriormente nesta empresa`
            };
        } catch (err) {
            logger.warn(`[BOT DETECTOR] Erro ao analisar padrão histórico: ${err.message}`);
            return { score: 0, details: 'Erro ao buscar histórico' };
        }
    }

    // ─────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────

    _normalizeText(text) {
        return String(text)
            .toLowerCase()
            .trim()
            .replace(/[^\w\s]/g, '')
            .replace(/\s+/g, ' ');
    }

    _updateCache(leadId, message, responseTime) {
        // Mensagens
        const msgs = this.messageCache.get(leadId) || [];
        msgs.push(message);
        if (msgs.length > 20) msgs.shift(); // mantém últimas 20
        this.messageCache.set(leadId, msgs);

        // Timings
        if (responseTime !== null) {
            const timings = this.responseTimings.get(leadId) || [];
            timings.push({ ts: Date.now(), seconds: responseTime });
            if (timings.length > 10) timings.shift();
            this.responseTimings.set(leadId, timings);
        }
    }

    _emptyResponse(leadId = null) {
        return {
            confidence: 0,
            isBot: false,
            signals: [],
            recommendation: 'CONTINUE',
            timestamp: new Date().toISOString(),
            leadId
        };
    }
}

module.exports = new BotDetector();
