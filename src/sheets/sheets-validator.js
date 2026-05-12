'use strict';

/**
 * SheetsValidator
 * Small helper around GoogleSheetsClient for sheet-level operations.
 */

const { GoogleSheetsClient } = require('./client');
const logger = require('../config/logger');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

const REQUIRED_CONFIGS = [
    'Max_Mensagens_Por_Minuto',
    'Max_Mensagens_Por_Hora',
    'Max_Mensagens_Por_Dia',
    'Min_Intervalo_Entre_Contatos'
];

const EXPECTED_TABS = [
    { name: 'ALERTAS', createWith: null, alt: 'ALERTA', renameFrom: 'ALERTA', renameTo: 'ALERTAS' },
    { name: 'BOT_DETECCOES', createWith: null, alt: 'BOT_DETECCAO', renameFrom: 'BOT_DETECCAO', renameTo: 'BOT_DETECCOES' },
    { name: 'PENSAMENTO_IA', createWith: ['id', 'timestamp', 'tipo', 'conteudo', 'lead_id', 'resultado'] },
    { name: 'SEGURANÇA', createWith: ['lead_id', 'nome_lead', 'status_final', 'data_finalizacao', 'motivo', 'bloqueado', 'data_bloqueio', 'razao_bloqueio', 'token_seguranca', 'nota'] },
    { name: 'RATE_LIMIT', createWith: ['timestamp', 'lead_id', 'tipo_mensagem', 'tempo_desde_ultima', 'mensagens_ultima_hora', 'mensagens_ultimo_dia', 'status_rate', 'permitido', 'motivo_bloqueio', 'acao_tomada'] },
    { name: 'CONFIGURAÇÕES', createWith: null }
];

class SheetsValidator {
    constructor(client = new GoogleSheetsClient()) {
        this.client = client;
    }

    async _sheetExists(sheetName) {
        try {
            await this.client.getRange(`${sheetName}!A1`);
            return true;
        } catch (err) {
            return false;
        }
    }

    async _promptAutoFix(confirmAutoFix, question) {
        if (typeof confirmAutoFix === 'function') {
            return Boolean(await confirmAutoFix(question));
        }

        if (!input.isTTY || !output.isTTY) {
            return false;
        }

        const rl = readline.createInterface({ input, output });
        try {
            const answer = await rl.question(`${question} (s/n): `);
            return /^s|^y/i.test(String(answer || '').trim());
        } finally {
            rl.close();
        }
    }

    /**
     * Rename a sheet tab using the Google Sheets API batchUpdate method.
     * @param {string} oldName
     * @param {string} newName
     * @returns {Promise<boolean>}
     */
    async renameSheet(oldName, newName) {
        try {
            logger.info(`[SheetsValidator] Renaming sheet "${oldName}" to "${newName}"`);
            return await this.client.renameSheet(oldName, newName);
        } catch (err) {
            logger.info(`[SheetsValidator] Failed to rename sheet "${oldName}" to "${newName}": ${err.message}`);
            return false;
        }
    }

    /**
     * Create a new sheet tab and seed the first row with headers.
     * @param {string} sheetName
     * @param {Array<string>} headers
     * @returns {Promise<boolean>}
     */
    async createSheet(sheetName, headers) {
        try {
            const success = await this.client.createSheet(sheetName, headers);
            if (success) {
                logger.info(`[SheetsValidator] Created sheet "${sheetName}" with ${Array.isArray(headers) ? headers.length : 0} header(s)`);
            }
            return success;
        } catch (err) {
            logger.info(`[SheetsValidator] Failed to create sheet "${sheetName}": ${err.message}`);
            return false;
        }
    }

