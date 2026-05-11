/**
 * Manager Analyzer
 * Reads Google Sheets daily data and analyzes project state
 */

const { GoogleSheetsClient } = require('../../sheets/client');
const { OpenAIMemory } = require('../../openai/memory');
const analysisLog = require('../../sheets/analysis-log');
const { SHEETS, AGENTS } = require('../../config/constants');
const logger = require('../../config/logger');

class ManagerAnalyzer {
    constructor() {
        this.sheets = new GoogleSheetsClient();
        this.memory = new OpenAIMemory();
    }

    /**
     * Full daily status analysis
     * Reads all 5 Sheets tabs and generates actionable analysis
     * @returns {Object} structured analysis result
     */
    async analyzeDailyStatus() {
        logger.info('📊 [Manager.Analyzer] Starting daily analysis...');

        // 1. Read all Sheets
        const [taskQueue, codeRepo, memBank, performance] = await Promise.all([
            this.sheets.getRange(`${SHEETS.TASK_QUEUE}!A:K`),
            this.sheets.getRange(`${SHEETS.CODE_REPO}!A:N`),
            this.sheets.getRange(`${SHEETS.MEMORY_BANK}!A:I`),
            this.sheets.getRange(`${SHEETS.PERFORMANCE}!A:I`)
        ]);

        // 2. Run contextual AI analysis
        const analysis = await this.memory.analyzeContext({
            taskQueue,
            codeRepo,
            memoryBank: memBank,
            performance,
            prompt: `
Analyze the current project state:
1. What tasks are pending/blocked?
2. How was yesterday's performance?
3. What patterns do you identify across all data?
4. What should be the next priority task?
5. Are there any blockers or risks?
Return structured JSON.
      `.trim()
        });

        // 3. Log to Analysis Log sheet
        await analysisLog.log({
            type: 'daily_status',
            agent: AGENTS.MANAGER,
            subject: 'Daily analysis cycle',
            discoveries: analysis.discoveries,
            recommendations: analysis.recommendations,
            confidence: analysis.confidence
        });

        logger.info('[Manager.Analyzer] Analysis complete');
        return analysis;
    }

    /**
     * Study a specific file from Code Repository
     * @param {string} filename
     * @returns {Object} code analysis result
     */
    async studyCode(filename) {
        logger.info(`[Manager.Analyzer] Studying: ${filename}`);

        const codeRepo = require('../../sheets/code-repo');
        const entry = await codeRepo.getByFilename(filename);

        if (!entry) {
            logger.warn(`[Manager.Analyzer] File not found in repo: ${filename}`);
            return null;
        }

        const fullCode = codeRepo.extractFullCode(entry);

        const analysis = await this.memory.analyzeCode({
            code: fullCode,
            filename,
            context: entry.dependencies,
            prompt: `
Analyze structure, improvements, patterns, and complexity.
Return JSON with: structure, improvements, patterns, complexity, next_steps.
      `.trim()
        });

        await analysisLog.log({
            type: 'code_review',
            agent: AGENTS.MANAGER,
            subject: filename,
            discoveries: analysis.patterns,
            recommendations: analysis.next_steps,
            confidence: 90,
            reference: entry.id
        });

        return analysis;
    }

    /**
     * Identify recurring patterns in Memory Bank
     * @returns {Object} patterns and insights
     */
    async identifyPatterns() {
        logger.info('[Manager.Analyzer] Identifying patterns...');
        const memBank = require('../../sheets/memory-bank');
        const recent = await memBank.getRecent(20);
        const aiAnalyzer = require('../../openai/analyzer');
        return aiAnalyzer.identifyPatterns({ memories: recent });
    }
}

module.exports = new ManagerAnalyzer();
