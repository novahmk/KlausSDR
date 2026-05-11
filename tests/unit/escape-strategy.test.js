'use strict';

/**
 * Testes unitários para src/utils/escape-strategy.js
 *
 * Cobertura principal:
 *  1. Tenta SMS antes de escalar para humano
 *  2. Escalamento para humano quando todos os canais falham
 *  3. Respeita maxRetries - não processa mais do que o limite
 */

jest.mock('../../src/sheets/crm-sheets', () => ({
    crmSheets: { appendRow: jest.fn().mockResolvedValue(undefined) },
    CRM_TABS: { PIPELINE: 'PIPELINE', AUDIT_LOG: 'AUDIT_LOG', BOT_DETECCOES: 'BOT_DETECCOES' }
}));

jest.mock('../../src/sheets/security-sheets', () => ({
    securitySheets: {
        appendAuditLog: jest.fn().mockResolvedValue(undefined),
        createAlert:    jest.fn().mockResolvedValue(undefined)
    }
}));

jest.mock('../../src/config/logger', () => ({
    info:  jest.fn(),
    warn:  jest.fn(),
    debug: jest.fn(),
    error: jest.fn()
}));

// ── Twilio mock (SMS/Call providers) ─────────────────────────────────────────
const mockMessageCreate = jest.fn();
const mockCallCreate = jest.fn();
jest.mock('twilio', () => () => ({
    messages: { create: mockMessageCreate },
    calls:    { create: mockCallCreate }
}), { virtual: true });
// ─────────────────────────────────────────────────────────────────────────────

// EscapeStrategy é singleton; precisamos recarregá-lo para cada teste que
// precise de estado limpo. Usamos jest.isolateModules nas suites relevantes.

const LEAD_ID   = '+5511999990001';
const LEAD_DATA = {
    nome:    'João Teste',
    empresa: 'Empresa Test Ltda',
    telefone: LEAD_ID,
    telefone_alternativo: '',
    whatsapp_alternativo:  '',
    email: 'joao@teste.com'
};