    /**
     * Applies the repository's sheet naming and bootstrap fixes.
     * @returns {Promise<Array<string>>}
     */
    async autoFix() {
        const fixedIssues = [];

        const alertaExists = await this._sheetExists('ALERTA');
        if (alertaExists) {
            const renamed = await this.renameSheet('ALERTA', 'ALERTAS');
            if (renamed) {
                fixedIssues.push('Renomeada aba ALERTA para ALERTAS');
            }
        }

        const botDetectionExists = await this._sheetExists('BOT_DETECCAO');
        if (botDetectionExists) {
            const renamed = await this.renameSheet('BOT_DETECCAO', 'BOT_DETECCOES');
            if (renamed) {
                fixedIssues.push('Renomeada aba BOT_DETECCAO para BOT_DETECCOES');
            }
        }

        const pensamentoExists = await this._sheetExists('PENSAMENTO_IA');
        if (!pensamentoExists) {
            const created = await this.createSheet('PENSAMENTO_IA', [
                'id',
                'timestamp',
                'tipo',
                'conteudo',
                'lead_id',
                'resultado'
            ]);
            if (created) {
                fixedIssues.push('Criada aba PENSAMENTO_IA');
            }
        }

        const segurancaExists = await this._sheetExists('SEGURANÇA');
        if (!segurancaExists) {
            const created = await this.createSheet('SEGURANÇA', [
                'lead_id',
                'nome_lead',
                'status_final',
                'data_finalizacao',
                'motivo',
                'bloqueado',
                'data_bloqueio',
                'razao_bloqueio',
                'token_seguranca',
                'nota'
            ]);
            if (created) {
                fixedIssues.push('Criada aba SEGURANÇA');
            }
        }

        const rateLimitExists = await this._sheetExists('RATE_LIMIT');
        if (!rateLimitExists) {
            const created = await this.createSheet('RATE_LIMIT', [
                'timestamp',
                'lead_id',
                'tipo_mensagem',
                'tempo_desde_ultima',
                'mensagens_ultima_hora',
                'mensagens_ultimo_dia',
                'status_rate',
                'permitido',
                'motivo_bloqueio',
                'acao_tomada'
            ]);
            if (created) {
                fixedIssues.push('Criada aba RATE_LIMIT');
            }
        }

        logger.info(`[SheetsValidator] autoFix finalizado com ${fixedIssues.length} correção(ões)`);
        return fixedIssues;
    }

    /**
     * Validates the CONFIGURAÇÕES sheet and reports missing/empty/invalid values.
     * @returns {Promise<{isValid: boolean, missing: string[], empty: string[], errors: string[], recommendations: string[]}>}
     */
    async validateAndFillConfigurations() {
        const result = {
            isValid: true,
            missing: [],
            empty: [],
            errors: [],
            recommendations: []
        };

        const configSheetExists = await this._sheetExists('CONFIGURAÇÕES');
        if (!configSheetExists) {
            result.isValid = false;
            result.missing = [...REQUIRED_CONFIGS];
            result.errors.push('Aba CONFIGURAÇÕES ausente');
            result.recommendations.push('Criar a aba CONFIGURAÇÕES com as configurações obrigatórias em A:B');
            return result;
        }

        let rows = [];
        try {
            rows = await this.client.getRange('CONFIGURAÇÕES!A:B');
        } catch (err) {
            result.isValid = false;
            result.errors.push(`Falha ao ler a aba CONFIGURAÇÕES: ${err.message}`);
            result.recommendations.push('Verificar permissões e a existência da aba CONFIGURAÇÕES');
            return result;
        }

        const configMap = new Map();
        for (const row of rows || []) {
            const key = String(row?.[0] || '').trim();
            const value = row?.length > 1 ? row[1] : '';

            if (!key) continue;
            if (/^(chave|config|configuracao|configuração|valor|value)$/i.test(key)) continue;

            configMap.set(key, value);
        }

        for (const configName of REQUIRED_CONFIGS) {
            if (!configMap.has(configName)) {
                result.isValid = false;
                result.missing.push(configName);
                result.errors.push(`Aviso: configuração ausente ${configName}`);
                continue;
            }

            const rawValue = configMap.get(configName);
            const valueText = String(rawValue ?? '').trim();

            if (!valueText) {
                result.isValid = false;
                result.empty.push(configName);
                result.errors.push(`Crítico: configuração vazia em ${configName}`);
                continue;
            }

            const numericValue = Number(valueText.replace(',', '.'));
            if (!Number.isFinite(numericValue)) {
                result.isValid = false;
                result.errors.push(`Erro: ${configName} deve ser numérico`);
            }
        }

        if (result.missing.length > 0) {
            result.recommendations.push('Adicionar as configurações faltantes na aba CONFIGURAÇÕES');
        }

        if (result.empty.length > 0) {
            result.recommendations.push('Preencher imediatamente as células vazias da coluna B em CONFIGURAÇÕES');
        }

        return result;
    }

    _buildValidationSummary(validationResult, missingTabs = []) {
        const successes = [];
        const warnings = [];
        const errors = [];

        if (validationResult?.isValid) {
            successes.push('✅ CONFIGURAÇÕES válidas');
        }

        for (const configName of validationResult?.missing || []) {
            warnings.push(`🟡 Configuração ausente: ${configName}`);
        }

        for (const configName of validationResult?.empty || []) {
            errors.push(`❌ Configuração vazia: ${configName}`);
        }

        for (const message of validationResult?.errors || []) {
            if (message.startsWith('Aviso:')) {
                warnings.push(`🟡 ${message.replace(/^Aviso:\s*/, '')}`);
            } else if (message.startsWith('Crítico:') || message.startsWith('Erro:')) {
                errors.push(`❌ ${message.replace(/^(Crítico:|Erro:)\s*/, '')}`);
            } else {
                errors.push(`❌ ${message}`);
            }
        }

        for (const tabName of missingTabs) {
            warnings.push(`🟡 Aba ausente detectada: ${tabName}`);
        }

        return { successes, warnings, errors };
    }

