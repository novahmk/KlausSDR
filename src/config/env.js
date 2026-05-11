/**
 * Environment Configuration
 * Validates and exports all env variables
 */

require('dotenv').config();

const REQUIRED_VARS = [
    'OPENAI_API_KEY',
    'GOOGLE_SHEETS_ID',
    'GOOGLE_CREDENTIALS_PATH'
];

function validate() {
    const missing = REQUIRED_VARS.filter(v => !process.env[v]);
    if (missing.length > 0) {
        throw new Error(
            `❌ Missing required env vars: ${missing.join(', ')}\n` +
            `   Set them in .env or as system variables`
        );
    }
    console.log('✅ Environment variables validated');
}

module.exports = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GOOGLE_SHEETS_ID: process.env.GOOGLE_SHEETS_ID,
    GOOGLE_CREDENTIALS_PATH: process.env.GOOGLE_CREDENTIALS_PATH,
    NODE_ENV: process.env.NODE_ENV || 'development',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    CYCLE_INTERVAL_MINUTES: parseInt(process.env.CYCLE_INTERVAL_MINUTES || 60),
    SDR_ADMIN_WHATSAPP_NUMBERS: process.env.SDR_ADMIN_WHATSAPP_NUMBERS || process.env.SDR_ADMIN_WHATSAPP_NUMBER || '',
    SDR_REMOTE_CONTROL_ENABLED: process.env.SDR_REMOTE_CONTROL_ENABLED !== 'false',
    SDR_REMOTE_CONTROL_FILE: process.env.SDR_REMOTE_CONTROL_FILE || '',
    SDR_LEAD_STATE_FILE: process.env.SDR_LEAD_STATE_FILE || '',
    SDR_SYSTEM_PROMPT_PATH: process.env.SDR_SYSTEM_PROMPT_PATH || '',
    SDR_DAILY_FOLLOWUP_HOUR: parseInt(process.env.SDR_DAILY_FOLLOWUP_HOUR || 9, 10),
    SDR_DAILY_FOLLOWUP_MINUTE: parseInt(process.env.SDR_DAILY_FOLLOWUP_MINUTE || 0, 10),
    validate
};
