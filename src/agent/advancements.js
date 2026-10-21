// Tracks the bot's advancements from the server's `advancements` packet.
// Mineflayer parses the packet but has no plugin for it, so we listen on the raw client.
// The server sends the full set after login (reset=true) and incremental updates afterwards.

const TAB_ORDER = ['story', 'nether', 'end', 'adventure', 'husbandry'];

function tabOf(id) {
    const path = id.split(':').pop();
    return path.split('/')[0];
}

function humanize(id) {
    const name = id.split('/').pop().replace(/_/g, ' ');
    return name.charAt(0).toUpperCase() + name.slice(1);
}

// title/description arrive as NBT text components; vanilla ones are translation keys
function textOf(component, language) {
    if (component == null) return '';
    if (typeof component === 'string') return component;
    if (component.type === 'string') return component.value;
    if (component.type === 'compound') {
        const value = component.value;
        if (value.translate) {
            const key = value.translate.value;
            return language?.[key] ?? key;
        }
        let res = value.text?.value ?? '';
        const extra = value.extra?.value?.value ?? [];
        for (const part of extra)
            res += textOf(part.type ? part : { type: 'compound', value: part }, language);
        return res;
    }
    return '';
}

export class AdvancementTracker {
    constructor(bot) {
        this.bot = bot;
        this.defs = {};      // id -> { parent, title, description, hidden, requirements }
        this.progress = {};  // id -> { criterion: timestamp ms | null }
        this.completed_at = {}; // id -> timestamp ms
        this.received = false;
        bot._client.on('advancements', (packet) => this._handlePacket(packet));
    }

    _handlePacket(packet) {
        const language = this.bot.registry?.language;
        if (packet.reset) {
            this.defs = {};
            this.progress = {};
            this.completed_at = {};
        }
        for (const { key, value } of packet.advancementMapping ?? []) {
            const display = value.displayData;
            this.defs[key] = {
                parent: value.parentId ?? null,
                // recipe unlocks are advancements too, but have no display data
                display: !!display,
                title: display ? textOf(display.title, language) || humanize(key) : humanize(key),
                description: display ? textOf(display.description, language) : '',
                hidden: !!display?.flags?.hidden,
                requirements: value.requirements ?? [],
            };
        }
        for (const id of packet.identifiers ?? []) {
            delete this.defs[id];
            delete this.progress[id];
            delete this.completed_at[id];
        }
        for (const { key, value } of packet.progressMapping ?? []) {
            const criteria = this.progress[key] ?? {};
            for (const { criterionIdentifier, criterionProgress } of value) {
                criteria[criterionIdentifier] = criterionProgress != null ? Number(criterionProgress) : null;
            }
            this.progress[key] = criteria;

            if (this._checkDone(key)) {
                if (!(key in this.completed_at)) {
                    const times = Object.values(criteria).filter(t => t != null);
                    this.completed_at[key] = times.length > 0 ? Math.max(...times) : Date.now();
                }
            }
            else {
                delete this.completed_at[key]; // revoked
            }
        }
        this.received = true;
    }

    _checkDone(id) {
        const criteria = this.progress[id] ?? {};
        const requirements = this.defs[id]?.requirements ?? [];
        // requirements are AND-of-ORs: every group needs at least one completed criterion
        if (requirements.length > 0)
            return requirements.every(group => group.some(c => criteria[c] != null));
        const values = Object.values(criteria);
        return values.length > 0 && values.every(t => t != null);
    }

    isDone(id) {
        return id in this.completed_at;
    }

    _visible(id) {
        const def = this.defs[id];
        return def && def.display && !id.endsWith('/root');
    }

    _sortByTab(ids) {
        const rank = id => {
            const i = TAB_ORDER.indexOf(tabOf(id));
            return i === -1 ? TAB_ORDER.length : i;
        };
        return ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    }

    // completed display advancements, oldest first
    getCompleted() {
        return Object.keys(this.completed_at)
            .filter(id => this._visible(id))
            .sort((a, b) => this.completed_at[a] - this.completed_at[b]);
    }

    // not done, not hidden, and the parent is done (or it has no parent): the next steps on the tree
    getAvailable() {
        const ids = Object.keys(this.defs).filter(id => {
            const def = this.defs[id];
            if (!this._visible(id) || this.isDone(id) || def.hidden) return false;
            return !def.parent || this.isDone(def.parent) || def.parent.endsWith('/root');
        });
        return this._sortByTab(ids);
    }

    // criteria still missing for a partially completed advancement, e.g. biomes for Adventuring Time
    getRemainingCriteria(id) {
        const criteria = this.progress[id] ?? {};
        const requirements = this.defs[id]?.requirements ?? [];
        return requirements
            .filter(group => !group.some(c => criteria[c] != null))
            .map(group => group[0]);
    }

    format(id) {
        const def = this.defs[id];
        return def.description ? `${def.title} (${def.description})` : def.title;
    }
}
