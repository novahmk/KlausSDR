/**
 * Security Validator
 * Central gate for all outbound message authorization.
 *
 * Five-layer validation before ANY message is sent:
 *   1. SEGURANÇA   – permanent blocks & terminal statuses
 *   2. Rate Limit  – global msg/min, msg/hour, msg/day caps
 *   3. Lead Interval – minimum gap between contacts for the same lead
 *   4. Spam Detection – rejection-pattern analysis
 *   5. Final Auth     – composite result + audit trail
 */

const crypto = require('crypto');
const { securitySheets, BLOCKED_STATUSES } = require('../sheets/security-sheets');
const { crmSheets, CRM_TABS } = require('../sheets/crm-sheets');
const logger = require('../config/logger');

// In-memory sliding-window counter to reduce Sheets API calls for rate limiting
const _sentTimestamps = []; // { ts: Number, leadId: String }

// In-memory queue for rate-limited messages (retry on reconnection)
// Structure: { leadId, telefoneId, nomeLead, mensagem, tipoMensagem, enqueuedAt, retryAfterMs }
const _messageQueue = [];

function _recordSent(leadId) {
    _sentTimestamps.push({ ts: Date.now(), leadId });
    // Keep only last 24 h to cap memory usage
    const cutoff = Date.now() - 86_400_000;
    while (_sentTimestamps.length && _sentTimestamps[0].ts < cutoff) {
        _sentTimestamps.shift();
    }
}

function _countSentSince(msAgo, leadId = null) {
    const cutoff = Date.now() - msAgo;
    return _sentTimestamps.filter(e => e.ts >= cutoff && (leadId ? e.leadId === leadId : true)).length;
}

function _generateToken(leadId) {
    return crypto
        .createHash('sha256')
        .update(`${leadId}_${Date.now()}_${Math.random()}`)
        .digest('hex')
        .slice(0, 32);
}

class SecurityValidator {
    // ─────────────────────────────────────────────────────────
    // LAYER 1: Permanent block / terminal status check
    // ─────────────────────────────────────────────────────────

    async _checkSecurity(leadId) {
        const record = await securitySheets.getSecurityRecord(leadId);
        if (!record) {
            return { autorizado: true, motivo: 'Lead novo, sem restrições de segurança' };
        }

        if (record.bloqueado === 'Sim') {
            return {
                autorizado: false,
                motivo: `Lead permanentemente bloqueado: ${record.razaoBloqueio || 'sem detalhe'}`,
                layer: 'SEGURANÇA',
                acao: 'BLOQUEIA_HARD'
            };
        }

        if (BLOCKED_STATUSES.includes(record.statusFinal)) {
            return {
                autorizado: false,
                motivo: `Status final bloqueante: "${record.statusFinal}"`,
                layer: 'SEGURANÇA',
                acao: 'BLOQUEIA'
            };
        }

        return {
            autorizado: true,
            motivo: `Status permitido: "${record.statusFinal || 'Em Progresso'}"`,
            statusFinal: record.statusFinal
        };
    }

    // ─────────────────────────────────────────────────────────
    // LAYER 2: Global rate limits (in-memory sliding window)
    // ─────────────────────────────────────────────────────────

    async _checkRateLimit(config) {
        const maxPerMin = config.Max_Mensagens_Por_Minuto || 2;
        const maxPerHour = config.Max_Mensagens_Por_Hora || 10;
        const maxPerDay = config.Max_Mensagens_Por_Dia || 50;

        const lastMin = _countSentSince(60_000);
        const lastHour = _countSentSince(3_600_000);
        const lastDay = _countSentSince(86_400_000);

        if (lastMin >= maxPerMin) {
            return {
                permitido: false,
                motivo: `${lastMin} msgs no último minuto (máx: ${maxPerMin})`,
                delay: 30_000,
                statusRate: 'BLOQUEADO',
                layer: 'RATE_LIMIT'
            };
        }

        if (lastHour >= maxPerHour) {
            return {
                permitido: false,
                motivo: `${lastHour} msgs na última hora (máx: ${maxPerHour})`,
                delay: 300_000,
                statusRate: 'AVISO',
                layer: 'RATE_LIMIT'
            };
        }

        if (lastDay >= maxPerDay) {
            return {
                permitido: false,
                motivo: `${lastDay} msgs hoje (máx diário: ${maxPerDay}). Fila pausada até meia-noite.`,
                delay: 'midnight',
                statusRate: 'BLOQUEADO',
                layer: 'RATE_LIMIT'
            };
        }

        return { permitido: true, statusRate: 'OK', lastMin, lastHour, lastDay };
    }

