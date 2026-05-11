const {
    detectarFase,
    normalizeObjecao,
    getObjecaoContext,
    buildSdrContext
} = require('../../../src/openai/sdr-intelligence');

describe('sdr-intelligence', () => {
    describe('detectarFase', () => {
        test('prioriza fase salva valida', () => {
            const fase = detectarFase({ fase: 'fase_3_conversao', score: 10, historico: [] });
            expect(fase).toBe('fase_3_conversao');
        });

        test('mapeia fluxo com acento para fase correta', () => {
            const fase = detectarFase({ fluxo: 'Cenário 6' });
            expect(fase).toBe('fase_3_conversao');
        });

        test('usa heuristica por score e interacoes quando nao ha fluxo', () => {
            const fase = detectarFase({ score: 80, historico: [{}, {}] });
            expect(fase).toBe('fase_3_conversao');
        });
    });

    describe('normalizeObjecao', () => {
        test('normaliza variacoes para enviar_email', () => {
            expect(normalizeObjecao('Me mande por e-mail')).toBe('enviar_email');
            expect(normalizeObjecao('prefere EMAIL')).toBe('enviar_email');
        });

        test('normaliza variacoes para sem_budget', () => {
            expect(normalizeObjecao('Sem verba no momento')).toBe('sem_budget');
            expect(normalizeObjecao('sem orçamento')).toBe('sem_budget');
        });

        test('normaliza variacoes para sem_contacto', () => {
            expect(normalizeObjecao('não posso passar contato')).toBe('sem_contacto');
        });
    });

    describe('buildSdrContext', () => {
        test('inclui score, fase, contexto de objecao e anti-repeticao', () => {
            const context = buildSdrContext(
                {
                    fluxo: 'Cenário 2',
                    score: 67,
                    temperatura: 'Quente',
                    objecoes: ['prefere email']
                },
                { objecao: 'enviar_email' },
                '[ANTI] nao repetir ultima abertura'
            );

            expect(context).toContain('[SCORE DO LEAD: 67/100 | Temperatura: Quente]');
            expect(context).toContain('[FASE CONVERSACIONAL 2 - QUALIFICACAO]');
            expect(context).toContain('[OBJECAO: PREFERE EMAIL]');
            expect(context).toContain('OBJECOES ANTERIORES');
            expect(context).toContain('[ANTI] nao repetir ultima abertura');
        });

        test('getObjecaoContext retorna vazio para objecao desconhecida', () => {
            expect(getObjecaoContext('alguma_coisa_aleatoria')).toBe('');
        });
    });
});
