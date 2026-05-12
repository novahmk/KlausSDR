'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');

const STATE_FILE = process.env.SDR_LEAD_STATE_FILE
    ? path.resolve(process.env.SDR_LEAD_STATE_FILE)
    : path.join(__dirname, '..', '..', 'data', 'sdr_lead_state.json');

const DEFAULT_LEAD_STATE = () => ({
    current_funnel_stage: 'TOP_OF_FUNNEL',
    follow_up_counter: 0,
    objections_met: [],
    lead_info: {
        decisor_name: '',
        decisor_contact: '',
        pain_points: [],
        company: ''
    },
    history: [],
    last_contact_at: null,
    last_inbound_at: null,
    last_outbound_at: null,
    followup_markers_sent: [],
    human_transition_notified_at: null,
    updated_at: new Date().toISOString()
});

class SDRLeadStateStore {
    constructor() {
        this._state = this._load();
    }

    getLead(leadId) {
        const id = this._normalizeLeadId(leadId);
        return this._state[id] || this._createLeadState();
    }

    getAllLeads() {
        return JSON.parse(JSON.stringify(this._state));
    }

    upsertLead(leadId, patch = {}) {
        const id = this._normalizeLeadId(leadId);
        const current = this.getLead(id);
        const next = this._deepMerge(current, patch);
        next.updated_at = new Date().toISOString();
        this._state[id] = next;
        this._save();
        return this.getLead(id);
    }

    setLeadInfo(leadId, leadInfo = {}) {
        return this.upsertLead(leadId, {
            lead_info: leadInfo
        });
    }

    recordInbound(leadId, message, meta = {}) {
        const now = new Date().toISOString();
        const current = this.getLead(leadId);
        const history = [...(current.history || []), {
            direction: 'inbound',
            timestamp: now,
            text: String(message || ''),
            meta
        }];

        const next = this.upsertLead(leadId, {
            history,
            last_contact_at: now,
            last_inbound_at: now,
            follow_up_counter: 0
        });

        return next;
    }

    recordOutbound(leadId, message, meta = {}) {
        const now = new Date().toISOString();
        const current = this.getLead(leadId);
        const history = [...(current.history || []), {
            direction: 'outbound',
            timestamp: now,
            text: String(message || ''),
            meta
        }];

        const next = this.upsertLead(leadId, {
            history,
            last_contact_at: now,
            last_outbound_at: now,
            follow_up_counter: 0
        });

        return next;
    }

    addObjection(leadId, objection) {
        const normalized = String(objection || '').trim();
        if (!normalized) return this.getLead(leadId);

        const current = this.getLead(leadId);
        const objections = Array.from(new Set([...(current.objections_met || []), normalized]));
        return this.upsertLead(leadId, { objections_met: objections });
    }

    markFollowUpSent(leadId, day) {
        const current = this.getLead(leadId);
        const markers = Array.from(new Set([...(current.followup_markers_sent || []), Number(day)]));
        return this.upsertLead(leadId, { followup_markers_sent: markers });
    }

    hasFollowUpBeenSent(leadId, day) {
        const current = this.getLead(leadId);
        return (current.followup_markers_sent || []).includes(Number(day));
    }

    markHumanTransitionNotified(leadId) {
        return this.upsertLead(leadId, {
            human_transition_notified_at: new Date().toISOString()
        });
    }

    getDueFollowUps() {
        const now = Date.now();
        let changed = false;
        const results = Object.entries(this._state)
            .map(([leadId, leadState]) => {
                if (leadState.human_transition_notified_at) {
                    return null;
                }

                const lastContactAt = leadState.last_contact_at
                    ? new Date(leadState.last_contact_at).getTime()
                    : null;
                const lastInboundAt = leadState.last_inbound_at
                    ? new Date(leadState.last_inbound_at).getTime()
                    : null;
                const lastOutboundAt = leadState.last_outbound_at
                    ? new Date(leadState.last_outbound_at).getTime()
                    : null;

                const referenceTime = lastInboundAt && lastOutboundAt
                    ? Math.max(lastInboundAt, lastOutboundAt)
                    : (lastContactAt || lastOutboundAt || lastInboundAt);

                if (!referenceTime) return null;

                const days = Math.floor((now - referenceTime) / (24 * 60 * 60 * 1000));
                this._state[leadId] = {
                    ...leadState,
                    follow_up_counter: days,
                    updated_at: new Date().toISOString()
                };
                changed = true;
                const dueDays = [1, 5, 10].filter(day => days >= day && !this.hasFollowUpBeenSent(leadId, day));

                if (!dueDays.length) return null;

                return {
                    leadId,
                    leadState,
                    daysSinceContact: days,
                    dueDays
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.daysSinceContact - a.daysSinceContact);

        if (changed) {
            this._save();
        }

        return results;
    }

    refreshFollowUpCounter(leadId) {
        const current = this.getLead(leadId);
        const reference = current.last_contact_at || current.last_outbound_at || current.last_inbound_at;
        if (!reference) return current;

        const days = Math.max(0, Math.floor((Date.now() - new Date(reference).getTime()) / (24 * 60 * 60 * 1000)));
        return this.upsertLead(leadId, { follow_up_counter: days });
    }

    setFunnelStage(leadId, stage) {
        return this.upsertLead(leadId, { current_funnel_stage: stage });
    }

    resetFollowUpMarkers(leadId) {
        return this.upsertLead(leadId, { followup_markers_sent: [] });
    }

    _load() {
        try {
            if (!fs.existsSync(STATE_FILE)) return {};
            const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (err) {
            logger.warn(`[SDR State] Falha ao carregar estado: ${err.message}`);
            return {};
        }
    }

    _save() {
        try {
            const dir = path.dirname(STATE_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(STATE_FILE, JSON.stringify(this._state, null, 2), 'utf8');
        } catch (err) {
            logger.warn(`[SDR State] Falha ao salvar estado: ${err.message}`);
        }
    }

    _createLeadState() {
        return DEFAULT_LEAD_STATE();
    }

    _normalizeLeadId(leadId) {
        return String(leadId || '').replace(/\D/g, '');
    }

    _deepMerge(target, patch) {
        if (!patch || typeof patch !== 'object') return target;
        const output = Array.isArray(target) ? [...target] : { ...target };

        for (const [key, value] of Object.entries(patch)) {
            if (Array.isArray(value)) {
                output[key] = [...value];
            } else if (value && typeof value === 'object') {
                output[key] = this._deepMerge(output[key] || {}, value);
            } else {
                output[key] = value;
            }
        }

        return output;
    }
}

module.exports = new SDRLeadStateStore();