    // ─────────────────────────────────────────────────────────
    // LAYER 3: Per-lead minimum interval
    // ─────────────────────────────────────────────────────────

    async _checkLeadInterval(leadId, config) {
        const minIntervalMin = config.Min_Intervalo_Entre_Contatos || 30;
        const lastSentTs = _sentTimestamps
            .filter(e => e.leadId === leadId)
            .map(e => e.ts)
            .sort((a, b) => b - a)[0];

        if (lastSentTs) {
            const elapsedMin = (Date.now() - lastSentTs) / 60_000;
            if (elapsedMin < minIntervalMin) {
                const waitMin = Math.ceil(minIntervalMin - elapsedMin);
                return {
                    permitido: false,
                    motivo: `Apenas ${elapsedMin.toFixed(1)} min desde último contato. Mínimo: ${minIntervalMin} min.`,
                    delay: waitMin * 60_000,
                    layer: 'INTERVALO_LEAD'
                };
            }
        }

        return { permitido: true };
    }

    // ─────────────────────────────────────────────────────────
    // LAYER 4: Spam pattern detection
    // ─────────────────────────────────────────────────────────

    async _detectSpam(leadId, config) {
        if (String(config.Deteccao_Spam_Ativa || 'Sim').toLowerCase() !== 'sim') {
            return { detectado: false };
        }

        try {
            // Fetch recent interactions for this lead
            const interacoes = await crmSheets.getManyByLeadId(CRM_TABS.INTERACOES, leadId);
            if (!interacoes || interacoes.length < 3) {
                return { detectado: false };
            }

            const recent = interacoes.slice(-5);
            const rejections = recent.filter(m => {
                const resp = String(m['resposta_recebida'] || m['resposta positiva'] || m['resposta'] || '').toLowerCase();
                const tipo = String(m['tipo_contato'] || '').toLowerCase();
                // A received message without a positive indicator = rejection/no-response signal
                return tipo.includes('recebida') && !resp.includes('sim') && !resp.includes('positive');
            }).length;

            const rejectionRate = rejections / recent.length;
            const maxRate = config.Taxa_Rejeicao_Limite || 0.70;

            if (rejectionRate >= 0.80) {
                await securitySheets.createAlert({
                    tipoAlerta: 'Taxa de Rejeição Alta / Spam Detectado',
                    severidade: 'Crítico',
                    leadId,
                    descricao: `${Math.round(rejectionRate * 100)}% de rejeições nos últimos ${recent.length} contatos. Bloqueio automático ativado.`,
                    acaoAutomatica: 'Bloquear lead e notificar operador'
                });

                return {
                    detectado: true,
                    taxa: rejectionRate,
                    motivo: `${Math.round(rejectionRate * 100)}% de rejeições (>= 80%). Lead marcado como padrão spam.`,
                    layer: 'SPAM_DETECTION',
                    acao: 'BLOQUEIA_E_ALERTA'
                };
            }

            if (rejectionRate >= maxRate) {
                return {
                    detectado: true,
                    taxa: rejectionRate,
                    motivo: `${Math.round(rejectionRate * 100)}% de rejeições (>= ${Math.round(maxRate * 100)}%).`,
                    layer: 'SPAM_DETECTION',
                    acao: 'AVISO'
                };
            }

            // Check: 2+ rejections today
            const today = new Date().toLocaleDateString('pt-BR');
            const todayRejections = recent.filter(m => {
                const data = String(m['data'] || '');
                const resp = String(m['resposta_recebida'] || '').toLowerCase();
                return data === today && !resp.includes('sim');
            }).length;

            if (todayRejections >= 2) {
                return {
                    detectado: true,
                    taxa: todayRejections,
                    motivo: `${todayRejections} rejeições hoje neste lead. Aguardando 24h.`,
                    layer: 'SPAM_DETECTION',
                    acao: 'AGUARDA_24H'
                };
            }

            return { detectado: false };
        } catch (err) {
            logger.warn(`[SecurityValidator] Erro na detecção de spam para ${leadId}: ${err.message}`);
            return { detectado: false };
        }
    }

