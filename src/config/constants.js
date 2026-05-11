/**
 * System Constants
 * Centralized constants for sheets tabs, statuses, and priorities
 */

// Google Sheets tab names
const SHEETS = {
    TASK_QUEUE: 'Task Queue',
    CODE_REPO: 'Code Repository',
    ANALYSIS_LOG: 'Analysis Log',
    MEMORY_BANK: 'Memory Bank',
    PERFORMANCE: 'Performance',
    LEADS_LIST: 'Lista leads'
};

// Task statuses
const TASK_STATUS = {
    PENDING: 'pending',
    IN_PROGRESS: 'in_progress',
    DONE: 'done',
    BLOCKED: 'blocked'
};

// Task priorities
const PRIORITY = {
    HIGH: 'high',
    MEDIUM: 'medium',
    LOW: 'low'
};

// Code statuses
const CODE_STATUS = {
    DRAFT: 'draft',
    REVIEWED: 'reviewed',
    NEEDS_REVISION: 'needs_revision',
    PRODUCTION: 'production'
};

// Memory categories
const MEMORY_CATEGORY = {
    PATTERNS: 'patterns',
    DECISIONS: 'decisions',
    LEARNINGS: 'learnings',
    ERRORS: 'errors',
    TASK_GENERATION: 'task_generation'
};

// Agent identifiers
const AGENTS = {
    MANAGER: 'KlausManager',
    ATTENDANT: 'KlausAttendant'
};

module.exports = {
    SHEETS,
    TASK_STATUS,
    PRIORITY,
    CODE_STATUS,
    MEMORY_CATEGORY,
    AGENTS
};
