'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PROMPT_PATH = path.join(__dirname, 'sdr_ai_system_prompt.md');

function loadSdrSystemPrompt() {
    const configuredPath = process.env.SDR_SYSTEM_PROMPT_PATH
        ? path.resolve(process.env.SDR_SYSTEM_PROMPT_PATH)
        : DEFAULT_PROMPT_PATH;

    try {
        if (fs.existsSync(configuredPath)) {
            return fs.readFileSync(configuredPath, 'utf8').trim();
        }
    } catch {
        // Fallback below
    }

    return [
        'You are the SDR IA for Klaus.',
        'Output ONLY the next message string in Portuguese.',
        'Use conversation history JSON, lead metadata, current date/time, and funnel state.',
        'Be human, creative, concise, and commercially effective.',
        'If the lead requests a human, a call, or a meeting, favor human transition.'
    ].join('\n');
}

module.exports = { loadSdrSystemPrompt };
