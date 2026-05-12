'use strict';

const { OpenAI } = require('openai');
const logger = require('../config/logger');
const env = require('../config/env');
const leadStateStore = require('../core/sdr-state-store');
const remoteControl = require('./sdr-remote-control');
const { loadSdrSystemPrompt } = require('../openai/sdr-prompt-loader');
const intentMatcher = require('./intent-matcher');
const { EscalationRulesEngine } = require('../escalation/escalation-rules');
const contextCache = require('../cache/context-cache');
const contextCompressor = require('../cache/context-compressor');
const personaSelector = require('../personas/persona-selector');
const notificationBuilder = require('../escalation/notification-builder');
const sessionManager = require('../session/session-manager');
const FeedbackSystem = require('../learning/feedback-system');
const patternAnalyzer = require('../learning/pattern-analyzer');
const { crmSheets } = require('../sheets/crm-sheets');
const operationalMetrics = require('../monitoring/operational-metrics');
const OutputValidator = require('../compliance/output-validator');
const { renderTemplate, selectTemplate } = require('../templates/followup-templates');

const feedbackSystem = new FeedbackSystem(crmSheets);
const metricsAggregator = require('../monitoring/metrics-aggregator');

const DUE_FOLLOWUPS = [1, 5, 10];

class SDRStateMachine {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.systemPrompt = loadSdrSystemPrompt();
        this._aggregationCycleCounter = 0;
        this._lastAggregationTime = 0;
    }

    async generateReply({
        leadId,
        leadMeta = {},
        history = [],
        currentText = '',
        analysis = {},
        currentDate = new Date(),
        audioContext = '',
        whatsappClient = null,
        messageTimestamp = null
    }) {
        const leadKey = this._normalizeLeadId(leadId);

        // Validação de sessão (M2) — descarta mensagens de sessões anteriores ao QR atual
        if (messageTimestamp && !sessionManager.isMessageFromCurrentSession(messageTimestamp)) {
            logger.info(`[SDR State] Mensagem de sessão anterior ignorada para ${leadKey}`);
            return null;
        }

        // Early-return: intent simples resolvido sem chamar GPT-4o
        if (!audioContext) {
            // Cache hit: mesma mensagem já processada recentemente (retry/duplicata)
            const cacheKey = `${leadKey}::${String(currentText).trim()}`;
            const cached = contextCache.get(cacheKey);
            if (cached) {
                logger.info(`[SDR State] Cache hit para ${leadKey} — reutilizando resposta anterior`);
                return cached;
            }

            const intentResult = intentMatcher.match(currentText);
            if (intentResult.matched) {
                logger.info(`[SDR State] Intent '${intentResult.intent}' para lead ${leadKey} — resposta template (sem GPT)`);
                leadStateStore.recordOutbound(leadKey, intentResult.response, {
                    source: 'intent-template',
                    intent: intentResult.intent
                });
                return {
                    reply: intentResult.response,
                    state: leadStateStore.getLead(leadKey),
                    stage: leadStateStore.getLead(leadKey).current_funnel_stage || 'TOP_OF_FUNNEL',
                    fromIntent: intentResult.intent
                };
            }
        }

        const currentState = leadStateStore.setLeadInfo(leadKey, {
            decisor_name: leadMeta.decisor_name || leadMeta.nome || '',
            decisor_contact: leadMeta.decisor_contact || leadKey,
            pain_points: this._normalizePainPoints(leadMeta.pain_points),
            company: leadMeta.company || leadMeta.empresa || ''
        });

        leadStateStore.recordInbound(leadKey, currentText, {
            source: 'whatsapp',
            analysis,
            audio: !!audioContext
        });

        const updatedState = this._deriveState(currentState, leadMeta, currentText, analysis);
        leadStateStore.setFunnelStage(leadKey, updatedState.current_funnel_stage);

        if (updatedState.addObjection) {
            leadStateStore.addObjection(leadKey, updatedState.addObjection);
        }

        // OPTIMIZED: Reduzir contexto para 120 tokens em vez de 400+ (70% economia)
        const lastMessages = this._buildConversationHistory(history, leadKey)
            .slice(-2);  // Apenas últimas 2 mensagens

        const promptPayload = {
            conversation_history: lastMessages,
            lead_metadata: {
                lead_id: leadKey,
                decisor_name: leadMeta.decisor_name || leadMeta.nome || '',
                company: leadMeta.company || leadMeta.empresa || ''
                // Removido: decisor_contact, pain_points (já estão no analysis)
            },
            current_funnel_stage: updatedState.current_funnel_stage,
            objections_met: (leadStateStore.getLead(leadKey).objections_met || []).slice(-3),  // Apenas últimas 3
            current_message: currentText
            // Removido: follow_up_counter, lead_info, audio_context, analysis (não usados em reply)
        };

        const previousReplies = (leadStateStore.getLead(leadKey).history || [])
            .filter(h => h.role === 'assistant')
            .map(h => String(h.content || '').slice(0, 120))
            .slice(-5);

        const variabilityNote = previousReplies.length > 0
            ? `ATENÇÃO: Responda de forma natural e diferente das mensagens anteriores. Evite repetir frases, aberturas ou call-to-actions já usados. Mensagens anteriores enviadas: ${JSON.stringify(previousReplies)}`
            : 'ATENÇÃO: Responda de forma natural e humana. Evite frases genéricas ou repetitivas.';

        // Selecionar persona dinâmica (M1)
        const _stageToFase = { TOP_OF_FUNNEL: 'fase_1_abordagem', MIDDLE_OF_FUNNEL: 'fase_2_qualificacao', BOTTOM_OF_FUNNEL: 'fase_3_conversao' };
        const persona = personaSelector.select({
            fase: _stageToFase[updatedState.current_funnel_stage] || 'fase_2_qualificacao',
            objecao: updatedState.addObjection || '',
            score: (analysis && analysis.scoreEstimado != null) ? analysis.scoreEstimado : 50,
            numObjecoes: (leadStateStore.getLead(leadKey).objections_met || []).length
        });
        const personaBlock = personaSelector.generatePromptBlock(persona, {
            ultimaResposta: currentText,
            fluxo: updatedState.current_funnel_stage,
            nome: leadMeta.decisor_name || leadMeta.nome
        });
        const enrichedSystemPrompt = `${this.systemPrompt}\n\n${personaBlock}`;
        logger.info(`[SDR State] Persona: ${persona.key} (matchScore: ${persona.matchScore}) para lead ${leadKey}`);

        try {
            const completion = await this.openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: enrichedSystemPrompt },
                    {
                        role: 'user',
                        content: `${variabilityNote}\n\n${JSON.stringify(promptPayload, null, 2)}`
                    }
                ],
                max_tokens: 50,  // TUNING: Resposta concisa (<50 tokens = <100 chars)
                temperature: 0.4,  // TUNING: Reduzido de dinâmico para 0.4 (mais determinístico)
                top_p: 0.6,  // TUNING: Reduzido de 0.9 para 0.6 (menos variação)
                frequency_penalty: 0.4,  // NOVO: Evita repetição de palavras
                presence_penalty: 0.1   // NOVO: Encoraja termos novos
            });

            const reply = String(completion.choices?.[0]?.message?.content || '').trim();
            if (!reply) {
                throw new Error('Resposta vazia da OpenAI');
            }

            // VALIDAÇÃO: Checagem de compliance pré-envio (OutputValidator)
            const validationResult = OutputValidator.validate(reply, {
                stage: updatedState.current_funnel_stage,
                followUpDay: null,
                leadState: leadStateStore.getLead(leadKey)
            });

            let finalReply = reply;
            if (!validationResult.valid) {
                logger.warn(`[SDR State] Resposta rejeitada (${validationResult.issues.length} issues): ${validationResult.issues.join('; ')}`);
                finalReply = OutputValidator.useFallback({
                    stage: updatedState.current_funnel_stage,
                    objections: leadStateStore.getLead(leadKey).objections_met || []
                });
            } else {
                logger.info(`[SDR State] Resposta validada (score: ${validationResult.score})`);
            }

            leadStateStore.recordOutbound(leadKey, finalReply, {
                source: 'openai',
                stage: updatedState.current_funnel_stage,
                validationScore: validationResult.score
            });

            operationalMetrics.trackOutboundMessage({
                leadId: leadKey,
                source: 'openai',
                stage: updatedState.current_funnel_stage,
                replyLength: finalReply.length,
                validationScore: validationResult.score,
                fallbackUsed: finalReply !== reply,
                messagePreview: finalReply.slice(0, 120)
            }).catch(err => logger.warn(`[PILAR3_METRICS] Falha ao registrar outbound: ${err.message}`));

            // Armazenar resposta no cache para deduplicação de retries
            const replyResult = {
                reply: finalReply,
                state: leadStateStore.getLead(leadKey),
                stage: updatedState.current_funnel_stage,
                persona: persona.key
            };
            const cacheKey = `${leadKey}::${String(currentText).trim()}`;
            contextCache.set(cacheKey, replyResult);

            // Pilar 3 Phase 2: Agregação inline a cada N replies
            this._aggregationCycleCounter++;
            if (this._aggregationCycleCounter >= 5) {
                try {
                    await metricsAggregator.processAggregations('hourly');
                    this._aggregationCycleCounter = 0;
                } catch (err) {
                    logger.debug(`[PILAR3_AGGREGATION_INLINE] Falha (ignorado): ${err.message}`);
                }
            }

            await this.evaluateForHumanTransition({
                leadId: leadKey,
                leadMeta,
                currentText,
                analysis,
                stage: updatedState.current_funnel_stage,
                whatsappClient,
                reason: 'TRANSICAO_HUMANA',
                personaUsed: persona.key
            });

            return replyResult;
        } catch (err) {
            logger.error(`[SDR State] Falha ao gerar resposta: ${err.message}`);
            await this._notifyAdminFailure({
                leadId: leadKey,
                leadMeta,
                currentText,
                analysis,
                error: err,
                whatsappClient
            });

            const fallbackReply = 'Obrigado pelo retorno. Pode me passar mais um detalhe para eu te orientar melhor?';
            leadStateStore.recordOutbound(leadKey, fallbackReply, {
                source: 'fallback',
                error: err.message
            });

            return {
                reply: fallbackReply,
                state: leadStateStore.getLead(leadKey),
                stage: updatedState.current_funnel_stage,
                fallback: true
            };
        }
    }

    async generateFollowUp({
        leadId,
        leadMeta = {},
        currentDate = new Date(),
        followUpDay = 1,
        whatsappClient = null
    }) {
        const leadKey = this._normalizeLeadId(leadId);
        const currentState = leadStateStore.getLead(leadKey);

        // OTIMIZAÇÃO: Usar templates estruturados em vez de GPT para follow-ups
        // Reduz 100% das chamadas GPT em follow-ups (D1/D5/D10)
        
        // Determinar chave do dia (D1, D5, D10)
        const dayKey = `D${followUpDay}`;

        // Selecionar template automático baseado em objections
        const templateName = selectTemplate(dayKey, currentState);
        logger.info(`[SDR State] Follow-up ${dayKey} para ${leadKey}: template='${templateName}'`);

        // Renderizar template com variáveis do lead
        const reply = renderTemplate(dayKey, templateName, {
            nome: leadMeta.decisor_name || currentState.lead_info?.decisor_name || 'você',
            empresa: leadMeta.company || currentState.lead_info?.company || ''
        });

        // Validar follow-up pré-envio
        const validationResult = OutputValidator.validate(reply, {
            stage: currentState.current_funnel_stage,
            followUpDay: followUpDay,
            leadState: currentState
        });

        let finalReply = reply;
        if (!validationResult.valid) {
            logger.warn(`[SDR State] Follow-up ${dayKey} rejeitado (${validationResult.issues.length} issues)`);
            finalReply = OutputValidator.useFallback({
                stage: currentState.current_funnel_stage,
                objections: currentState.objections_met || []
            });
        }

        leadStateStore.markFollowUpSent(leadKey, followUpDay);
        leadStateStore.recordOutbound(leadKey, finalReply, {
            source: 'template',  // Fonte mudou de 'scheduler'/'openai' para 'template'
            followUpDay,
            template: templateName,
            validationScore: validationResult.score
        });

        operationalMetrics.trackOutboundMessage({
            leadId: leadKey,
            source: 'template',
            stage: currentState.current_funnel_stage,
            replyLength: finalReply.length,
            validationScore: validationResult.score,
            fallbackUsed: finalReply !== reply,
            followUpDay,
            template: templateName,
            messagePreview: finalReply.slice(0, 120)
        }).catch(err => logger.warn(`[PILAR3_METRICS] Falha ao registrar follow-up: ${err.message}`));

        return finalReply;
    }

    async evaluateForHumanTransition({ leadId, leadMeta = {}, currentText = '', analysis = {}, whatsappClient = null, reason = 'TRANSICAO_HUMANA', personaUsed = '' }) {
        const leadKey = this._normalizeLeadId(leadId);
        const currentState = leadStateStore.getLead(leadKey);
        const stage = currentState.current_funnel_stage || 'TOP_OF_FUNNEL';

        if (currentState.human_transition_notified_at) {
            logger.info('[PILAR2_DECISION] HUMAN_TRANSITION_ALREADY_NOTIFIED', {
                leadId: leadKey,
                stage,
                notifiedAt: currentState.human_transition_notified_at
            });
            return false;
        }

        const leadForEval = this._buildEscalationLeadContext({
            leadKey,
            leadMeta,
            analysis,
            currentState
        });
        const evaluation = this._getEscalationDecision({
            leadId: leadKey,
            leadForEval,
            currentText,
            analysis,
            stage,
            leadMeta
        });
        if (!evaluation.shouldNotify) return false;

        // Construir notificação estruturada via NotificationBuilder (M3)
        const structuredNotification = evaluation.action === 'HANDOFF'
            ? notificationBuilder.buildQualifiedLeadNotification(leadForEval, evaluation)
            : notificationBuilder.buildEscalationNotification(leadForEval, {
                ...evaluation,
                reason: evaluation.reason || reason
            });

        logger.info(`[SDR State] Notificação estruturada: ${structuredNotification.type} — ${structuredNotification.metadata?.reason || reason}`);

        leadStateStore.markHumanTransitionNotified(leadKey);

        // Registrar conversa qualificada no feedback system (Bloco 7 / M1)
        if (evaluation.action === 'HANDOFF') {
            await feedbackSystem.recordSuccessfulConversation({
                lead: { ...leadForEval, numero: leadKey },
                conversation: currentState.history || [],
                outcome: {
                    type: 'QUALIFIED',
                    personas: personaUsed ? [personaUsed] : [],
                    playbooks: [],
                    duration: 0
                }
            });

            const stats = await feedbackSystem.getSuccessRate();
            if (stats && stats.total > 0 && stats.total % 10 === 0) {
                const successPatterns = await feedbackSystem.getSuccessPatterns();
                const patterns = patternAnalyzer.analyzeSuccessPatterns(
                    Array.isArray(successPatterns) ? successPatterns : []
                );
                logger.info(`[LEARNING] Padrões (${stats.total} conversas): ${JSON.stringify(patterns.recommendations || [])}`);
            }
        }

        await this._notifyAdminPayload({
            leadId: leadKey,
            leadMeta,
            reason: structuredNotification.escalation_reason?.reason || evaluation.reason || reason,
            currentText,
            analysis,
            whatsappClient,
            action: evaluation.action === 'HANDOFF' ? 'LIGAR_AGORA' : 'VERIFICAR'
        });
        return true;
    }

    async runFollowUpScan({ whatsappClient }) {
        const dueLeads = leadStateStore.getDueFollowUps();
        const results = [];

        for (const item of dueLeads) {
            try {
                const leadId = item.leadId;
                const leadState = item.leadState;
                const leadMeta = leadState.lead_info || {};
                const contact = leadMeta.decisor_contact || leadId;

                for (const day of item.dueDays) {
                    const reply = await this.generateFollowUp({
                        leadId,
                        leadMeta,
                        followUpDay: day,
                        whatsappClient
                    });

                    if (whatsappClient && contact) {
                        await whatsappClient.sendMessage(`${contact}@c.us`, reply);
                    }

                    if (day === 10) {
                        await this._notifyAdminPayload({
                            leadId,
                            leadMeta,
                            reason: 'D10',
                            currentText: reply,
                            whatsappClient,
                            action: 'LIGAR_AGORA'
                        });
                    }

                    results.push({ leadId, day, sent: true });
                }
            } catch (err) {
                logger.error(`[SDR State] Falha no follow-up do lead ${item.leadId}: ${err.message}`);
                await this._notifyAdminFailure({
                    leadId: item.leadId,
                    leadMeta: item.leadState?.lead_info || {},
                    currentText: '',
                    analysis: { tipo: 'followup_scan' },
                    error: err,
                    whatsappClient
                });
                results.push({ leadId: item.leadId, error: err.message });
            }
        }

        // Pilar 3 Phase 2: Agregação de métricas e alertas por degradação
        this._aggregationCycleCounter++;
        const now = Date.now();
        const timeSinceLastAggregation = now - this._lastAggregationTime;
        const shouldAggregate = this._aggregationCycleCounter >= 10 || timeSinceLastAggregation > 15 * 60 * 1000; // 10 cycles ou 15 min

        if (shouldAggregate) {
            try {
                await metricsAggregator.processAggregations('hourly');
                // Agregação diária a cada 6 horas
                if (this._aggregationCycleCounter % 36 === 0) {
                    await metricsAggregator.processAggregations('daily');
                }
                this._lastAggregationTime = now;
                this._aggregationCycleCounter = 0;
                logger.info(`[PILAR3_AGGREGATION] Ciclo de agregação processado com sucesso`);
            } catch (err) {
                logger.warn(`[PILAR3_AGGREGATION] Falha ao processar agregações: ${err.message}`);
            }
        }

        return results;
    }

    _deriveState(currentState, leadMeta, currentText, analysis) {
        const normalizedText = String(currentText || '').toLowerCase();
        const objectionsMet = new Set([...(currentState.objections_met || [])]);

        if (analysis && analysis.objecao) {
            objectionsMet.add(String(analysis.objecao).trim());
        }

        if (this._containsAny(normalizedText, ['não tenho interesse', 'nao tenho interesse', 'sem interesse', 'não quero', 'nao quero'])) {
            objectionsMet.add('nao_interesse');
        }

        if (this._containsAny(normalizedText, ['email', 'e-mail'])) {
            objectionsMet.add('enviar_email');
        }

        if (this._containsAny(normalizedText, ['fornecedor', 'agência', 'agencia'])) {
            objectionsMet.add('fornecedor_existente');
        }

        const qualificationComplete = this._isQualificationComplete({ currentText, leadMeta, analysis });
        const humanRequest = this._isHumanRequest(normalizedText, analysis);
        const complexObjection = this._isComplexObjection(normalizedText, analysis);

        const nextStage = qualificationComplete
            ? 'BOTTOM_OF_FUNNEL'
            : (currentState.current_funnel_stage === 'BOTTOM_OF_FUNNEL'
                ? 'BOTTOM_OF_FUNNEL'
                : (currentState.history && currentState.history.length > 0
                    ? 'MIDDLE_OF_FUNNEL'
                    : 'TOP_OF_FUNNEL'));

        return {
            current_funnel_stage: nextStage,
            follow_up_counter: 0,
            addObjection: objectionsMet.size ? Array.from(objectionsMet).pop() : '',
            qualificationComplete,
            humanRequest,
            complexObjection
        };
    }

    _isQualificationComplete({ currentText, leadMeta, analysis }) {
        const text = String(currentText || '').toLowerCase();
        if (leadMeta && (leadMeta.decisor_contact || leadMeta.decisor_name)) {
            if (this._containsAny(text, ['agenda', 'marcar', 'reunião', 'reuniao', 'call', 'horário', 'horario', 'segunda', 'terça', 'terca'])) {
                return true;
            }
        }

        if (analysis && String(analysis.tipo || '').toLowerCase() === 'resposta_positiva') {
            if (this._containsAny(text, ['agenda', 'marcar', 'reunião', 'reuniao', 'call', 'horário', 'horario'])) {
                return true;
            }
        }

        return false;
    }

    _isHumanRequest(text, analysis) {
        const humanHints = [
            'falar com humano',
            'quero falar com alguém',
            'quero falar com alguem',
            'pessoa real',
            'atendente',
            'humano',
            'ligar',
            'me liga',
            'me ligue',
            'telefone',
            'call'
        ];

        return this._containsAny(text, humanHints) || String(analysis && analysis.tipo || '').toLowerCase() === 'resposta_positiva' && this._containsAny(text, ['ligar', 'telefone', 'call']);
    }

    _isComplexObjection(text, analysis) {
        const complexHints = ['jurídico', 'juridico', 'concorrente', 'contrato', 'integracao', 'integração', 'preco', 'preço', 'budget', 'orcamento', 'orçamento'];
        return this._containsAny(text, complexHints) || String(analysis && analysis.objecao || '').toLowerCase() === 'sem_budget';
    }

    _buildEscalationLeadContext({ leadKey, leadMeta = {}, analysis = {}, currentState = {} }) {
        return {
            ...leadMeta,
            ...currentState.lead_info,
            interacoes: (currentState.history || []).length,
            objecoes: currentState.objections_met || [],
            score: analysis && analysis.scoreEstimado != null ? analysis.scoreEstimado : 50,
            decisor_contact: leadMeta.decisor_contact || currentState.lead_info?.decisor_contact || leadKey,
            decisor_name: leadMeta.decisor_name || leadMeta.nome || currentState.lead_info?.decisor_name || '',
            company: leadMeta.company || leadMeta.empresa || currentState.lead_info?.company || ''
        };
    }

    _getEscalationDecision({ leadId, leadForEval, currentText, analysis, stage, leadMeta }) {
        const ctx = { currentText, analysis, stage };
        const evaluation = EscalationRulesEngine.evaluate(leadForEval || {}, ctx);
        const legacySignals = {
            humanRequest: this._isHumanRequest(String(currentText || '').toLowerCase(), analysis),
            complexObjection: this._isComplexObjection(String(currentText || '').toLowerCase(), analysis),
            qualificationComplete: this._isQualificationComplete({ currentText, leadMeta, analysis })
        };

        if (EscalationRulesEngine.shouldReject(leadForEval || {}, ctx)) {
            const decision = {
                ...evaluation,
                shouldNotify: false
            };
            this._logCommercialDecision({
                leadId,
                stage,
                currentText,
                analysis,
                leadForEval,
                evaluation: decision,
                legacySignals,
                decisionType: 'REJECT'
            });
            return decision;
        }

        const legacyShouldNotify = legacySignals.humanRequest
            || legacySignals.complexObjection
            || legacySignals.qualificationComplete;

        const decision = {
            ...evaluation,
            shouldNotify: EscalationRulesEngine.shouldHandoff(leadForEval || {}, ctx)
                || EscalationRulesEngine.shouldEscalate(leadForEval || {}, ctx)
                || legacyShouldNotify
        };

        this._logCommercialDecision({
            leadId,
            stage,
            currentText,
            analysis,
            leadForEval,
            evaluation: decision,
            legacySignals,
            decisionType: decision.action || 'NO_ACTION'
        });

        return decision;
    }

    _logCommercialDecision({
        leadId,
        stage,
        currentText,
        analysis,
        leadForEval,
        evaluation,
        legacySignals,
        decisionType
    }) {
        const logData = {
            leadId,
            decision: decisionType,
            shouldNotify: !!evaluation.shouldNotify,
            action: evaluation.action || 'NONE',
            reason: evaluation.reason || 'NONE',
            priority: evaluation.priority || 'NONE',
            score: evaluation.score != null ? evaluation.score : null,
            matched: Array.isArray(evaluation.matched) ? evaluation.matched : [],
            stage,
            analysisType: analysis && analysis.tipo ? analysis.tipo : '',
            objection: analysis && analysis.objecao ? analysis.objecao : '',
            legacySignals,
            decisorContact: !!(leadForEval && leadForEval.decisor_contact),
            interactions: leadForEval && leadForEval.interacoes != null ? leadForEval.interacoes : 0,
            objectionsCount: Array.isArray(leadForEval && leadForEval.objecoes) ? leadForEval.objecoes.length : 0,
            messagePreview: String(currentText || '').slice(0, 120)
        };

        if (decisionType === 'REJECT') {
            logger.info('[PILAR2_DECISION] REJECT', logData);
            operationalMetrics.trackCommercialDecision(logData).catch(err => logger.warn(`[PILAR3_METRICS] Falha ao registrar decisão: ${err.message}`));
            return;
        }

        if (evaluation.shouldNotify && evaluation.action === 'HANDOFF') {
            logger.info('[PILAR2_DECISION] HANDOFF', logData);
            operationalMetrics.trackCommercialDecision(logData).catch(err => logger.warn(`[PILAR3_METRICS] Falha ao registrar decisão: ${err.message}`));
            return;
        }

        if (evaluation.shouldNotify && evaluation.action === 'ESCALATE') {
            logger.warn('[PILAR2_DECISION] ESCALATE', logData);
            operationalMetrics.trackCommercialDecision(logData).catch(err => logger.warn(`[PILAR3_METRICS] Falha ao registrar decisão: ${err.message}`));
            return;
        }

        logger.info('[PILAR2_DECISION] NO_ACTION', logData);
        operationalMetrics.trackCommercialDecision(logData).catch(err => logger.warn(`[PILAR3_METRICS] Falha ao registrar decisão: ${err.message}`));
    }

    async _notifyAdminPayload({ leadId, leadMeta = {}, reason, currentText, analysis = {}, whatsappClient, action = 'LIGAR_AGORA' }) {
        const payload = {
            to: env.SDR_ADMIN_WHATSAPP_NUMBERS || env.SDR_ADMIN_WHATSAPP_NUMBER || 'ADMIN_NUMBER_VITHOR',
            message: [
                '🚨 ALERTA SDR IA: Intervenção Necessária',
                `Lead: ${leadMeta.decisor_name || leadMeta.nome || leadId || 'desconhecido'}`,
                `Empresa: ${leadMeta.company || leadMeta.empresa || 'não informada'}`,
                `Motivo: ${reason || 'TRANSICAO_HUMANA'}`,
                `Resumo: ${this._buildSummary({ currentText, analysis, leadMeta })}`
            ].join('\n'),
            action
        };

        if (whatsappClient) {
            await remoteControl.notifyAdminPayload(whatsappClient, payload);
            return true;
        }

        return false;
    }

    async _notifyAdminFailure({ leadId, leadMeta = {}, currentText, analysis = {}, error, whatsappClient }) {
        const payload = {
            to: env.SDR_ADMIN_WHATSAPP_NUMBERS || env.SDR_ADMIN_WHATSAPP_NUMBER || 'ADMIN_NUMBER_VITHOR',
            message: [
                '🚨 ALERTA SDR IA: Falha na Geração',
                `Lead: ${leadMeta.decisor_name || leadMeta.nome || leadId || 'desconhecido'}`,
                `Empresa: ${leadMeta.company || leadMeta.empresa || 'não informada'}`,
                'Motivo: ERRO_GERACAO',
                `Resumo: ${this._buildSummary({ currentText, analysis, leadMeta, error })}`
            ].join('\n'),
            action: 'LIGAR_AGORA'
        };

        if (whatsappClient) {
            await remoteControl.notifyAdminPayload(whatsappClient, payload);
        }
    }

    _buildSummary({ currentText, analysis, leadMeta, error }) {
        const parts = [
            currentText ? `msg=${String(currentText).slice(0, 120)}` : '',
            analysis && analysis.tipo ? `tipo=${analysis.tipo}` : '',
            analysis && analysis.objecao ? `objeção=${analysis.objecao}` : '',
            leadMeta && leadMeta.decisor_contact ? `contato=${leadMeta.decisor_contact}` : '',
            error ? `erro=${error.message}` : ''
        ].filter(Boolean);

        return parts.length ? parts.join(' | ') : 'sem detalhes';
    }

    _buildConversationHistory(history, leadId) {
        const raw = Array.isArray(history) && history.length
            ? history
            : (leadStateStore.getLead(leadId).history || []);

        // Comprimir para as últimas 6 mensagens / 300 chars por msg antes de enviar ao GPT
        return contextCompressor.compressMessages(raw);
    }

    _getCreativityTemperature(stage) {
        const normalized = String(stage || '').toUpperCase();
        if (normalized === 'TOP_OF_FUNNEL') return 0.80;    // mais criativo na abordagem
        if (normalized === 'MIDDLE_OF_FUNNEL') return 0.75; // variado mas coerente
        if (normalized === 'BOTTOM_OF_FUNNEL') return 0.70; // preciso, ainda variável
        return 0.75;
    }

    _normalizeLeadId(leadId) {
        return String(leadId || '').replace(/\D/g, '');
    }

    _normalizePainPoints(value) {
        if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
        if (!value) return [];
        return String(value).split(',').map(v => v.trim()).filter(Boolean);
    }

    _containsAny(text, hints) {
        const normalized = String(text || '').toLowerCase();
        return hints.some(hint => normalized.includes(String(hint).toLowerCase()));
    }
}

module.exports = new SDRStateMachine();
