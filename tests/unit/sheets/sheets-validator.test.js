jest.mock('../../../src/sheets/client', () => ({
    GoogleSheetsClient: jest.fn().mockImplementation(() => ({
        renameSheet: jest.fn(),
        createSheet: jest.fn(),
        getRange: jest.fn()
    }))
}));

jest.mock('../../../src/config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn()
}));

const { SheetsValidator } = require('../../../src/sheets/sheets-validator');
const { GoogleSheetsClient } = require('../../../src/sheets/client');

describe('SheetsValidator', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renameSheet retorna true quando o cliente confirma a renomeação', async () => {
        const validator = new SheetsValidator();
        GoogleSheetsClient.mock.results[0].value.renameSheet.mockResolvedValue(true);

        await expect(validator.renameSheet('LEADS', 'LEADS_2026')).resolves.toBe(true);
        expect(GoogleSheetsClient.mock.results[0].value.renameSheet).toHaveBeenCalledWith('LEADS', 'LEADS_2026');
    });

    test('renameSheet retorna false quando o cliente falha', async () => {
        const validator = new SheetsValidator();
        GoogleSheetsClient.mock.results[0].value.renameSheet.mockResolvedValue(false);

        await expect(validator.renameSheet('LEADS', 'LEADS_2026')).resolves.toBe(false);
    });

    test('createSheet retorna true quando o cliente confirma a criação', async () => {
        const validator = new SheetsValidator();
        GoogleSheetsClient.mock.results[0].value.createSheet.mockResolvedValue(true);

        await expect(validator.createSheet('NOVA_ABA', ['id', 'nome'])).resolves.toBe(true);
        expect(GoogleSheetsClient.mock.results[0].value.createSheet).toHaveBeenCalledWith('NOVA_ABA', ['id', 'nome']);
    });

    test('createSheet retorna false quando o cliente falha', async () => {
        const validator = new SheetsValidator();
        GoogleSheetsClient.mock.results[0].value.createSheet.mockResolvedValue(false);

        await expect(validator.createSheet('NOVA_ABA', ['id', 'nome'])).resolves.toBe(false);
    });

    test('autoFix corrige renomes e cria abas ausentes', async () => {
        const validator = new SheetsValidator();
        const client = GoogleSheetsClient.mock.results[0].value;

        client.getRange.mockImplementation(async (range) => {
            if (range.startsWith('ALERTA!') || range.startsWith('BOT_DETECCAO!')) {
                return [['x']];
            }

            throw new Error('Sheet not found');
        });

        client.renameSheet.mockResolvedValue(true);
        client.createSheet.mockResolvedValue(true);

        await expect(validator.autoFix()).resolves.toEqual([
            'Renomeada aba ALERTA para ALERTAS',
            'Renomeada aba BOT_DETECCAO para BOT_DETECCOES',
            'Criada aba PENSAMENTO_IA',
            'Criada aba SEGURANÇA',
            'Criada aba RATE_LIMIT'
        ]);

        expect(client.renameSheet).toHaveBeenCalledWith('ALERTA', 'ALERTAS');
        expect(client.renameSheet).toHaveBeenCalledWith('BOT_DETECCAO', 'BOT_DETECCOES');
        expect(client.createSheet).toHaveBeenCalledWith('PENSAMENTO_IA', ['id', 'timestamp', 'tipo', 'conteudo', 'lead_id', 'resultado']);
        expect(client.createSheet).toHaveBeenCalledWith('SEGURANÇA', ['lead_id', 'nome_lead', 'status_final', 'data_finalizacao', 'motivo', 'bloqueado', 'data_bloqueio', 'razao_bloqueio', 'token_seguranca', 'nota']);
        expect(client.createSheet).toHaveBeenCalledWith('RATE_LIMIT', ['timestamp', 'lead_id', 'tipo_mensagem', 'tempo_desde_ultima', 'mensagens_ultima_hora', 'mensagens_ultimo_dia', 'status_rate', 'permitido', 'motivo_bloqueio', 'acao_tomada']);
    });

    test('validateAndFillConfigurations detecta aba ausente e recomenda criação', async () => {
        const validator = new SheetsValidator();
        const client = GoogleSheetsClient.mock.results[0].value;

        client.getRange.mockImplementation(async () => {
            throw new Error('Sheet not found');
        });

        await expect(validator.validateAndFillConfigurations()).resolves.toEqual({
            isValid: false,
            missing: [
                'Max_Mensagens_Por_Minuto',
                'Max_Mensagens_Por_Hora',
                'Max_Mensagens_Por_Dia',
                'Min_Intervalo_Entre_Contatos'
            ],
            empty: [],
            errors: ['Aba CONFIGURAÇÕES ausente'],
            recommendations: ['Criar a aba CONFIGURAÇÕES com as configurações obrigatórias em A:B']
        });
    });

    test('validateAndFillConfigurations detecta vazio e valor não numérico', async () => {
        const validator = new SheetsValidator();
        const client = GoogleSheetsClient.mock.results[0].value;

        client.getRange.mockImplementation(async (range) => {
            if (range === 'CONFIGURAÇÕES!A1') {
                return [['ok']];
            }

            return [
                ['Chave', 'Valor'],
                ['Max_Mensagens_Por_Minuto', '2'],
                ['Max_Mensagens_Por_Hora', ''],
                ['Max_Mensagens_Por_Dia', 'dez'],
                ['Min_Intervalo_Entre_Contatos', '30']
            ];
        });

        await expect(validator.validateAndFillConfigurations()).resolves.toMatchObject({
            isValid: false,
            missing: [],
            empty: ['Max_Mensagens_Por_Hora'],
            errors: [
                'Crítico: configuração vazia em Max_Mensagens_Por_Hora',
                'Erro: Max_Mensagens_Por_Dia deve ser numérico'
            ]
        });
    });

    test('validate executa diagnóstico, autoFix e revalidação quando confirmado', async () => {
        const validator = new SheetsValidator();
        const client = GoogleSheetsClient.mock.results[0].value;
        const availableTabs = new Set(['ALERTA', 'BOT_DETECCAO']);

        client.renameSheet.mockImplementation(async (oldName, newName) => {
            availableTabs.delete(oldName);
            availableTabs.add(newName);
            return true;
        });

        client.createSheet.mockImplementation(async (sheetName) => {
            availableTabs.add(sheetName);
            return true;
        });

        client.getRange.mockImplementation(async (range) => {
            if (range === 'CONFIGURAÇÕES!A1') {
                return [['ok']];
            }

            if (range === 'CONFIGURAÇÕES!A:B') {
                return [
                    ['Chave', 'Valor'],
                    ['Max_Mensagens_Por_Minuto', '2'],
                    ['Max_Mensagens_Por_Hora', '10'],
                    ['Max_Mensagens_Por_Dia', '50'],
                    ['Min_Intervalo_Entre_Contatos', '30']
                ];
            }

            if (range === 'ALERTA!A1' || range === 'BOT_DETECCAO!A1') {
                if (availableTabs.has(range.split('!')[0])) {
                    return [['x']];
                }

                throw new Error('Sheet not found');
            }

            if (availableTabs.has(range.split('!')[0])) {
                return [['x']];
            }

            if (range === 'PENSAMENTO_IA!A1' || range === 'SEGURANÇA!A1' || range === 'RATE_LIMIT!A1') {
                throw new Error('Sheet not found');
            }

            throw new Error('Sheet not found');
        });

        client.renameSheet.mockResolvedValue(true);
        client.createSheet.mockResolvedValue(true);

        await expect(validator.validate({ confirmAutoFix: async () => true })).resolves.toMatchObject({
            isValid: true,
            fixedIssues: [
                'Renomeada aba ALERTA para ALERTAS',
                'Renomeada aba BOT_DETECCAO para BOT_DETECCOES',
                'Criada aba PENSAMENTO_IA',
                'Criada aba SEGURANÇA',
                'Criada aba RATE_LIMIT'
            ]
        });
    });
});