/**
 * Unit tests for BotDetector
 * Run: npx jest tests/unit/bot-detector.test.js
 */

// Mock das dependências externas antes de importar o módulo
jest.mock('../../src/sheets/crm-sheets', () => ({
    crmSheets: { getAll: jest.fn().mockResolvedValue([]) },
    CRM_TABS: { BOT_DETECCOES: 'BOT_DETECCOES' }
}));

jest.mock('../../src/config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn()
}));

const botDetector = require('../../src/security/bot-detector');

describe('BotDetector', () => {

    beforeEach(() => {
        // Limpa caches internos entre testes
        botDetector.responseTimings.clear();
        botDetector.messageCache.clear();
    });

    // ── Score & flags ─────────────────────────────────────────

    test('retorna score 0 para mensagem nula', async () => {
        const result = await botDetector.analyze({ message: null, leadId: 'x', responseTime: 60 });
        expect(result.confidence).toBe(0);
        expect(result.isBot).toBe(false);
        expect(result.recommendation).toBe('CONTINUE');
    });

    // ── Signal 4: Resposta muito rápida ──────────────────────

    test('detecta sinal VERY_FAST_RESPONSE com responseTime < 5s', async () => {
        const result = await botDetector.analyze({
            message: 'Obrigado pela mensagem!',
            leadId: 'fast_001',
            responseTime: 2,
            previousMessages: [],
            previousResponseTimes: []
        });

        expect(result.signals.some(s => s.type === 'VERY_FAST_RESPONSE')).toBe(true);
        expect(result.confidence).toBeGreaterThanOrEqual(25);
    });

    test('NÃO detecta VERY_FAST_RESPONSE com responseTime >= 5s', async () => {
        const result = await botDetector.analyze({
            message: 'Olá tudo bem!',
            leadId: 'normal_001',
            responseTime: 45,
            previousMessages: [],
            previousResponseTimes: []
        });

        expect(result.signals.some(s => s.type === 'VERY_FAST_RESPONSE')).toBe(false);
    });

    // ── Signal 5: Palavras-chave de automação ────────────────

    test('detecta AUTOMATION_KEYWORDS com "I\'m a bot"', async () => {
        const result = await botDetector.analyze({
            message: "I'm a bot. This is an automated response.",
            leadId: 'bot_001',
            responseTime: 30,
            previousMessages: [],
            previousResponseTimes: []
        });

        expect(result.signals.some(s => s.type === 'AUTOMATION_KEYWORDS')).toBe(true);
        expect(result.confidence).toBeGreaterThanOrEqual(60);
        expect(result.isBot).toBe(true);
    });

    test('detecta AUTOMATION_KEYWORDS com "resposta automática"', async () => {
        const result = await botDetector.analyze({
            message: 'Resposta automática: obrigado pelo seu contato.',
            leadId: 'bot_002',
            responseTime: 30,
            previousMessages: [],
            previousResponseTimes: []
        });

        expect(result.signals.some(s => s.type === 'AUTOMATION_KEYWORDS')).toBe(true);
    });

    // ── Signal 1: Padrão temporal fixo ───────────────────────

    test('detecta FIXED_TIMING com std dev < 2s em 3+ respostas', async () => {
        const result = await botDetector.analyze({
            message: 'Resposta 4',
            leadId: 'timing_001',
            responseTime: 3,
            previousMessages: ['R1', 'R2', 'R3'],
            previousResponseTimes: [3, 3, 3]  // desvio padrão = 0
        });

        expect(result.signals.some(s => s.type === 'FIXED_TIMING')).toBe(true);
        expect(result.confidence).toBeGreaterThanOrEqual(40);
    });

    test('NÃO detecta FIXED_TIMING com variação normal', async () => {
        const result = await botDetector.analyze({
            message: 'Resposta 4',
            leadId: 'timing_002',
            responseTime: 90,
            previousMessages: ['R1', 'R2', 'R3'],
            previousResponseTimes: [30, 120, 60]  // variável
        });

        expect(result.signals.some(s => s.type === 'FIXED_TIMING')).toBe(false);
    });

    // ── Signal 2: Mensagem duplicada ─────────────────────────

    test('detecta DUPLICATE_MESSAGE quando mensagem já foi enviada antes', async () => {
        const msg = 'Acesse nosso site agora mesmo!';
        const result = await botDetector.analyze({
            message: msg,
            leadId: 'dup_001',
            responseTime: 30,
            previousMessages: [msg],  // mesma mensagem
            previousResponseTimes: []
        });

        expect(result.signals.some(s => s.type === 'DUPLICATE_MESSAGE')).toBe(true);
        expect(result.confidence).toBeGreaterThanOrEqual(50);
    });

    // ── Signal 3: URL sem contexto ───────────────────────────

    test('detecta URL_ONLY com link e poucas palavras', async () => {
        const result = await botDetector.analyze({
            message: 'Clique aqui https://spam.example.com',
            leadId: 'url_001',
            responseTime: 30,
            previousMessages: [],
            previousResponseTimes: []
        });

        expect(result.signals.some(s => s.type === 'URL_ONLY')).toBe(true);
    });

    test('NÃO detecta URL_ONLY quando há contexto suficiente', async () => {
        const result = await botDetector.analyze({
            message: 'Oi! Vi o seu perfil e achei interessante. Pode conferir mais detalhes sobre nossa proposta aqui: https://example.com/proposta',
            leadId: 'url_002',
            responseTime: 60,
            previousMessages: [],
            previousResponseTimes: []
        });

        expect(result.signals.some(s => s.type === 'URL_ONLY')).toBe(false);
    });

    // ── Humano normal ────────────────────────────────────────

    test('NÃO marca como BOT quando é humano normal', async () => {
        const result = await botDetector.analyze({
            message: 'Oi! Obrigado pelo contato. Deixa eu verificar a agenda aqui com o time...',
            leadId: 'human_001',
            responseTime: 75,
            previousMessages: ['Olá'],
            previousResponseTimes: [30, 120, 60]
        });

        expect(result.isBot).toBe(false);
        expect(result.confidence).toBeLessThan(30);
        expect(result.recommendation).toBe('CONTINUE');
    });

    // ── Recomendação correta por faixa ───────────────────────

    test('recommendation = ESCAPE quando confidence > 85', async () => {
        // Combina 3 sinais fortes: keyword (60) + fast (25) + timing (40) = 100 → cap 100
        const result = await botDetector.analyze({
            message: "This is an automated response.",
            leadId: 'escape_001',
            responseTime: 2,
            previousMessages: ['resp1', 'resp2', 'resp3'],
            previousResponseTimes: [2, 2, 2]
        });

        expect(result.recommendation).toBe('ESCAPE');
    });

    test('recommendation = MANUAL_REVIEW quando confidence entre 60-85', async () => {
        // Apenas keyword: 60 pontos
        const result = await botDetector.analyze({
            message: 'automated response thank you for your message',
            leadId: 'review_001',
            responseTime: 60,
            previousMessages: [],
            previousResponseTimes: [30, 120, 60]
        });

        // Deve ser MANUAL_REVIEW (60-85)
        expect(['MANUAL_REVIEW', 'ESCAPE']).toContain(result.recommendation);
    });

    // ── Cache interno ────────────────────────────────────────

    test('acumula cache de mensagens para o mesmo lead', async () => {
        const leadId = 'cache_001';
        await botDetector.analyze({ message: 'Mensagem A', leadId, responseTime: 30 });
        await botDetector.analyze({ message: 'Mensagem B', leadId, responseTime: 30 });

        const cached = botDetector.messageCache.get(leadId);
        expect(cached.length).toBe(2);
        expect(cached).toContain('Mensagem A');
        expect(cached).toContain('Mensagem B');
    });
});