    // ─────────────────────────────────────────────────────────
    // LAYER 5: Final authorization (composite)
    // ─────────────────────────────────────────────────────────

    /**
     * Main entry point. Call this before sending ANY message.
     * @param {string} leadId  – phone number / lead identifier
     * @param {Object} [opts]  – optional context (nomeLead, tipoMensagem)
     * @returns {Object} { autorizado: Boolean, motivo: String, token?: String }
     */
    async authorizeMessage(leadId, opts = {}) {
        const { nomeLead = '', tipoMensagem = 'WhatsApp' } = opts;

        // Load config (cached)
        const config = await securitySheets.getConfig();

        // 1. Security check
        const secResult = await this._checkSecurity(leadId);
        if (!secResult.autorizado) {
            await this._logAudit({
                leadId, nomeLead,
                acao: `Bloqueio: ${secResult.layer}`,
                tipoAcao: 'Segurança',
                autorizado: 'Não',
                motivo: secResult.motivo
            });
            logger.warn(`[SecurityValidator] ❌ BLOQUEADO (segurança) - Lead ${leadId}: ${secResult.motivo}`);
            return { autorizado: false, motivo: secResult.motivo, layer: secResult.layer };
        }

        // 2. Global rate limit
        const rateResult = await this._checkRateLimit(config);
        if (!rateResult.permitido) {
            await this._logRateLimit(leadId, tipoMensagem, rateResult);
            await this._logAudit({
                leadId, nomeLead,
                acao: `Rate limit global ativado`,
                tipoAcao: 'Rate Limit',
                autorizado: 'Não',
                motivo: rateResult.motivo
            });
            logger.warn(`[SecurityValidator] ⏱ RATE LIMIT GLOBAL - Lead ${leadId}: ${rateResult.motivo}`);
            // Auto-enqueue if caller provided message text and telefoneId
            if (opts.mensagem && opts.telefoneId) {
                this._enqueueMessage({ leadId, telefoneId: opts.telefoneId, nomeLead, mensagem: opts.mensagem, tipoMensagem, delay: rateResult.delay });
            }
            return { autorizado: false, motivo: rateResult.motivo, delay: rateResult.delay, layer: 'RATE_LIMIT', enfileirado: !!(opts.mensagem && opts.telefoneId) };
        }

        // 3. Per-lead interval
        const intervalResult = await this._checkLeadInterval(leadId, config);
        if (!intervalResult.permitido) {
            await this._logRateLimit(leadId, tipoMensagem, {
                statusRate: 'AVISO',
                motivo: intervalResult.motivo
            });
            logger.warn(`[SecurityValidator] ⏳ INTERVALO LEAD - Lead ${leadId}: ${intervalResult.motivo}`);
            if (opts.mensagem && opts.telefoneId) {
                this._enqueueMessage({ leadId, telefoneId: opts.telefoneId, nomeLead, mensagem: opts.mensagem, tipoMensagem, delay: intervalResult.delay });
            }
            return { autorizado: false, motivo: intervalResult.motivo, delay: intervalResult.delay, layer: 'INTERVALO_LEAD', enfileirado: !!(opts.mensagem && opts.telefoneId) };
        }

        // 4. Spam detection
        const spamResult = await this._detectSpam(leadId, config);
        if (spamResult.detectado && spamResult.acao !== 'AVISO') {
            await this._logAudit({
                leadId, nomeLead,
                acao: `Spam detectado: ${spamResult.acao}`,
                tipoAcao: 'Detecção de Spam',
                autorizado: 'Não',
                motivo: spamResult.motivo
            });
            logger.warn(`[SecurityValidator] 🚫 SPAM DETECTADO - Lead ${leadId}: ${spamResult.motivo}`);
            return { autorizado: false, motivo: spamResult.motivo, layer: spamResult.layer, acao: spamResult.acao };
        }

        // ✅ AUTHORIZED
        const token = _generateToken(leadId);
        _recordSent(leadId);

        // Log successful send to RATE_LIMIT sheet (mirrors the guide's recordMessageSent)
        await securitySheets.appendRateLimitEvent({
            leadId,
            tipoMensagem,
            mensagensUltimaHora: String(rateResult.lastHour + 1),
            mensagensUltimoDia: String(rateResult.lastDay + 1),
            statusRate: 'OK',
            permitido: 'Sim',
            acaoTomada: 'Enviada'
        });

        await this._logAudit({
            leadId, nomeLead,
            acao: 'Mensagem autorizada',
            tipoAcao: 'Envio',
            autorizado: 'Sim',
            tokenReconexao: token,
            motivo: secResult.motivo
        });

        if (spamResult.detectado && spamResult.acao === 'AVISO') {
            logger.warn(`[SecurityValidator] ⚠️ AVISO SPAM (não bloqueante) - Lead ${leadId}: ${spamResult.motivo}`);
        }

        logger.info(`[SecurityValidator] ✅ AUTORIZADO - Lead ${leadId} | msgs: ${rateResult.lastMin}/min, ${rateResult.lastHour}/h, ${rateResult.lastDay}/dia`);
        return { autorizado: true, token, motivo: 'Todas as validações passaram', statsRate: rateResult };
    }