    _renderFinalReport({ successes, warnings, errors, fixedIssues }) {
        const lines = [];

        if (successes.length > 0) {
            lines.push('✅ Validações bem-sucedidas');
            for (const item of successes) {
                lines.push(`  - ${item}`);
            }
        }

        if (warnings.length > 0) {
            lines.push('🟡 Avisos');
            for (const item of warnings) {
                lines.push(`  - ${item}`);
            }
        }

        if (errors.length > 0) {
            lines.push('❌ Erros críticos');
            for (const item of errors) {
                lines.push(`  - ${item}`);
            }
        }

        if (fixedIssues.length > 0) {
            lines.push('🔧 Problemas corrigidos automaticamente');
            for (const item of fixedIssues) {
                lines.push(`  - ${item}`);
            }
        }

        return lines.join('\n');
    }

    async _diagnoseTabs() {
        const missingTabs = [];
        const recommendations = [];

        for (const tab of EXPECTED_TABS) {
            const exists = await this._sheetExists(tab.name);
            if (!exists) {
                missingTabs.push(tab.name);
                recommendations.push(`Criar a aba ${tab.name}${Array.isArray(tab.createWith) && tab.createWith.length > 0 ? ' com os headers padrão' : ''}`);
            }
        }

        return { missingTabs, recommendations };
    }

    /**
     * Runs a full validation pass, optionally auto-fixing detected issues.
     * @param {Object} [options]
     * @param {Function} [options.confirmAutoFix] - async (question) => boolean
     * @returns {Promise<Object>}
     */
    async validate(options = {}) {
        const validationResult = await this.validateAndFillConfigurations();
        const tabDiagnosis = await this._diagnoseTabs();
        const summaryBeforeFix = this._buildValidationSummary(validationResult, tabDiagnosis.missingTabs);

        const fixedIssues = [];
        const hasProblems = summaryBeforeFix.warnings.length > 0 || summaryBeforeFix.errors.length > 0;

        if (hasProblems) {
            logger.warn('[SheetsValidator] Problemas encontrados na validação inicial');

            const shouldAutoFix = await this._promptAutoFix(
                options.confirmAutoFix,
                'Deseja corrigir automaticamente os problemas detectados?'
            );

            if (shouldAutoFix) {
                const autoFixResults = await this.autoFix();
                fixedIssues.push(...autoFixResults);

                const validationAfterFix = await this.validateAndFillConfigurations();
                const tabDiagnosisAfterFix = await this._diagnoseTabs();
                const finalSummary = this._buildValidationSummary(validationAfterFix, tabDiagnosisAfterFix.missingTabs);

                const allClean = finalSummary.errors.length === 0;
                const report = {
                    isValid: allClean,
                    successes: finalSummary.successes,
                    warnings: finalSummary.warnings,
                    errors: finalSummary.errors,
                    fixedIssues,
                    recommendations: validationAfterFix.recommendations.concat(tabDiagnosisAfterFix.recommendations),
                    report: this._renderFinalReport({
                        successes: finalSummary.successes,
                        warnings: finalSummary.warnings,
                        errors: finalSummary.errors,
                        fixedIssues
                    })
                };

                if (report.isValid) {
                    logger.info('[SheetsValidator] ✅ Tudo OK após auto-correção');
                } else {
                    logger.warn('[SheetsValidator] Validação concluída com pendências após auto-correção');
                }

                logger.info(report.report);
                return report;
            }
        }

        const report = {
            isValid: summaryBeforeFix.errors.length === 0,
            successes: summaryBeforeFix.successes,
            warnings: summaryBeforeFix.warnings,
            errors: summaryBeforeFix.errors,
            fixedIssues,
            recommendations: validationResult.recommendations.concat(tabDiagnosis.recommendations),
            report: this._renderFinalReport({
                successes: summaryBeforeFix.successes,
                warnings: summaryBeforeFix.warnings,
                errors: summaryBeforeFix.errors,
                fixedIssues
            })
        };

        if (report.isValid) {
            logger.info('[SheetsValidator] ✅ Validação concluída com sucesso');
        } else {
            logger.warn('[SheetsValidator] Validação concluída com avisos ou erros');
        }

        logger.info(report.report);
        return report;
    }
}

module.exports = { SheetsValidator };