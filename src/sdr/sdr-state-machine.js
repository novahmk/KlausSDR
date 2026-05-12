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

const feedbackSystem = new FeedbackSystem(crmSheets);

const DUE_FOLLOWUPS = [1, 5, 10];

class SDRStateMachine {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.systemPrompt = loadSdrSystemPrompt();
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

        const promptPayload = {
            conversation_history: this._buildConversationHistory(history, leadKey),
            lead_metadata: {
                lead_id: leadKey,
                decisor_name: leadMeta.decisor_name || leadMeta.nome || '',
                decisor_contact: leadMeta.decisor_contact || leadKey,
                company: leadMeta.company || leadMeta.empresa || '',
                pain_points: this._normalizePainPoints(leadMeta.pain_points)
            },
            current_funnel_stage: updatedState.current_funnel_stage,
            follow_up_counter: updatedState.follow_up_counter,
            objections_met: leadStateStore.getLead(leadKey).objections_met || [],
            lead_info: leadStateStore.getLead(leadKey).lead_info || {},
            current_datetime: currentDate.toISOString(),
            current_message: currentText,
            analysis,
            audio_context: audioContext || ''
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
                temperature: this._getCreativityTemperature(updatedState.current_funnel_stage),
                top_p: 0.9
            });

            const reply = String(completion.choices?.[0]?.message?.content || '').trim();
            if (!reply) {
                throw new Error('Resposta vazia da OpenAI');
            }

            leadStateStore.recordOutbound(leadKey, reply, {
                source: 'openai',
                stage: updatedState.current_funnel_stage
            });

            // Armazenar resposta no cache para deduplicação de retries
            const replyResult = {
                reply,
                state: leadStateStore.getLead(leadKey),
                stage: updatedState.current_funnel_stage,
                persona: persona.key
            };
            const cacheKey = `${leadKey}::${String(currentText).trim()}`;
            contextCache.set(cacheKey, replyResult);

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
        const promptPayload = {
            conversation_history: currentState.history || [],
            lead_metadata: {
                lead_id: leadKey,
                decisor_name: leadMeta.decisor_name || currentState.lead_info?.decisor_name || '',
                decisor_contact: leadMeta.decisor_contact || currentState.lead_info?.decisor_contact || leadKey,
                company: leadMeta.company || currentState.lead_info?.company || '',
                pain_points: leadMeta.pain_points || currentState.lead_info?.pain_points || []
            },
            current_funnel_stage: currentState.current_funnel_stage,
            follow_up_counter: followUpDay,
            objections_met: currentState.objections_met || [],
            lead_info: currentState.lead_info || {},
            current_datetime: currentDate.toISOString(),
            follow_up_reason: `D${followUpDay}`
        };

        const previousFollowUps = (currentState.history || [])
            .filter(h => h.role === 'assistant')
            .map(h => String(h.content || '').slice(0, 120))
            .slice(-5);

        const followUpVariabilityNote = previousFollowUps.length > 0
            ? `ATENÇÃO: Este é um follow-up D${followUpDay}. Responda de forma natural e diferente das mensagens anteriores. Evite repetir aberturas ou argumentos já usados. Mensagens anteriores: ${JSON.stringify(previousFollowUps)}`
            : `ATENÇÃO: Este é um follow-up D${followUpDay}. Seja natural, humano e direto. Evite frases genéricas.`;

        const completion = await this.openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: this.systemPrompt },
                { role: 'user', content: `${followUpVariabilityNote}\n\n${JSON.stringify(promptPayload, null, 2)}` }
            ],
            temperature: this._getCreativityTemperature(currentState.current_funnel_stage),
            top_p: 0.9
        });

        const reply = String(completion.choices?.[0]?.message?.content || '').trim();
        if (!reply) {
            throw new Error('Resposta vazia ao gerar follow-up');
        }

        leadStateStore.markFollowUpSent(leadKey, followUpDay);
        leadStateStore.recordOutbound(leadKey, reply, {
            source: 'scheduler',
            followUpDay
        });

        return reply;
    }

    async evaluateForHumanTransition({ leadId, leadMeta = {}, currentText = '', analysis = {}, whatsappClient = null, reason = 'TRANSICAO_HUMANA', personaUsed = '' }) {
        const leadKey = this._normalizeLeadId(leadId);
        const currentState = leadStateStore.getLead(leadKey);
        const stage = currentState.current_funnel_stage || 'TOP_OF_FUNNEL';

        if (currentState.human_transition_notified_at) {
            return false;
        }

        const shouldNotify = this._shouldEscalateToHuman({ currentText, analysis, leadMeta, stage });
        if (!shouldNotify) return false;

        // Avaliação estruturada para notificação enriquecida (M3)
        const leadForEval = {
            ...leadMeta,
            interacoes: (currentState.history || []).length,
            objecoes: currentState.objections_met || [],
            score: (analysis && analysis.scoreEstimado) || 50,
            decisor_contact: leadMeta.decisor_contact || leadKey
        };
        const evaluation = EscalationRulesEngine.evaluate(leadForEval, { currentText, analysis, stage });

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

    _shouldEscalateToHuman({ currentText, analysis, leadMeta, stage }) {
        const ctx = { currentText, analysis, stage };
        return EscalationRulesEngine.shouldHandoff(leadMeta || {}, ctx)
            || EscalationRulesEngine.shouldEscalate(leadMeta || {}, ctx)
            // Fallback para estágios antigos mantidos por compatibilidade
            || this._isHumanRequest(String(currentText || '').toLowerCase(), analysis)
            || this._isComplexObjection(String(currentText || '').toLowerCase(), analysis)
            || this._isQualificationComplete({ currentText, leadMeta, analysis })
            || stage === 'BOTTOM_OF_FUNNEL';
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