    /**
     * Validates after a WhatsApp reconnection (QR scan). Logs the reconnection event.
     * @param {string} sessionId - WhatsApp session ID or label
     */
    async validateReconnection(sessionId = 'sdr-ia') {
        const token = _generateToken(sessionId);

        await this._logAudit({
            leadId: 'SISTEMA',
            acao: 'Reconexão via QR Code – Sistema SDR IA',
            tipoAcao: 'Reconexão',
            autorizado: 'Sim',
            tokenReconexao: token,
            motivo: 'Sessão WhatsApp reconectada. In-memory rate limit preservado.'
        });

        logger.info(`[SecurityValidator] 🔐 Reconexão registrada. Token: ${token.slice(0, 16)}...`);
        return { token, reconectado: true };
    }

    /**
     * Permanently block a lead and log the action.
     * @param {string} leadId
     * @param {string} nomeLead
     * @param {string} statusFinal  - e.g. 'Rejeitado Permanente'
     * @param {string} razao
     */
    async blockLead(leadId, nomeLead, statusFinal, razao) {
        await securitySheets.upsertSecurityRecord({
            leadId,
            nomeLead,
            statusFinal,
            bloqueado: 'Sim',
            dataBloqueio: new Date().toLocaleDateString('pt-BR'),
            razaoBloqueio: razao,
            dataFinalizacao: new Date().toLocaleDateString('pt-BR'),
            motivo: razao
        });

        await this._logAudit({
            leadId, nomeLead,
            acao: `Lead bloqueado permanentemente: ${statusFinal}`,
            tipoAcao: 'Bloqueio',
            autorizado: 'Não',
            motivo: razao,
            statusDepois: statusFinal
        });

        logger.warn(`[SecurityValidator] 🔒 Lead ${leadId} (${nomeLead}) bloqueado permanentemente: ${razao}`);
    }

