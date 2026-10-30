// Extension GNOME « Claude Quota »
// Affiche dans la barre du haut le quota de la session Claude (5 h) et l'heure du reset ;
// le détail (semaine comprise) est dans le menu.
//
// Source : https://api.anthropic.com/api/oauth/usage, l'endpoint qu'utilise
// /usage dans Claude Code. Il n'est pas documenté et peut changer sans préavis.
// Le token est relu à chaque appel dans $CLAUDE_CONFIG_DIR/.credentials.json
// (~/.claude par défaut). C'est Claude Code qui le rafraîchit : l'extension
// n'écrit jamais dans ce fichier.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_PAGE = 'https://claude.ai/settings/usage';
// CLAUDE_CONFIG_DIR doit être visible de GNOME Shell (~/.config/environment.d/),
// pas seulement du shell : sinon c'est ~/.claude qui est lu.
const CONFIG_DIR = GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
const CREDENTIALS = GLib.build_filenamev([CONFIG_DIR, '.credentials.json']);

const POLL_SECONDS = 180;
// L'API répond 429 si on l'appelle trop souvent : l'ouverture du menu ne
// relance pas d'appel si le dernier date de moins de 30 s.
const MENU_REFRESH_MIN_MS = 30000;
const WARN = 75;
const CRIT = 90;
const NOTIFY_THRESHOLDS = [80, 95];
const NOTIFY_KINDS = ['session', 'weekly_all'];

const COLOR_WARN = '#ff7800';
const COLOR_CRIT = '#e01b24';
const DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

const pad = n => String(n).padStart(2, '0');
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function colorFor(percent) {
    if (percent >= CRIT)
        return COLOR_CRIT;
    if (percent >= WARN)
        return COLOR_WARN;
    return null;
}

function bar(percent) {
    const n = Math.round(Math.min(100, Math.max(0, percent)) / 10);
    return '▰'.repeat(n) + '▱'.repeat(10 - n);
}

function formatReset(date) {
    if (!date)
        return '';
    const mins = Math.round((date.getTime() - Date.now()) / 60000);
    if (mins <= 0)
        return 'réinitialisé';
    if (mins < 60)
        return `reset dans ${mins} min (${hhmm(date)})`;
    if (mins < 24 * 60)
        return `reset dans ${Math.floor(mins / 60)} h ${pad(mins % 60)} (${hhmm(date)})`;
    return `reset ${DAYS[date.getDay()]} ${hhmm(date)}`;
}

function labelFor(limit) {
    switch (limit.kind) {
    case 'session':
        return 'Session (5 h)';
    case 'weekly_all':
        return 'Semaine, tous modèles';
    case 'weekly_scoped': {
        const model = limit.model ?? limit.scope?.model?.display_name;
        return model ? `Semaine, ${model}` : 'Semaine, limite dédiée';
    }
    default:
        return limit.kind;
    }
}

// Normalise la réponse. Le tableau `limits` est le format le plus lisible ;
// five_hour / seven_day servent de repli s'il disparaît.
function parseLimits(data) {
    let limits;
    if (Array.isArray(data.limits) && data.limits.length) {
        limits = data.limits.map(l => ({
            kind: l.kind,
            label: labelFor(l),
            percent: Number(l.percent) || 0,
            resetsAt: l.resets_at ? new Date(l.resets_at) : null,
        }));
    } else {
        limits = [];
        if (data.five_hour)
            limits.push({kind: 'session', raw: data.five_hour});
        if (data.seven_day)
            limits.push({kind: 'weekly_all', raw: data.seven_day});
        if (data.seven_day_opus)
            limits.push({kind: 'weekly_scoped', model: 'Opus', raw: data.seven_day_opus});
        if (data.seven_day_sonnet)
            limits.push({kind: 'weekly_scoped', model: 'Sonnet', raw: data.seven_day_sonnet});
        limits = limits.map(l => ({
            kind: l.kind,
            label: labelFor(l),
            percent: Number(l.raw.utilization) || 0,
            resetsAt: l.raw.resets_at ? new Date(l.raw.resets_at) : null,
        }));
    }

    // Une fenêtre dont la date de reset est passée est repartie de zéro.
    const now = Date.now();
    for (const l of limits) {
        if (l.resetsAt && l.resetsAt.getTime() <= now)
            l.percent = 0;
    }
    return limits;
}

