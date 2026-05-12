/* DEPRECATED — Não utilizado no fluxo SDR ativo.
 * Este arquivo foi parte do ciclo multi-agente Manager/Attendant (código-gerador).
 * O fluxo SDR atual utiliza: sdr-whatsapp.js → sdr-state-machine.js → openai/sdr-engine.js
 * Mantido apenas para referência histórica. Não instanciar em produção.
 */

/**
 * Manager Studier
 * Deep-studies existing code and project structure
 */

const codeRepo = require('../../sheets/code-repo');
const memoryBank = require('../../sheets/memory-bank');
const analysisLog = require('../../sheets/analysis-log');
const { OpenAIMemory } = require('../../openai/memory');
const { AGENTS, MEMORY_CATEGORY } = require('../../config/constants');
const logger = require('../../config/logger');

class ManagerStudier {
    constructor() {
        this.memory = new OpenAIMemory();
    }

    /**
     * Study recent code in the repository and extract learnings
     * @param {number} limit - how many recent files to study
     * @returns {Array<Object>} learnings per file
     */
    async studyRecentCode(limit = 3) {
        logger.info(`[Manager.Studier] Studying last ${limit} code entries...`);

        const recent = await codeRepo.getRecent(limit);
        const learnings = [];

        for (const entry of recent) {
            if (!entry.filename) continue;

            const code = codeRepo.extractFullCode(entry);
            if (!code.trim()) continue;

            const analysis = await this.memory.analyzeCode({
                code,
                filename: entry.filename,
                context: entry.dependencies,
                prompt: 'Find patterns, issues, and learning opportunities.'
            });

            // Store as learning in Memory Bank
            await memoryBank.store({
                category: MEMORY_CATEGORY.PATTERNS,
                context: `Pattern in ${entry.filename}`,
                details: analysis,
                codeExample: code.substring(0, 300),
                tags: ['code_study', entry.language || 'javascript']
            });

            await analysisLog.log({
                type: 'code_study',
                agent: AGENTS.MANAGER,
                subject: entry.filename,
                discoveries: analysis.patterns,
                recommendations: analysis.next_steps,
                confidence: 85
            });

            learnings.push({ filename: entry.filename, analysis });
        }

        logger.info(`[Manager.Studier] Studied ${learnings.length} files`);
        return learnings;
    }

    /**
     * Compare two code versions and extract delta learnings
     * @param {string} oldCodeId
     * @param {string} newCodeId
     * @returns {Object} diff analysis
     */
    async compareVersions(oldCodeId, newCodeId) {
        logger.info(`[Manager.Studier] Comparing ${oldCodeId} vs ${newCodeId}`);

        const [oldEntry, newEntry] = await Promise.all([
            codeRepo.getById(oldCodeId),
            codeRepo.getById(newCodeId)
        ]);

        if (!oldEntry || !newEntry) {
            logger.warn('[Manager.Studier] One or both code entries not found');
            return null;
        }

        const oldCode = codeRepo.extractFullCode(oldEntry);
        const newCode = codeRepo.extractFullCode(newEntry);

        const analysis = await this.memory.analyzeCode({
            code: `OLD:\n${oldCode}\n\nNEW:\n${newCode}`,
            filename: `${oldEntry.filename} → ${newEntry.filename}`,
            prompt: 'Compare versions: improvements, regressions, patterns.'
        });

        return analysis;
    }
}

module.exports = new ManagerStudier();