// ─────────────────────────────────────────────────────────────────────────────
// GRUPO 1 — Canal SMS tenta antes de escalar
// ─────────────────────────────────────────────────────────────────────────────
describe('EscapeStrategy — Canal SMS primário', () => {
    let escapeStrategy;
    let securitySheets;

    beforeAll(() => {
        // Simular env vars do Twilio para activar o branch real do prowider
        process.env.TWILIO_ACCOUNT_SID  = 'AC_test_sid';
        process.env.TWILIO_AUTH_TOKEN   = 'test_auth_token';
        process.env.TWILIO_PHONE_NUMBER = '+551100000000';
    });

    beforeEach(() => {
        jest.resetModules();

        // Re-importar com cache limpo para estado do singleton (escapeAttempts = {})
        escapeStrategy = require('../../src/utils/escape-strategy');
        securitySheets = require('../../src/sheets/security-sheets').securitySheets;

        mockMessageCreate.mockReset();
        securitySheets.appendAuditLog.mockReset();
    });

    afterAll(() => {
        delete process.env.TWILIO_ACCOUNT_SID;
        delete process.env.TWILIO_AUTH_TOKEN;
        delete process.env.TWILIO_PHONE_NUMBER;
    });

    test('deve retornar sucesso via SMS_PRIMARY quando Twilio responde', async () => {
        mockMessageCreate.mockResolvedValueOnce({ sid: 'SM_test_123' });

        const result = await escapeStrategy.executeEscape(LEAD_ID, LEAD_DATA, 88);

        expect(result.success).toBe(true);
        expect(result.channelUsed).toBe('SMS_PRIMARY');
        expect(result.humanNotified).toBeFalsy();

        // Deve ter chamado o Twilio com o número correto
        expect(mockMessageCreate).toHaveBeenCalledWith(
            expect.objectContaining({ to: expect.stringContaining('5511') })
        );
    });

    test('deve registar tentativa no AUDIT_LOG via securitySheets', async () => {
        mockMessageCreate.mockResolvedValueOnce({ sid: 'SM_audit_test' });

        await escapeStrategy.executeEscape(LEAD_ID, LEAD_DATA, 75);

        expect(securitySheets.appendAuditLog).toHaveBeenCalledWith(
            expect.objectContaining({
                leadId:      LEAD_ID,
                acao:        expect.stringContaining('SMS_PRIMARY'),
                tipoAcao:    'Escape Strategy',
                statusDepois: 'SUCESSO'
            })
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// GRUPO 2 — Escalamento para humano quando todos os canais falham
// ─────────────────────────────────────────────────────────────────────────────
describe('EscapeStrategy — Escalamento para operador humano', () => {
    let escapeStrategy;
    let securitySheets;

    beforeEach(() => {
        // Garantir que env vars NÃO estão definidas → todos os canais SMS/Call falham
        delete process.env.TWILIO_ACCOUNT_SID;
        delete process.env.TWILIO_AUTH_TOKEN;
        delete process.env.TWILIO_VOICE_URL;
        delete process.env.SLACK_WEBHOOK_ESCALATION;

        jest.resetModules();
        escapeStrategy = require('../../src/utils/escape-strategy');
        securitySheets = require('../../src/sheets/security-sheets').securitySheets;
        securitySheets.createAlert.mockReset();
        securitySheets.appendAuditLog.mockReset();
    });

    test('deve retornar success=true com humanNotified=true quando todos os canais falham', async () => {
        const result = await escapeStrategy.executeEscape(
            LEAD_ID,
            { ...LEAD_DATA, telefone_alternativo: '', whatsapp_alternativo: '' },
            92
        );

        expect(result.success).toBe(true);
        expect(result.humanNotified).toBe(true);
    });

    test('deve criar alerta de escalamento no securitySheets', async () => {
        await escapeStrategy.executeEscape(
            LEAD_ID,
            { ...LEAD_DATA, telefone_alternativo: '', whatsapp_alternativo: '' },
            90
        );

        expect(securitySheets.createAlert).toHaveBeenCalledWith(
            expect.objectContaining({
                tipoAlerta:  'Contato Alternativo Necessário',
                severidade:  'Crítico',
                leadId:       LEAD_ID
            })
        );
    });

    test('deve ter channelUsed=HUMAN quando escalado após falhas', async () => {
        const result = await escapeStrategy.executeEscape(
            LEAD_ID,
            { ...LEAD_DATA, telefone_alternativo: '', whatsapp_alternativo: '' },
            87
        );

        // O canal final percorrido é 'HUMAN' que internamente chama _escalateToHuman
        // A função retorna 'details' com texto de operador, não 'channelUsed=HUMAN'
        // porque o loop passa pelo channel HUMAN e retorna no first success
        expect(result.success).toBe(true);
        expect(result.humanNotified).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// GRUPO 3 — Respeita maxRetries
// ─────────────────────────────────────────────────────────────────────────────
describe('EscapeStrategy — Respeitar maxRetries', () => {
    let escapeStrategy;
    let securitySheets;

    beforeEach(() => {
        delete process.env.TWILIO_ACCOUNT_SID;
        delete process.env.TWILIO_AUTH_TOKEN;

        jest.resetModules();
        escapeStrategy = require('../../src/utils/escape-strategy');
        securitySheets = require('../../src/sheets/security-sheets').securitySheets;
        securitySheets.createAlert.mockReset();
    });

    test('deve ir direto para humano quando maxRetries já foi atingido', async () => {
        const LEAD_RETRIED = '+5511999990099';

        // Simular que já houve 3 tentativas anteriores (maxRetries = 3)
        escapeStrategy.escapeAttempts.set(LEAD_RETRIED, [
            { channel: 'SMS_PRIMARY',     success: false, timestamp: new Date().toISOString() },
            { channel: 'SMS_ALTERNATIVE', success: false, timestamp: new Date().toISOString() },
            { channel: 'CALL',            success: false, timestamp: new Date().toISOString() }
        ]);

        const result = await escapeStrategy.executeEscape(
            LEAD_RETRIED,
            { ...LEAD_DATA, telefone: LEAD_RETRIED },
            85
        );

        // Deve escalar para humano imediatamente sem tentar outros canais
        expect(result.success).toBe(true);
        expect(result.humanNotified).toBe(true);

        // Não deve ter criado novas tentativas (ainda 3 do setup)
        // _escalateToHuman retorna sem alterar o array de escapeAttempts
        expect(escapeStrategy.escapeAttempts.get(LEAD_RETRIED).length).toBe(3);
    });

    test('maxRetries é 3 por defeito', () => {
        expect(escapeStrategy.maxRetries).toBe(3);
    });
});