    // ─────────────────────────────────────────────────────────
    // Private logging helpers
    // ─────────────────────────────────────────────────────────

    async _logAudit(data) {
        await securitySheets.appendAuditLog({
            leadId: data.leadId,
            acao: data.acao,
            tipoAcao: data.tipoAcao,
            statusAntes: data.statusAntes || '',
            statusDepois: data.statusDepois || '',
            tokenReconexao: data.tokenReconexao || '',
            autorizado: data.autorizado || 'Não',
            motivo: data.motivo,
            usuarioIa: 'SDR_IA_v2.0'
        });
    }

    async _logRateLimit(leadId, tipoMensagem, rateInfo) {
        await securitySheets.appendRateLimitEvent({
            leadId,
            tipoMensagem,
            statusRate: rateInfo.statusRate || 'BLOQUEADO',
            permitido: 'Não',
            motivoBloqueio: rateInfo.motivo,
            acaoTomada: rateInfo.delay === 'midnight' ? 'Enfileirada até meia-noite' : 'Enfileirada com delay'
        });
    }

    // ─────────────────────────────────────────────────────────
    // Message queue (retry on reconnection, mirrors guide's enqueueMessage/processQueue)
    // ─────────────────────────────────────────────────────────

    /**
     * Add a message to the retry queue when blocked by rate limit.
     */
    _enqueueMessage({ leadId, telefoneId, nomeLead, mensagem, tipoMensagem, delay }) {
        const retryAfterMs = typeof delay === 'number' ? delay : 5 * 60_000;
        _messageQueue.push({
            leadId,
            telefoneId,
            nomeLead,
            mensagem,
            tipoMensagem,
            enqueuedAt: Date.now(),
            retryAfterMs
        });
        logger.info(`[SecurityValidator] 📥 Mensagem enfileirada para Lead ${leadId}. Retry em ${Math.ceil(retryAfterMs / 60_000)} min.`);
    }

    /**
     * Returns queued messages whose retry window has elapsed.
     */
    getPendingMessages() {
        const now = Date.now();
        return _messageQueue.filter(item => now >= item.enqueuedAt + item.retryAfterMs);
    }

    /**
     * Process queued messages after reconnection.
     * Called by sdr-whatsapp on the 'ready' event.
     * @param {Function} sendFn  async (telefoneId, mensagem) => void
     */
    async processFila(sendFn) {
        const pending = this.getPendingMessages();
        if (pending.length === 0) {
            logger.debug('[SecurityValidator] Fila vazia, nada a reprocessar.');
            return;
        }

        logger.info(`[SecurityValidator] 🔄 Reprocessando ${pending.length} mensagem(ns) enfileirada(s)...`);

        for (const item of pending) {
            // Remove from queue first to avoid double-processing
            const idx = _messageQueue.indexOf(item);
            if (idx !== -1) _messageQueue.splice(idx, 1);

            // Re-validate before sending
            const auth = await this.authorizeMessage(item.leadId, {
                nomeLead: item.nomeLead,
                tipoMensagem: item.tipoMensagem
            });

            if (!auth.autorizado) {
                logger.warn(`[SecurityValidator] ⚠️ Item da fila bloqueado novamente para Lead ${item.leadId}: ${auth.motivo}`);
                // Re-enqueue if it's still a rate limit issue
                if (auth.layer === 'RATE_LIMIT' || auth.layer === 'INTERVALO_LEAD') {
                    _messageQueue.push({ ...item, enqueuedAt: Date.now(), retryAfterMs: auth.delay || 5 * 60_000 });
                }
                continue;
            }

            try {
                await sendFn(item.telefoneId, item.mensagem);
                logger.info(`[SecurityValidator] ✅ Mensagem da fila enviada para Lead ${item.leadId}`);
            } catch (err) {
                logger.error(`[SecurityValidator] Erro ao enviar item da fila para Lead ${item.leadId}: ${err.message}`);
            }
        }
    }
}

module.exports = new SecurityValidator();
