/**
 * SDR IA WHATSAPP - SISTEMA INTEGRADO (QR Code + Google Sheets)
 * Baseado na estrutura fornecida pelo usuário, integrado com whatsapp-web.js e crm-sheets
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { OpenAI } = require('openai');
const { crmSheets, CRM_TABS } = require('./sheets/crm-sheets');
const logger = require('./config/logger');
const { detectMediaType, transcribeAudio, createAudioContext } = require('./utils/media-transcriber');
const env = require('./config/env');
const remoteControl = require('./sdr/sdr-remote-control');
const sdrStateMachine = require('./sdr/sdr-state-machine');
const securityValidator = require('./security/security-validator');
const botDetector = require('./security/bot-detector');
const escapeStrategy = require('./security/escape-strategy');
const { securitySheets } = require('./sheets/security-sheets');
const intentMatcher = require('./sdr/intent-matcher');
const sessionManager = require('./session/session-manager');

// ============================================
// CONTROLE DE SESSÃO — apenas leads/mensagens da sessão atual
// ============================================
let SYSTEM_ACTIVATION = Date.now();

// ============================================
// 1. PROMPT DO SISTEMA
// ============================================

const SYSTEM_PROMPT = `# System Prompt para SDR IA

## 1. Perfil e Objetivo da IA
**Nome:** SDR IA (Sales Development Representative de Inteligência Artificial)
**Função:** Atuar como o primeiro ponto de contacto com potenciais clientes (leads), com o objetivo principal de qualificar o interesse, identificar o Perfil de Cliente Ideal (ICP) e agendar uma reunião ou obter o contacto direto do decisor.
**Personalidade/Tom:** Profissional, proativo, empático, focado em valor, persistente mas respeitoso.

## 2. Diretrizes de Comunicação
- **Geração de Mensagens:** Gerar dinamicamente, adaptando-se ao contexto da conversa, ao tom do lead e ao funil.
- **Clareza e Concisão:** Curtas, diretas e concisas, focando no valor.
- **Persuasão e Empatia:** Validar as objeções antes de contra-argumentar.

## 3. Fluxo de Conversa e Lógica de Decisão
- Cenário 1: Abordagem Inicial (obter contato do decisor)
- Tratamento de Objeções: "Já temos fornecedor", "Não temos orçamento", "Envie email".
- Follow-ups Automáticos: D1, D5, D10.

## 5. Saída da IA
Gerar APENAS a próxima mensagem a ser enviada ao lead em português europeu.
Mensagens concisas (máximo 3-5 linhas para WhatsApp). Sem formatação extra ou explicações.`;

// ============================================
// 2. CLASSE PRINCIPAL - SDR WHATSAPP INTEGRADO
// ============================================

class SDRWhatsAppSystem {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.isAuthenticated = false;
        this.isReady = false;

        // Cliente WhatsApp Web (QR Code)
        this.whatsapp = new Client({
            authStrategy: new LocalAuth({ clientId: 'sdr-ia' }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage'
                ]
            }
        });

        this._setupWhatsAppListeners();
    }

    _setupWhatsAppListeners() {
        this.whatsapp.on('qr', (qr) => {
            logger.info('\n📱 [SDR IA] QR CODE GERADO. Escaneie no seu WhatsApp Web:');
            qrcode.generate(qr, { small: true });
            sessionManager.onQRGenerated();
        });

        this.whatsapp.on('authenticated', () => {
            logger.info('✅ [SDR IA] WhatsApp Autenticado e conectado!');
            this.isAuthenticated = true;
        });

        this.whatsapp.on('ready', () => {
            logger.info('🟢 [SDR IA] Sistema SDR pronto para disparar/escutar mensagens!');
            this.isReady = true;
            SYSTEM_ACTIVATION = sessionManager.onReady();
            logger.info(`[SDR IA] SYSTEM_ACTIVATION atualizado: ${new Date(SYSTEM_ACTIVATION).toISOString()}`);
            // Injeta o cliente WhatsApp no escape-strategy para canal WHATSAPP_ALT
            escapeStrategy.setWhatsAppClient(this.whatsapp);
            // Registra a reconexão / início de sessão no AUDIT_LOG
            securityValidator.validateReconnection('sdr-ia').catch(err =>
                logger.warn(`[SDR IA] Erro ao registar reconexão segura: ${err.message}`)
            );
            // Ao reconectar, reprocessa mensagens que ficaram em fila por rate limit
            this._processarFilaEnfileirada().catch(err =>
                logger.warn(`[SDR IA] Erro ao processar fila pós-reconexão: ${err.message}`)
            );
        });

        // Quando o cliente responde pelo WhatsApp
        this.whatsapp.on('message', async (msg) => {
            if (msg.from === 'status@broadcast') return;

            // Ignorar mensagens anteriores à sessão atual (ex: mensagens acumuladas offline)
            const msgTs = (msg.timestamp || 0) * 1000;
            if (msgTs && msgTs < SYSTEM_ACTIVATION - 1000) {
                logger.debug(`[SDR IA] Mensagem de ${msg.from} ignorada: timestamp (${new Date(msgTs).toISOString()}) anterior à sessão atual.`);
                return;
            }

            logger.info(`📥 Nova Mensagem Recebida de ${msg.from}: ${msg.body || `[${msg.type || 'midia'}]`}`);
            try {
                const handled = await this._handleRemoteCommand(msg);
                if (handled) return;

                sessionManager.registerLead(msg.from);
                sessionManager.incrementMessageCount();
                await this.processarMensagemRecebida(msg.from, msg.body, msg._data?.notifyName, msg);
            } catch (err) {
                logger.error(`Erro ao processar recebimento: ${err.message}`);
            }
        });
    }

    async iniciar() {
        return this.whatsapp.initialize();
    }

    // ============================================
    // FLUXOS DO SDR
    // ============================================

    /**
     * Processar mensagem recebida
     */
    async processarMensagemRecebida(telefoneId, corpo, nomeRemetente, mensagemObj = null) {
        if (!this._isRemoteControlEnabled()) {
            await this._maybeNotifyCallOnlyMode(telefoneId, corpo, nomeRemetente, mensagemObj);
            logger.info(`[SDR IA] Automacao pausada. Mensagem recebida de ${telefoneId} registrada sem resposta.`);
            return;
        }

        // Limpar o número para encontrar no Google Sheets
        const telefoneNumero = telefoneId.replace('@c.us', '').replace(/\D/g, '');

        let textoEntrada = String(corpo || '').trim();
        let audioContext = '';

        if (mensagemObj && mensagemObj.hasMedia) {
            try {
                const media = await mensagemObj.downloadMedia();
                const mediaType = detectMediaType(mensagemObj, media);

                if (mediaType === 'audio') {
                    const transcription = await transcribeAudio(mensagemObj, media);
                    if (transcription && transcription.text) {
                        textoEntrada = transcription.text;
                        audioContext = createAudioContext(transcription);
                        logger.info(`[SDR IA] Audio detectado e transcrito para ${telefoneNumero}`);
                    }
                } else if (!textoEntrada) {
                    textoEntrada = `[${mediaType}]`;
                }
            } catch (err) {
                logger.warn(`[SDR IA] Falha no processamento de midia (${telefoneNumero}): ${err.message}`);
                if (!textoEntrada) {
                    textoEntrada = '[midia recebida sem transcricao]';
                }
            }
        }

        if (!textoEntrada) {
            textoEntrada = '[mensagem vazia]';
        }

        // 1. Obter Lead do Google Sheets (Nossa base)
        let leadDB = await crmSheets.getOneByLeadId(CRM_TABS.LEADS, telefoneNumero);

        let leadNome = nomeRemetente || 'Lead';
        if (!leadDB) {
            // Se não existe na planilha, salva como novo Lead
            await crmSheets.appendRow(CRM_TABS.LEADS, {
                lead_id: telefoneNumero,
                nome: leadNome,
                data_criacao: new Date().toISOString()
            });
            logger.info(`📝 Novo lead cadastrado no sheets: ${telefoneNumero}`);
        } else {
            leadNome = leadDB.nome || leadDB.nome_lead || leadNome;
        }

        // 2. Grava a Interação do Lead Respondendo
        const respostaPositiva = this._detectarRespostaPositiva(textoEntrada);

        // Calcula tempo de resposta desde a última mensagem enviada
        const interacoesAnteriores = await crmSheets.getManyByLeadId(CRM_TABS.INTERACOES, telefoneNumero);
        const ultimaEnviada = interacoesAnteriores
            .filter(m => String(m['tipo_contato'] || '').toLowerCase().includes('sdr ia'))
            .slice(-1)[0];
        const responseTimeSec = ultimaEnviada?.hora
            ? Math.round((Date.now() - new Date(`${ultimaEnviada.data} ${ultimaEnviada.hora}`).getTime()) / 1000)
            : null;

        const previousMsgs  = interacoesAnteriores
            .filter(m => String(m['tipo_contato'] || '').includes('Recebida'))
            .map(m => m['resposta_recebida'] || '');
        const previousTimes = interacoesAnteriores
            .filter(m => m['tempo_resposta_segundos'])
            .map(m => Number(m['tempo_resposta_segundos']));

        // Análise de BOT ANTES de continuar o fluxo
        const botAnalysis = await botDetector.analyze({
            message: textoEntrada,
            leadId: telefoneNumero,
            responseTime: responseTimeSec,
            previousMessages: previousMsgs,
            previousResponseTimes: previousTimes
        });

        await crmSheets.appendRow(CRM_TABS.INTERACOES, {
            id: `msg_rec_${Date.now()}`,
            lead_id: telefoneNumero,
            data: new Date().toLocaleDateString('pt-BR'),
            hora: new Date().toLocaleTimeString('pt-BR'),
            tipo_contato: 'Recebida',
            resposta_recebida: textoEntrada,
            resposta_positiva: respostaPositiva ? 'Sim' : 'Não',
            e_bot: botAnalysis.isBot ? 'Sim' : 'Não',
            bot_confianca: botAnalysis.confidence,
            bot_razao: botAnalysis.signals.map(s => s.type).join(', '),
            tempo_resposta_segundos: responseTimeSec ?? ''
        });

        // Se BOT detectado: executar escape strategy, registar e interromper fluxo normal
        if (botAnalysis.isBot) {
            logger.warn(`[SDR IA] 🤖 BOT DETECTADO para ${telefoneNumero} - ${botAnalysis.confidence}% confiança (${botAnalysis.recommendation})`);

            // Executar escape para contato alternativo (não aguarda para não bloquear)
            const escapeResult = await escapeStrategy.executeEscape(
                telefoneNumero,
                leadDB || { nome: leadNome, telefone: telefoneNumero },
                botAnalysis.confidence
            ).catch(err => {
                logger.error(`[SDR IA] Erro no escape strategy: ${err.message}`);
                return { success: false, channelUsed: 'ERRO', details: err.message, humanNotified: false };
            });

            logger.info(`[SDR IA] Escape concluído — canal: ${escapeResult.channelUsed}, sucesso: ${escapeResult.success}`);

            // Registar detecção com resultado do escape
            await crmSheets.appendRow(CRM_TABS.BOT_DETECCOES, {
                id: `bot_${Date.now()}`,
                lead_id: telefoneNumero,
                nome_lead: leadNome,
                data: new Date().toLocaleDateString('pt-BR'),
                hora: new Date().toLocaleTimeString('pt-BR'),
                padrao_detectado: botAnalysis.signals.map(s => s.type).join(', '),
                confianca: botAnalysis.confidence,
                razao: botAnalysis.signals.map(s => s.details).join('; '),
                recomendacao: botAnalysis.recommendation,
                estrategia_usada: escapeResult.channelUsed,
                resultado: escapeResult.success ? 'ESCAPE_SUCESSO' : 'ESCAPE_FALHOU'
            });

            // Atualizar pipeline do lead
            await crmSheets.appendRow(CRM_TABS.PIPELINE, {
                lead_id: telefoneNumero,
                nome_lead: leadNome,
                status_atual: 'BOT_DETECTADO',
                ultima_acao: `Escape via ${escapeResult.channelUsed}`,
                proxima_acao: escapeResult.success
                    ? (escapeResult.humanNotified ? 'Aguardar operador' : 'Aguardar resposta canal alternativo')
                    : 'Contato manual urgente',
                data_ultima_acao: new Date().toLocaleDateString('pt-BR')
            }).catch(() => {});

            securitySheets.createAlert({
                tipoAlerta: 'BOT Detectado',
                severidade: botAnalysis.confidence > 85 ? 'Crítico' : 'Aviso',
                leadId: telefoneNumero,
                descricao: `BOT detectado com ${botAnalysis.confidence}% de confiança. Escape via ${escapeResult.channelUsed}: ${escapeResult.success ? 'Sucesso' : 'Falhou'}. Sinais: ${botAnalysis.signals.map(s => s.type).join(', ')}.`,
                acaoAutomatica: botAnalysis.recommendation
            }).catch(() => {});

            return; // Não responder ao BOT como se fosse humano
        }

        // 3. Verificar intent simples — evita chamadas desnecessárias ao GPT-4o
        const intentResult = intentMatcher.match(textoEntrada);
        if (intentResult.matched) {
            logger.info(`[SDR IA] Intent '${intentResult.intent}' detectado para ${telefoneNumero} — resposta template (sem GPT)`);

            const authIntent = await securityValidator.authorizeMessage(telefoneNumero, {
                nomeLead: leadNome,
                tipoMensagem: 'WhatsApp (Template)'
            });

            if (authIntent.autorizado) {
                await this._simulateTypingDelay(telefoneId, intentResult.response);
                await this.whatsapp.sendMessage(telefoneId, intentResult.response);

                await crmSheets.appendRow(CRM_TABS.INTERACOES, {
                    id: `msg_tpl_${Date.now()}`,
                    lead_id: telefoneNumero,
                    data: new Date().toLocaleDateString('pt-BR'),
                    hora: new Date().toLocaleTimeString('pt-BR'),
                    tipo_contato: 'WhatsApp (SDR Template)',
                    mensagem_enviada: intentResult.response,
                    notas: `intent=${intentResult.intent}`
                });
            } else {
                logger.warn(`[SDR IA] Template bloqueado para ${telefoneNumero}: ${authIntent.motivo}`);
            }
            return;
        }

        // 4. Inferir análise local (sem GPT) — sentimento, tipo e objeção via regex
        // A chamada GPT real acontece uma única vez em sdrStateMachine.generateReply() abaixo.
        const analise = this._inferAnalise(textoEntrada);

        await this._notifyCallIfNeeded({
            telefoneNumero,
            leadNome,
            textoEntrada,
            analise
        });

        // Determinar próximo passo
        const proximaAcao = this._sugerirProximaAcao(analise, textoEntrada);
        const status = analise.tipo === 'resposta_positiva' ? 'Qualificado' : (analise.tipo === ' objeção' ? 'Objeção' : 'Em Andamento');

        await crmSheets.appendRow(CRM_TABS.PIPELINE, {
            lead_id: telefoneNumero,
            nome_lead: leadNome,
            status_atual: status,
            ultima_acao: 'Mensagem Recebida',
            proxima_acao: proximaAcao,
            data_ultima_acao: new Date().toLocaleDateString('pt-BR')
        });

        // Alerta quando lead se qualifica (resposta positiva / reunião)
        if (analise.tipo === 'resposta_positiva' || proximaAcao === 'Agendar Reunião') {
            securitySheets.createAlert({
                tipoAlerta: 'Lead Qualificado',
                severidade: 'Info',
                leadId: telefoneNumero,
                descricao: `${leadNome} respondeu positivamente. Ação sugerida: ${proximaAcao}.`,
                acaoAutomatica: proximaAcao
            }).catch(() => {});
        }

        // Atualiza métricas na aba ANÁLISE
        this._atualizarAnalytics(telefoneNumero, analise).catch(err =>
            logger.warn(`[SDR IA] Erro ao atualizar ANÁLISE: ${err.message}`)
        );

        // 4. Gerar resposta
        const stateResult = await sdrStateMachine.generateReply({
            leadId: telefoneNumero,
            leadMeta: {
                nome: leadNome,
                decisor_name: leadNome,
                decisor_contact: telefoneNumero,
                company: leadDB?.empresa || leadDB?.company || leadDB?.empresa_nome || '',
                pain_points: leadDB?.pain_points || []
            },
            currentText: textoEntrada,
            analysis: analise,
            audioContext,
            whatsappClient: this.whatsapp
        });

        const respostaIa = stateResult.reply;

        // 5. Validação de Segurança Anti-Spam antes de enviar
        const authResult = await securityValidator.authorizeMessage(telefoneNumero, {
            nomeLead: leadNome,
            tipoMensagem: 'WhatsApp',
            mensagem: respostaIa,
            telefoneId
        });

        if (!authResult.autorizado) {
            if (authResult.enfileirado) {
                logger.info(`[SDR IA] 📥 Resposta para ${telefoneNumero} enfileirada (${authResult.motivo})`);
            } else {
                logger.warn(`[SDR IA] ❌ Envio bloqueado para ${telefoneNumero}: ${authResult.motivo}`);
            }
            return;
        }

        // 6. Enviar Resposta via QR Code WhatsappClient
        await this._simulateTypingDelay(telefoneId, respostaIa);
        await this.whatsapp.sendMessage(telefoneId, respostaIa);

        // 7. Grava Interação Enviada
        await crmSheets.appendRow(CRM_TABS.INTERACOES, {
            id: `msg_env_${Date.now()}`,
            lead_id: telefoneNumero,
            data: new Date().toLocaleDateString('pt-BR'),
            hora: new Date().toLocaleTimeString('pt-BR'),
            tipo_contato: 'WhatsApp (SDR IA)',
            mensagem_enviada: respostaIa,
            notas: `Análise: Sentimento ${analise.sentimento}`
        });

        logger.info(`✅ Resposta gerada e enviada via IA para ${telefoneNumero}`);
    }

    /**
     * Ler a planilha de LEADS e iniciar contatos que nunca tiveram interação (Primeira Abordagem)
     */
    async iniciarAbordagensDeNovosLeads() {
        if (!this.isReady) {
            logger.warn('WhatsApp não está pronto. Não é possível iniciar abordagens ativas.');
            return;
        }

        const leads = await crmSheets.getAll(CRM_TABS.LEADS);
        if (leads.length < 2) return;

        const headers = leads[0].map(h => String(h).toLowerCase());
        const idIdx = headers.findIndex(h => h.includes('id') || h === 'lead_id');
        const nomeIdx = headers.findIndex(h => h.includes('nome'));
        const criadoIdx = headers.findIndex(h => h.includes('data_criacao') || h.includes('created_at') || h.includes('datacriacao'));

        for (let r = 1; r < leads.length; r++) {
            const row = leads[r];
            const telefone = row[idIdx]?.replace(/\D/g, '');
            const nome = row[nomeIdx] || 'Comercial';

            if (!telefone) continue;

            // Ignorar leads criados antes da sessão atual
            if (criadoIdx !== -1 && row[criadoIdx]) {
                const leadCreatedAt = new Date(row[criadoIdx]).getTime();
                if (Number.isFinite(leadCreatedAt) && leadCreatedAt < SYSTEM_ACTIVATION - 1000) {
                    logger.debug(`[SDR IA] Lead ${telefone} ignorado: criado antes da sessão atual.`);
                    continue;
                }
            }

            const interacoes = await crmSheets.getManyByLeadId(CRM_TABS.INTERACOES, telefone);

            // Se não tem interações, faz Mande
            if (interacoes.length === 0) {
                logger.info(`Iniciando primeira abordagem com ${nome} (${telefone})`);

                // Validação de Segurança Anti-Spam antes da primeira abordagem
                const authFirst = await securityValidator.authorizeMessage(telefone, {
                    nomeLead: nome,
                    tipoMensagem: 'WhatsApp (Primeira Abordagem)'
                });

                if (!authFirst.autorizado) {
                    logger.warn(`[SDR IA] ❌ Primeira abordagem bloqueada para ${telefone} (${nome}): ${authFirst.motivo}`);
                    continue;
                }

                const primeiraMsg = await this._gerarPrimeiraAbordagem(nome);

                // Envia
                try {
                    await this._simulateTypingDelay(`${telefone}@c.us`, primeiraMsg);
                    await this.whatsapp.sendMessage(`${telefone}@c.us`, primeiraMsg);

                    // Salva
                    await crmSheets.appendRow(CRM_TABS.INTERACOES, {
                        id: `msg_fst_${Date.now()}`,
                        lead_id: telefone,
                        data: new Date().toLocaleDateString('pt-BR'),
                        hora: new Date().toLocaleTimeString('pt-BR'),
                        tipo_contato: 'WhatsApp (SDR IA Primeira Abordagem)',
                        mensagem_enviada: primeiraMsg
                    });

                    await crmSheets.appendRow(CRM_TABS.PIPELINE, {
                        lead_id: telefone,
                        nome_lead: nome,
                        status_atual: 'Abordagem Inicial',
                        cenario: '1'
                    });

                    // Pause
                    await new Promise(res => setTimeout(res, 2000));
                } catch (err) {
                    logger.error(`Não foi possivel mandar whatsapp para ${telefone}`);
                }
            }
        }
    }

    // ============================================
    // MÁQUINAS IA (MÉTODOS PRIVADOS REAIS)
    // ============================================

    async _analisarMensagem(corpo, nomeLead) {
        // @deprecated — substituído por _inferAnalise() para eliminar chamada GPT duplicada (C4).
        // Mantido para retrocompatibilidade. Não chamar em novos fluxos.
        return this._inferAnalise(corpo);
    }

    /**
     * Inferir análise da mensagem do lead via regex (0 tokens, 0 latência).
     * Produz o mesmo schema de _analisarMensagem sem chamar o GPT.
     * @param {string} texto
     * @returns {{ sentimento: string, tipo: string, objecao: string, proximidadeICP: string }}
     */
    _inferAnalise(texto) {
        const t = String(texto || '').toLowerCase();

        let sentimento = 'neutro';
        let tipo = 'pergunta';
        let objecao = '';
        let proximidadeICP = 'medio';

        // Sentimento
        if (/interessad|agendar|marcar|quero saber|me conta|pode ser|gostei|ótimo|excelente|claro|combinado/.test(t)) sentimento = 'positivo';
        else if (/não|nao|sem interesse|me tira|para de|recuso|não quero/.test(t)) sentimento = 'negativo';

        // Tipo
        if (/agenda|marcar|reunião|reuniao|call|horário|horario|pode ser|combinado|confirmo|segunda|terça|terca/.test(t)) {
            tipo = 'resposta_positiva'; sentimento = 'positivo';
        } else if (/sem interesse|não tenho interesse|nao tenho interesse|não quero|nao quero|email|e-mail|fornecedor|orçamento|orcamento|satisfeito/.test(t)) {
            tipo = 'objeção';
        } else if (/\?|quando|como|quanto|qual|onde/.test(t)) {
            tipo = 'pergunta';
        }

        // Objeção específica
        if (/email|e-mail/.test(t)) objecao = 'enviar_email';
        else if (/fornecedor|agência|agencia/.test(t)) objecao = 'fornecedor_existente';
        else if (/orçamento|orcamento|budget|verba/.test(t)) objecao = 'sem_budget';
        else if (/sem interesse|não tenho interesse|nao tenho interesse|não quero|nao quero/.test(t)) objecao = 'nao_interesse';
        else if (/satisfeito|está bom|esta bom/.test(t)) objecao = 'satisfeito';
        else if (/atendente|não posso passar|nao posso passar|não sou o responsável/.test(t)) objecao = 'sem_contacto';

        // Proximidade ICP
        if (tipo === 'resposta_positiva') proximidadeICP = 'alto';
        else if (objecao) proximidadeICP = 'baixo';

        return { sentimento, tipo, objecao, proximidadeICP };
    }

    async _gerarPrimeiraAbordagem(nome) {
        const prompt = `Gere uma primeira mensagem de abordagem via WhatsApp para o lead "${nome}".
Direta, breve (3 linhas máx), valor claro. APENAS a mensagem:`;

        try {
            const comp = await this.openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.72
            });
            return comp.choices[0].message.content.trim();
        } catch {
            return `Olá ${nome}! Sou o SDR IA. Gostaria de uma conversa breve. Posso ligar?`;
        }
    }

    async _simulateTypingDelay(telefoneId, mensagem) {
        const text = String(mensagem || '');
        const base = 1300;
        const perChar = 28;
        const jitter = Math.floor(Math.random() * 1500);
        const delayMs = Math.min(9000, Math.max(1800, base + (text.length * perChar) + jitter));

        try {
            const chat = await this.whatsapp.getChatById(telefoneId);
            if (chat && typeof chat.sendStateTyping === 'function') {
                await chat.sendStateTyping();
            }
        } catch (err) {
            logger.debug(`[SDR IA] Nao foi possivel sinalizar digitacao para ${telefoneId}: ${err.message}`);
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // ─────────────────────────────────────────────────────────
    // Detecção de resposta positiva (baseado no guia)
    // ─────────────────────────────────────────────────────────

    _detectarRespostaPositiva(texto) {
        const palavrasPositivas = [
            'sim', 'claro', 'ok', 'tudo bem', 'pode ser', 'vamos',
            'topa', 'interessado', 'gostei', 'legal', 'ótimo', 'ótima',
            'perfeito', 'pode mandar', 'com certeza', 'quero', 'adorei',
            'aceito', 'combinado', 'fechou', 'pode agendar', 'marcar'
        ];
        const msg = String(texto || '').toLowerCase();
        return palavrasPositivas.some(p => msg.includes(p));
    }

    // ─────────────────────────────────────────────────────────
    // Sugestão de próxima ação (baseado no guia's suggestNextAction)
    // ─────────────────────────────────────────────────────────

    _sugerirProximaAcao(analise, texto) {
        const msg = String(texto || '').toLowerCase();
        if (analise.tipo === 'resposta_positiva' || msg.includes('interessado') || msg.includes('agendar')) {
            return 'Agendar Reunião';
        }
        if (analise.tipo === 'objeção' || msg.includes('não') || msg.includes('nao')) {
            return 'Tratar Objeção';
        }
        if (analise.proximidadeICP === 'alto') {
            return 'Aprofundar Qualificação';
        }
        return 'Aguardar Resposta';
    }

    // ─────────────────────────────────────────────────────────
    // Atualiza métricas na aba ANÁLISE (baseado no guia's updateAnalytics)
    // ─────────────────────────────────────────────────────────

    async _atualizarAnalytics(leadId, analise) {
        try {
            const interacoes = await crmSheets.getManyByLeadId(CRM_TABS.INTERACOES, leadId);
            const totalMsgs = interacoes.length;
            const respostas = interacoes.filter(m =>
                String(m['tipo_contato'] || '').toLowerCase().includes('recebida')
            ).length;
            const taxa = totalMsgs > 0 ? Math.round((respostas / totalMsgs) * 100) : 0;

            // Append a summary row (sheet can be reviewed for latest entry per lead)
            await crmSheets.appendRow(CRM_TABS.ANALISE, {
                lead_id: leadId,
                total_mensagens: totalMsgs,
                total_respostas: respostas,
                taxa_resposta_pct: taxa,
                sentimento: analise?.sentimento || '',
                proximidade_icp: analise?.proximidadeICP || '',
                ultimo_contato: new Date().toLocaleDateString('pt-BR'),
                ultima_atualizacao: new Date().toISOString()
            });
        } catch (err) {
            logger.warn(`[SDR IA] _atualizarAnalytics falhou para ${leadId}: ${err.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────
    // Processa fila de mensagens enfileiradas por rate limit (pós-reconexão)
    // ─────────────────────────────────────────────────────────

    async _processarFilaEnfileirada() {
        await securityValidator.processFila(async (telefoneId, mensagem) => {
            await this._simulateTypingDelay(telefoneId, mensagem);
            await this.whatsapp.sendMessage(telefoneId, mensagem);
            logger.info(`[SDR IA] ✅ Mensagem da fila enviada para ${telefoneId}`);
        });
    }

    async _handleRemoteCommand(msg) {
        const senderIsAdmin = remoteControl.isAdmin(msg.from);
        if (!senderIsAdmin) return false;

        const body = String(msg.body || '').trim();
        if (!body.toLowerCase().startsWith('!sdr')) return false;

        await remoteControl.handleCommand({
            from: msg.from,
            body,
            sendReply: async (reply) => this.whatsapp.sendMessage(msg.from, reply),
            broadcast: async (message) => remoteControl.broadcastAdminMessage(this.whatsapp, message)
        });

        logger.info(`[SDR IA] Comando remoto executado por ${msg.from}: ${body}`);
        return true;
    }

    _isRemoteControlEnabled() {
        return env.SDR_REMOTE_CONTROL_ENABLED && remoteControl.isEnabled();
    }

    async _notifyCallIfNeeded({ telefoneNumero, leadNome, textoEntrada, analise }) {
        if (!this._isRemoteControlEnabled()) return;

        const shouldNotify = remoteControl.shouldNotifyCall({
            text: textoEntrada,
            analysis: analise,
            lead: { numero: telefoneNumero, nome: leadNome }
        });

        if (!shouldNotify) return;

        await remoteControl.notifyCallNeeded({
            whatsappClient: this.whatsapp,
            lead: { numero: telefoneNumero, nome: leadNome },
            text: textoEntrada,
            analysis: analise,
            reason: 'lead_needs_call'
        });
    }

    async _maybeNotifyCallOnlyMode(telefoneId, corpo, nomeRemetente, mensagemObj) {
        try {
            const texto = String(corpo || '').trim();
            if (!texto && !mensagemObj?.hasMedia) return;

            const leadNumero = telefoneId.replace('@c.us', '').replace(/\D/g, '');
            const shouldNotify = remoteControl.shouldNotifyCall({
                text: texto,
                analysis: { tipo: '' },
                lead: { numero: leadNumero, nome: nomeRemetente }
            });

            if (!shouldNotify) return;

            await remoteControl.notifyCallNeeded({
                whatsappClient: this.whatsapp,
                lead: { numero: leadNumero, nome: nomeRemetente },
                text: texto,
                analysis: { sentimento: 'n/a', objecao: 'n/a' },
                reason: 'automation_paused_call_alert'
            });
        } catch (err) {
            logger.warn(`[SDR IA] Falha ao avaliar notificacao de ligacao em modo pausado: ${err.message}`);
        }
    }
}

module.exports = new SDRWhatsAppSystem();