function readToken() {
    let oauth;
    try {
        const [, contents] = GLib.file_get_contents(CREDENTIALS);
        oauth = JSON.parse(new TextDecoder().decode(contents)).claudeAiOauth;
    } catch (e) {
        throw new Error(`${CREDENTIALS} illisible`);
    }
    if (!oauth?.accessToken)
        throw new Error('Claude Code n\'est pas connecté à claude.ai');
    if (oauth.expiresAt && oauth.expiresAt < Date.now())
        throw new Error('Token expiré : lance Claude Code pour le rafraîchir');
    return oauth.accessToken;
}

const QuotaIndicator = GObject.registerClass(
class QuotaIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Claude Quota');

        this._http = new Soup.Session({timeout: 15, user_agent: 'claude-quota-gnome/1'});
        this._cancellable = new Gio.Cancellable();
        this._notified = new Set();
        this._limits = null;
        this._busy = false;
        this._lastAttemptMs = 0;

        this._label = new St.Label({text: '✻ …', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);

        this._limitsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._limitsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._status = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._status);
        this.menu.addAction('Actualiser', () => this.refresh());
        this.menu.addAction('Ouvrir la page d\'utilisation', () =>
            Gio.AppInfo.launch_default_for_uri(USAGE_PAGE, null));

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open && Date.now() - this._lastAttemptMs > MENU_REFRESH_MIN_MS)
                this.refresh();
        });
    }

    async refresh() {
        if (this._busy)
            return;
        this._busy = true;
        this._lastAttemptMs = Date.now();
        try {
            const msg = Soup.Message.new('GET', USAGE_URL);
            msg.request_headers.append('Authorization', `Bearer ${readToken()}`);
            msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

            const bytes = await this._http.send_and_read_async(
                msg, GLib.PRIORITY_DEFAULT, this._cancellable);
            const status = msg.get_status();
            if (status === 401 || status === 403)
                throw new Error('Token refusé : lance Claude Code pour le rafraîchir');
            if (status !== 200)
                throw new Error(`Erreur HTTP ${status}`);

            const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            this._limits = parseLimits(data);
            this._render(null);
            this._notifyThresholds();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._render(e.message);
        } finally {
            this._busy = false;
        }
    }

    _render(error) {
        const byKind = kind => this._limits?.find(l => l.kind === kind);
        const session = byKind('session');

        // Barre du haut : % de la session · heure du reset. La semaine est dans le menu.
        if (session) {
            const reset = session.resetsAt && session.resetsAt.getTime() > Date.now()
                ? ` · ${hhmm(session.resetsAt)}` : '';
            const color = colorFor(session.percent);
            this._label.text = `✻ ${Math.round(session.percent)}%${reset}${error ? ' ⚠' : ''}`;
            this._label.style = color ? `color: ${color}; font-weight: bold;` : '';
        } else {
            this._label.text = error ? '✻ ⚠' : '✻ …';
            this._label.style = '';
        }

        this._limitsSection.removeAll();
        for (const l of this._limits ?? [])
            this._limitsSection.addMenuItem(this._limitItem(l));

        this._status.label.text = error ?? `Mis à jour à ${hhmm(new Date())}`;
    }

    _limitItem(limit) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});

        const color = colorFor(limit.percent);
        const title = new St.Label({text: `${limit.label} : ${Math.round(limit.percent)} %`});
        title.style = 'font-weight: bold;';
        const detail = new St.Label({text: `${bar(limit.percent)}  ${formatReset(limit.resetsAt)}`});
        detail.style = color ? `color: ${color};` : 'opacity: 0.75;';

        box.add_child(title);
        box.add_child(detail);
        item.add_child(box);
        return item;
    }

    // Une notification par seuil franchi ; le seuil se réarme quand on repasse dessous.
    _notifyThresholds() {
        for (const l of this._limits) {
            if (!NOTIFY_KINDS.includes(l.kind))
                continue;
            for (const t of NOTIFY_THRESHOLDS) {
                const key = `${l.kind}:${t}`;
                if (l.percent >= t && !this._notified.has(key)) {
                    this._notified.add(key);
                    Main.notify('Quota Claude', `${l.label} : ${Math.round(l.percent)} % utilisé, ${formatReset(l.resetsAt)}`);
                } else if (l.percent < t) {
                    this._notified.delete(key);
                }
            }
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._http.abort();
        super.destroy();
    }
});

export default class ClaudeQuotaExtension extends Extension {
    enable() {
        this._indicator = new QuotaIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._indicator.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
    }
}
