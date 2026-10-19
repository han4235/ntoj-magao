import { escapeRegExp } from 'lodash';
import {
    ContestModel, ContestNotAttendedError, ContestNotFoundError, ContestNotLiveError, Context, DomainModel, InvalidTokenError, NotAssignedError,
    ObjectId, PERM, PRIV, ProblemModel, StorageModel, Types, UserModel, ValidationError, moment, param,
} from 'hydrooj';
import { DtojDataHandler, dropEarlierRoutes, pick, queryOf } from 'dtoj-ui';
import { contestKinds, contestTabs, mockLevels, mockTracks } from './data';

function contestHours(tdoc: { beginAt?: Date, endAt?: Date }) {
    const raw = (new Date(tdoc.endAt).getTime() - new Date(tdoc.beginAt).getTime()) / 3600000;
    if (!Number.isFinite(raw)) return '—';
    return (Math.round(raw * 10) / 10).toFixed(1);
}

/** 个人作答时长：设了 duration 用它，否则与开放时长相同。 */
function personalHoursOf(tdoc: { duration?: number, beginAt?: Date, endAt?: Date }) {
    const raw = tdoc.duration
        ? Number(tdoc.duration)
        : (new Date(tdoc.endAt).getTime() - new Date(tdoc.beginAt).getTime()) / 3600000;
    if (!Number.isFinite(raw)) return '—';
    return (Math.round(raw * 10) / 10).toFixed(1);
}

function contestKind(tdoc: any) {
    const tab = tdoc?.dtoj?.tab;
    return contestKinds.includes(tab) ? tab : '其他';
}

function contestFeatured(tdoc: any) {
    return tdoc?.dtoj?.featured === true || tdoc?.dtoj?.tab === '精选';
}

function contestTrack(tdoc: any) {
    const track = tdoc?.dtoj?.track;
    return mockTracks.includes(track) ? track : '其他';
}

function contestLevel(tdoc: any) {
    const level = tdoc?.dtoj?.level;
    return mockLevels.includes(level) ? level : '';
}

function clock(ms: number) {
    const safe = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${hours >= 100 ? String(hours) : pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function sortCards(cards: any[], order: string[]) {
    const rank = new Map<string, number>();
    order.forEach((id, index) => {
        if (!rank.has(id)) rank.set(id, index);
    });
    return cards.slice().sort((a, b) => {
        const ia = rank.get(a.id);
        const ib = rank.get(b.id);
        const aKnown = ia != null;
        const bKnown = ib != null;
        if (aKnown && bKnown) return ia - ib;
        if (aKnown !== bKnown) return aKnown ? -1 : 1;
        return new Date(a.beginAt).getTime() - new Date(b.beginAt).getTime();
    });
}

async function contestSettings(domainId: string) {
    const ddoc = await DomainModel.get(domainId);
    const saved = (ddoc as any)?.dtojContest || {};
    const order = Array.isArray(saved.order)
        ? saved.order.map((id: unknown) => String(id || '')).filter((id: string) => /^[a-f0-9]{24}$/.test(id))
        : [];
    const keep = (raw: unknown, fallback: string[]) => {
        const allow = new Set(fallback);
        const out: string[] = [];
        if (Array.isArray(raw)) {
            for (const item of raw) {
                const name = String(item || '').trim();
                if (!allow.has(name) || out.includes(name)) continue;
                out.push(name);
            }
        }
        for (const name of fallback) if (!out.includes(name)) out.push(name);
        return out;
    };
    return {
        tabs: keep(saved.tabs, contestTabs),
        tracks: keep(saved.tracks, mockTracks),
        levels: keep(saved.levels, mockLevels),
        order,
    };
}

function contestCard(tdoc: any) {
    const rule = ContestModel.RULES[tdoc.rule];
    return {
        id: tdoc.docId.toHexString(),
        title: tdoc.title,
        group: contestKind(tdoc) === '模拟赛'
            ? [contestTrack(tdoc), contestLevel(tdoc)].filter(Boolean).join(' ')
            : contestKind(tdoc),
        track: contestTrack(tdoc),
        level: contestLevel(tdoc),
        featured: contestFeatured(tdoc),
        brief: String(tdoc.content || '').trim(),
        rated: !!tdoc.rated,
        hours: contestHours(tdoc),
        personalHours: personalHoursOf(tdoc),
        problems: Array.isArray(tdoc.pids) ? tdoc.pids.length : 0,
        people: tdoc.attend || 0,
        rule: rule ? rule.TEXT : '',
        access: tdoc._code ? '邀请码' : '公开',
        beginAt: tdoc.beginAt,
        endAt: tdoc.endAt,
    };
}

function contestState(tdoc: any, now: number) {
    const begin = new Date(tdoc.beginAt).getTime();
    const end = new Date(tdoc.endAt).getTime();
    if (now >= end) return 'ended';
    if (now >= begin) return 'live';
    return 'soon';
}

function mockBoard(
    cards: any[], track: string, level: string, q: string, sort: string,
    tracks: string[] = mockTracks, levels: string[] = mockLevels,
) {
    const counts = new Map<string, number>();
    for (const card of cards) counts.set(card.track, (counts.get(card.track) || 0) + 1);
    let chosen = tracks.includes(track) ? track : '';
    if (!chosen) {
        chosen = tracks.reduce((best, name) => ((counts.get(name) || 0) > (counts.get(best) || 0) ? name : best), tracks[0] || 'GESP');
        if (!counts.get(chosen)) chosen = tracks.includes('GESP') ? 'GESP' : (tracks[0] || 'GESP');
    }
    const chosenLevel = chosen === 'GESP' && levels.includes(level) ? level : '';
    const keyword = q.trim().toLowerCase();
    const matched = cards.filter((card) => {
        if (card.track !== chosen) return false;
        if (chosenLevel && card.level !== chosenLevel) return false;
        if (keyword && !String(card.title).toLowerCase().includes(keyword)) return false;
        return true;
    });
    const byTime = (a: any, b: any) => new Date(a.beginAt).getTime() - new Date(b.beginAt).getTime();
    const ordered = matched.slice().sort(sort === 'old' ? byTime : (a, b) => byTime(b, a));
    const preview = 4;
    const groups = chosenLevel
        ? [{ title: '', level: chosenLevel, total: ordered.length, more: false, rows: ordered }]
        : [...levels, ''].map((name) => {
            const rows = ordered.filter((card) => (card.level || '') === name);
            return {
                title: name ? `${chosen} ${name}` : `${chosen} 未分级`,
                level: name,
                total: rows.length,
                more: Boolean(name),
                rows: name ? rows.slice(0, preview) : rows,
            };
        }).filter((group) => group.total);
    return {
        tracks,
        levels,
        track: chosen,
        level: chosenLevel,
        q,
        sort: sort === 'old' ? 'old' : 'new',
        heading: chosenLevel ? `近期 ${chosen} ${chosenLevel} 模拟赛` : `${chosen} 模拟赛`,
        groups,
        picks: matched.filter((card) => card.featured).sort(byTime),
    };
}

class DtojContestHandler extends DtojDataHandler {
    @param('tab', Types.String, true)
    @param('track', Types.String, true)
    @param('level', Types.String, true)
    @param('q', Types.String, true)
    @param('sort', Types.String, true)
    async get(domainId: string, tab = '', track = '', level = '', q = '', sort = '') {
        const settings = await contestSettings(domainId);
        tab = pick(tab, settings.tabs, '精选');
        const groups = (await UserModel.listGroup(
            domainId,
            this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST) ? undefined : this.user._id,
        )).map((group) => group.name);
        const rules = Object.keys(ContestModel.RULES).filter((rule) => !ContestModel.RULES[rule].hidden);
        const filter: any = {
            ...(this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)
                ? {}
                : {
                    $or: [
                        { maintainer: this.user._id },
                        { owner: this.user._id },
                        { assign: { $in: groups } },
                        { assign: { $size: 0 } },
                    ],
                }),
            rule: { $in: rules },
        };
        await this.ctx.parallel('contest/list', filter, this);
        const docs = await ContestModel.getMulti(domainId, filter).sort({ beginAt: -1 }).toArray();
        const inTab = docs.filter((tdoc) => (tab === '精选' ? contestFeatured(tdoc) : contestKind(tdoc) === tab));
        const now = Date.now();
        const joined = new Set<string>();
        if (this.user._id && inTab.length) {
            const status = await ContestModel.getListStatus(domainId, this.user._id, inTab.map((tdoc) => tdoc.docId));
            for (const [id, row] of Object.entries(status)) {
                if ((row as { attend?: number })?.attend) joined.add(id);
            }
        }
        const viewOf = (tdoc: any) => {
            const card = contestCard(tdoc);
            const state = contestState(tdoc, now);
            const begin = new Date(tdoc.beginAt).getTime();
            const end = new Date(tdoc.endAt).getTime();
            const left = state === 'live' ? end - now : state === 'soon' ? begin - now : 0;
            return {
                ...card,
                hours: prettyHours(card.hours),
                state,
                stateText: state === 'ended' ? '已结束' : state === 'live' ? '进行中' : '未开始',
                clockLabel: state === 'ended' ? '已结束' : state === 'live' ? '开放剩余' : '距离开始',
                clock: clock(left),
                clockNote: state === 'ended' ? '可以查看比赛详情。' : state === 'live' ? '比赛进行中。' : '比赛还没开始。',
                joined: joined.has(card.id),
            };
        };
        const cards = inTab.map(viewOf);
        const byBegin = (a: any, b: any) => new Date(a.beginAt).getTime() - new Date(b.beginAt).getTime();
        const mock = tab === '模拟赛' ? mockBoard(cards, track, level, q, sort, settings.tracks, settings.levels) : null;
        const picks = sortCards(mock ? mock.picks : cards.filter((card) => card.featured), settings.order);
        if (mock) mock.picks = picks;
        this.view('dtoj_contest', {
            tabs: settings.tabs,
            tab,
            mock,
            picks,
            recent: cards.filter((card) => card.state !== 'ended').sort(byBegin),
            history: cards.filter((card) => card.state === 'ended').sort((a, b) => byBegin(b, a)),
            canCreate: this.user.hasPerm(PERM.PERM_CREATE_CONTEST),
            canSort: this.user.hasPerm(PERM.PERM_EDIT_CONTEST),
        });
    }

    @param('ids', Types.ArrayOf(Types.String))
    @param('tab', Types.String, true)
    @param('track', Types.String, true)
    @param('level', Types.String, true)
    @param('q', Types.String, true)
    @param('sort', Types.String, true)
    async postReorder(domainId: string, ids: string[] = [], tab = '', track = '', level = '', q = '', sort = '') {
        this.checkPerm(PERM.PERM_EDIT_CONTEST);
        const settings = await contestSettings(domainId);
        tab = pick(tab, settings.tabs, '精选');
        const groups = (await UserModel.listGroup(
            domainId,
            this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST) ? undefined : this.user._id,
        )).map((group) => group.name);
        const rules = Object.keys(ContestModel.RULES).filter((rule) => !ContestModel.RULES[rule].hidden);
        const filter: any = {
            ...(this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)
                ? {}
                : {
                    $or: [
                        { maintainer: this.user._id },
                        { owner: this.user._id },
                        { assign: { $in: groups } },
                        { assign: { $size: 0 } },
                    ],
                }),
            rule: { $in: rules },
        };
        await this.ctx.parallel('contest/list', filter, this);
        const docs = await ContestModel.getMulti(domainId, filter).sort({ beginAt: -1 }).toArray();
        const order = settings.order;
        const featured = sortCards(docs.filter((tdoc) => contestFeatured(tdoc)).map((tdoc) => contestCard(tdoc)), order);
        const inTab = docs.filter((tdoc) => (tab === '精选' ? contestFeatured(tdoc) : contestKind(tdoc) === tab)).map((tdoc) => contestCard(tdoc));
        const picks = sortCards(tab === '模拟赛' ? mockBoard(inTab, track, level, q, sort, settings.tracks, settings.levels).picks : inTab.filter((card) => card.featured), order);
        const posted = ids.map((id) => String(id || ''));
        const windowIds = picks.map((card) => card.id);
        const same = posted.length === windowIds.length
            && posted.length > 1
            && new Set(posted).size === posted.length
            && posted.every((id) => windowIds.includes(id));
        if (!same) {
            this.response.status = 400;
            this.response.body = { error: '顺序不对' };
            this.response.template = '';
            return;
        }
        const visible = new Set(windowIds);
        const queue = posted.slice();
        const next = featured.map((card) => (visible.has(card.id) ? queue.shift() : card.id));
        while (queue.length) next.push(queue.shift());
        const ddoc = await DomainModel.get(domainId);
        const saved = (ddoc as any)?.dtojContest || {};
        await DomainModel.edit(domainId, { dtojContest: { ...saved, order: next } } as any);
        this.response.body = { ok: true };
        this.response.template = '';
    }

    @param('names', Types.ArrayOf(Types.String))
    @param('field', Types.String)
    async postReorderTags(domainId: string, names: string[] = [], field = '') {
        this.checkPerm(PERM.PERM_EDIT_CONTEST);
        const key = field === 'tracks' || field === 'levels' || field === 'tabs' ? field : '';
        if (!key) {
            this.response.status = 400;
            this.response.body = { error: '顺序不对' };
            this.response.template = '';
            return;
        }
        const settings = await contestSettings(domainId);
        const current = settings[key];
        const posted = names.map((name) => String(name || '').trim());
        const same = posted.length === current.length
            && new Set(posted).size === posted.length
            && posted.every((name) => current.includes(name));
        if (!same) {
            this.response.status = 400;
            this.response.body = { error: '顺序不对' };
            this.response.template = '';
            return;
        }
        const ddoc = await DomainModel.get(domainId);
        const saved = (ddoc as any)?.dtojContest || {};
        await DomainModel.edit(domainId, { dtojContest: { ...saved, [key]: posted } } as any);
        this.response.body = { ok: true };
        this.response.template = '';
    }
}

function prettyHours(raw: string) {
    return raw.endsWith('.0') ? raw.slice(0, -2) : raw;
}

function clockOf(tdoc: any, tsdoc: any) {
    const now = Date.now();
    if (ContestModel.isDone(tdoc, tsdoc)) return { mode: 'done', until: 0, note: '比赛已结束' };
    if (ContestModel.isPaused(tdoc, tsdoc)) {
        const end = ContestModel.personalEndAt(tdoc, tsdoc, now);
        return { mode: 'paused', until: Math.max(0, end.getTime() - now), note: '已暂停，个人计时还剩' };
    }
    if (tdoc.duration && !tsdoc?.startAt) {
        return { mode: 'wait', until: 0, note: '尚未开始计时。参加并进入题目后，按个人时长计时。' };
    }
    if (tdoc.allowPause && tsdoc?.startAt) {
        const end = ContestModel.personalEndAt(tdoc, tsdoc, now);
        if (end) return { mode: 'count', until: end.getTime(), note: '个人计时还剩' };
    }
    if (tdoc.duration && tsdoc?.startAt) {
        return {
            mode: 'count',
            until: new Date(tsdoc.startAt).getTime() + Number(tdoc.duration) * 3600000,
            note: '个人计时还剩',
        };
    }
    if (ContestModel.isNotStarted(tdoc)) {
        return { mode: 'count', until: new Date(tdoc.beginAt).getTime(), note: '距离开始' };
    }
    return { mode: 'count', until: new Date(tdoc.endAt).getTime(), note: '距离结束' };
}

function phaseOf(tdoc: any, tsdoc: any) {
    if (ContestModel.isDone(tdoc, tsdoc)) return '已结束';
    if (ContestModel.isNotStarted(tdoc)) return '尚未开始';
    return '正在进行';
}

class DtojContestDetailHandler extends DtojDataHandler {
    async loadContest(domainId: string, tid: ObjectId) {
        const tdoc = await ContestModel.get(domainId, tid);
        if (!ContestModel.RULES[tdoc.rule] || ContestModel.RULES[tdoc.rule].hidden) {
            throw new ContestNotFoundError(domainId, tid);
        }
        if (tdoc.assign?.length && !this.user.own(tdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)) {
            const groups = await UserModel.listGroup(domainId, this.user._id);
            if (!new Set(tdoc.assign).intersection(new Set(groups.map((group) => group.name))).size) {
                throw new NotAssignedError('contest', tid);
            }
        }
        return tdoc;
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const tdoc = await this.loadContest(domainId, tid);
        const pids = Array.isArray(tdoc.pids) ? tdoc.pids : [];
        const loggedIn = this.user.hasPriv(PRIV.PRIV_USER_PROFILE);
        const tsdoc = loggedIn ? await ContestModel.getStatus(domainId, tid, this.user._id) : null;
        const owner = await UserModel.getById(domainId, tdoc.owner);
        const canEdit = this.user.own(tdoc)
            ? this.user.hasPerm(PERM.PERM_EDIT_CONTEST_SELF)
            : this.user.hasPerm(PERM.PERM_EDIT_CONTEST);
        const canSeeProblems = !!tsdoc?.attend || ContestModel.isDone(tdoc, tsdoc) || canEdit;
        // Access to the contest list is checked above; a hidden problem must still
        // resolve for eligible contestants without becoming visible in the problem bank.
        const pdict = canSeeProblems ? await ProblemModel.getList(domainId, pids, true, false) : {};
        const part = pick(queryOf(this, 'part'), ['overview', 'problems', 'board'], 'overview');
        const card = contestCard(tdoc);
        const paused = ContestModel.isPaused(tdoc, tsdoc);
        this.view('dtoj_contest_detail', {
            contest: {
                ...card,
                hours: prettyHours(card.hours),
                personalHours: prettyHours(card.personalHours),
                content: tdoc.content || '',
                overview: tdoc.dtoj?.overview || '',
                personal: !!(tdoc.duration || tdoc.allowPause),
                allowPause: !!tdoc.allowPause,
                paused,
                canPause: !!tdoc.allowPause && !!tsdoc?.attend && !ContestModel.isDone(tdoc, tsdoc),
                running: !!tsdoc?.attend && ContestModel.isOngoing(tdoc, tsdoc),
                started: !!tsdoc?.startAt,
                rated: !!tdoc.rated,
                invite: !!tdoc._code,
                owner: owner?.uname || '—',
                attended: !!tsdoc?.attend,
                phase: phaseOf(tdoc, tsdoc),
                clock: clockOf(tdoc, tsdoc),
            },
            loggedIn,
            canEdit,
            canSeeProblems,
            part,
            problems: canSeeProblems ? pids.map((pid) => {
                const pdoc = pdict[pid];
                const missing = !pdoc?.docId;
                return {
                    pid,
                    show: missing ? String(pid) : (pdoc.pid || pid),
                    title: missing ? '' : (pdoc.title || ''),
                    missing,
                };
            }) : [],
        });
    }

    @param('tid', Types.ObjectId)
    @param('code', Types.String, true)
    async postAttend(domainId: string, tid: ObjectId, code = '') {
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.checkPerm(PERM.PERM_ATTEND_CONTEST);
        const tdoc = await this.loadContest(domainId, tid);
        if (ContestModel.isDone(tdoc)) throw new ContestNotLiveError(domainId, tid);
        if (tdoc._code && code !== tdoc._code) throw new InvalidTokenError('Contest Invitation', code);
        const payload: any = { subscribe: 1 };
        if (tdoc.allowPause && tdoc.beginAt <= new Date()) payload.startAt = new Date();
        await ContestModel.attend(domainId, tid, this.user._id, payload);
        this.back();
    }

    @param('tid', Types.ObjectId)
    async postPause(domainId: string, tid: ObjectId) {
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const tdoc = await this.loadContest(domainId, tid);
        if (!tdoc.allowPause) throw new ContestNotLiveError(domainId, tid);
        const tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        if (!tsdoc?.attend) throw new ContestNotAttendedError(domainId, tid);
        if (tsdoc.pauseAt) throw new ValidationError('pauseAt');
        if (!ContestModel.isOngoing(tdoc, tsdoc)) throw new ContestNotLiveError(domainId, tid);
        const now = new Date();
        await ContestModel.setStatus(domainId, tid, this.user._id, {
            pauseAt: now,
            ...(tsdoc.startAt ? {} : { startAt: now }),
        });
        this.back();
    }

    @param('tid', Types.ObjectId)
    async postResume(domainId: string, tid: ObjectId) {
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const tdoc = await this.loadContest(domainId, tid);
        if (!tdoc.allowPause) throw new ContestNotLiveError(domainId, tid);
        const tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        if (!tsdoc?.attend) throw new ContestNotAttendedError(domainId, tid);
        if (!tsdoc.pauseAt) throw new ValidationError('pauseAt');
        const now = Date.now();
        const pausedTotal = (Number(tsdoc.pausedTotal) || 0)
            + Math.max(0, now - new Date(tsdoc.pauseAt).getTime());
        await ContestModel.setStatus(domainId, tid, this.user._id, { pausedTotal }, { pauseAt: '' });
        this.back();
    }
}

function rulesOf() {
    return Object.keys(ContestModel.RULES)
        .filter((key) => !ContestModel.RULES[key].hidden)
        .map((key) => ({ id: key, text: ContestModel.RULES[key].TEXT || key }));
}

async function searchProblems(domainId: string, pq: string) {
    const q = pq.trim();
    if (!q) return [];
    const query: any = /^\d+$/.test(q)
        ? { docId: +q }
        : { $or: [{ pid: new RegExp(escapeRegExp(q), 'i') }, { title: new RegExp(escapeRegExp(q), 'i') }] };
    const docs = await ProblemModel.getMulti(domainId, query).limit(12).toArray();
    return docs.map((pdoc) => ({
        pid: pdoc.pid || String(pdoc.docId),
        title: pdoc.title || '',
    }));
}

async function problemsOf(domainId: string, raw: string) {
    const tokens = raw.split(/[\s,，]+/).filter(Boolean);
    if (!tokens.length) return { error: '至少从题库加一道题。' };
    const pids = [];
    const missing = [];
    for (const token of tokens) {
        // eslint-disable-next-line no-await-in-loop
        const pdoc = await ProblemModel.get(domainId, token);
        if (!pdoc) missing.push(token);
        else if (!pids.includes(pdoc.docId)) pids.push(pdoc.docId);
    }
    if (missing.length) return { error: `题库里没有这些题号：${Array.from(new Set(missing)).join('、')}` };
    return { pids };
}

class DtojContestEditHandler extends DtojDataHandler {
    tdoc: any;

    @param('tid', Types.ObjectId, true)
    async prepare(domainId: string, tid?: ObjectId) {
        if (tid) {
            this.tdoc = await ContestModel.get(domainId, tid);
            if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            else this.checkPerm(PERM.PERM_EDIT_CONTEST_SELF);
        } else this.checkPerm(PERM.PERM_CREATE_CONTEST);
    }

    async shownPids(domainId: string) {
        const pids = this.tdoc?.pids || [];
        const shown = [];
        for (const pid of pids) {
            // eslint-disable-next-line no-await-in-loop
            const pdoc = await ProblemModel.get(domainId, pid);
            shown.push(pdoc?.pid || String(pid));
        }
        return shown.join(' ');
    }

    form(domainId: string, body: Record<string, any>) {
        const tdoc = this.tdoc;
        const zone = this.user.timeZone || 'Asia/Shanghai';
        const begin = moment(tdoc?.beginAt || Date.now()).tz(zone);
        this.view('dtoj_contest_edit', {
            pageName: tdoc ? 'dtoj_contest_edit' : 'dtoj_contest_create',
            rules: rulesOf(),
            tabs: contestKinds,
            tracks: mockTracks,
            levels: mockLevels,
            title: body.title ?? tdoc?.title ?? '',
            tab: body.tab ?? contestKind(tdoc),
            track: body.track !== undefined ? body.track : (tdoc?.dtoj?.track || ''),
            level: body.level !== undefined ? body.level : (tdoc?.dtoj?.level || ''),
            featured: body.featured !== undefined ? body.featured === '1' || body.featured === true : contestFeatured(tdoc),
            content: body.content ?? tdoc?.content ?? '',
            overview: body.overview ?? tdoc?.dtoj?.overview ?? '',
            rule: body.rule ?? tdoc?.rule ?? 'oi',
            beginDate: body.beginDate ?? begin.format('YYYY-MM-DD'),
            beginTime: body.beginTime ?? begin.format('HH:mm'),
            duration: body.duration ?? (tdoc ? contestHours(tdoc) : '2'),
            personalHours: body.personalHours ?? (tdoc?.duration ? String(tdoc.duration) : ''),
            allowPause: body.allowPause !== undefined
                ? body.allowPause === '1' || body.allowPause === 'on'
                : !!tdoc?.allowPause,
            pids: body.pids ?? '',
            code: body.code ?? tdoc?._code ?? '',
            pq: body.pq || '',
            hits: body.hits || [],
            error: body.error || '',
            canDelete: !!tdoc,
        });
    }

    @param('pq', Types.String, true)
    async get(domainId: string, pq = '') {
        if (String(this.args.suggest || '') === '1') {
            this.response.body = { hits: await searchProblems(domainId, pq) };
            this.response.template = '';
            return;
        }
        this.form(domainId, {
            pq,
            pids: await this.shownPids(domainId),
            hits: await searchProblems(domainId, pq),
        });
    }

    draft(body: Record<string, any>) {
        return {
            title: body.title || '',
            tab: body.tab || '',
            track: body.track || '',
            level: body.level || '',
            featured: body.featured === '1' || body.featured === true ? '1' : '',
            content: body.content || '',
            overview: body.overview || '',
            rule: body.rule || '',
            beginDate: body.beginDate || '',
            beginTime: body.beginTime || '',
            duration: body.duration || '',
            personalHours: body.personalHours || '',
            allowPause: body.allowPause === '1' || body.allowPause === 'on' ? '1' : '',
            pids: body.pids || '',
            code: body.code || '',
            pq: body.pq || '',
        };
    }

    @param('title', Types.String, true)
    @param('tab', Types.String, true)
    @param('featured', Types.String, true)
    @param('track', Types.String, true)
    @param('level', Types.String, true)
    @param('content', Types.String, true)
    @param('overview', Types.String, true)
    @param('rule', Types.String, true)
    @param('beginDate', Types.String, true)
    @param('beginTime', Types.String, true)
    @param('duration', Types.String, true)
    @param('personalHours', Types.String, true)
    @param('allowPause', Types.String, true)
    @param('pids', Types.String, true)
    @param('code', Types.String, true)
    @param('pq', Types.String, true)
    async postSearch(domainId: string, title = '', tab = '', featured = '', track = '', level = '', content = '', overview = '', rule = '', beginDate = '', beginTime = '', duration = '', personalHours = '', allowPause = '', pids = '', code = '', pq = '') {
        const draft = this.draft({
            title, tab, featured, track, level, content, overview, rule, beginDate, beginTime, duration, personalHours, allowPause, pids, code, pq,
        });
        this.form(domainId, { ...draft, hits: await searchProblems(domainId, pq) });
    }

    async postDelete() {
        if (!this.tdoc) return;
        const domainId = this.args.domainId;
        const tid = this.tdoc.docId;
        await ContestModel.del(domainId, tid);
        const names = [
            ...(this.tdoc.files || []).map((file) => `contest/${domainId}/${tid}/public/${file.name}`),
            ...(this.tdoc.privateFiles || []).map((file) => `contest/${domainId}/${tid}/private/${file.name}`),
        ];
        if (names.length) await StorageModel.del(names, this.user._id);
        this.response.redirect = this.url('contest_main');
    }

    @param('title', Types.String, true)
    @param('tab', Types.String, true)
    @param('featured', Types.String, true)
    @param('track', Types.String, true)
    @param('level', Types.String, true)
    @param('content', Types.String, true)
    @param('overview', Types.String, true)
    @param('rule', Types.String, true)
    @param('beginDate', Types.String, true)
    @param('beginTime', Types.String, true)
    @param('duration', Types.String, true)
    @param('personalHours', Types.String, true)
    @param('allowPause', Types.String, true)
    @param('pids', Types.String, true)
    @param('code', Types.String, true)
    @param('pq', Types.String, true)
    async postSave(
        domainId: string,
        title = '',
        tab = '',
        featured = '',
        track = '',
        level = '',
        content = '',
        overview = '',
        rule = '',
        beginDate = '',
        beginTime = '',
        duration = '',
        personalHours = '',
        allowPause = '',
        pids = '',
        code = '',
        pq = '',
    ) {
        const draft = this.draft({
            title, tab, featured, track, level, content, overview, rule, beginDate, beginTime, duration, personalHours, allowPause, pids, code, pq,
        });
        const nextTab = pick(tab, contestKinds, '其他');
        const nextTitle = title.trim();
        const nextContent = content.trim();
        const hours = Number(duration);
        const allowed = rulesOf().some((item) => item.id === rule);
        const zone = this.user.timeZone || 'Asia/Shanghai';
        const begin = moment.tz(`${beginDate} ${beginTime}`, zone);
        if (!nextTitle) {
            this.form(domainId, { ...draft, error: '先写标题。' });
            return;
        }
        if (nextTitle.length > 128) {
            this.form(domainId, { ...draft, error: '标题不能超过 128 个字。' });
            return;
        }
        if (!allowed) {
            this.form(domainId, { ...draft, error: '先选一个赛制。' });
            return;
        }
        if (!begin.isValid()) {
            this.form(domainId, { ...draft, error: '开始日期或时间写得不对。' });
            return;
        }
        if (!Number.isFinite(hours) || hours <= 0) {
            this.form(domainId, { ...draft, error: '开放窗口要写大于 0 的小时数。' });
            return;
        }
        const found = await problemsOf(domainId, pids);
        if ('error' in found && found.error) {
            this.form(domainId, { ...draft, error: found.error });
            return;
        }
        const beginAt = begin.toDate();
        const endAt = begin.clone().add(hours, 'hours').toDate();
        const personal = personalHours.trim() ? Number(personalHours) : 0;
        if (!Number.isFinite(personal) || personal < 0) {
            this.form(domainId, { ...draft, error: '个人作答时长要写成不小于 0 的小时数，留空表示和开放窗口相同。' });
            return;
        }
        const nextAllowPause = allowPause === '1' || allowPause === 'on';
        const nextCode = code.trim();
        const dtoj = {
            tab: nextTab,
            featured: featured === '1' || featured === 'on',
            track: nextTab === '模拟赛' ? pick(track, mockTracks, '其他') : '',
            level: nextTab === '模拟赛' && track === 'GESP' && mockLevels.includes(level) ? level : '',
            overview: overview.trim(),
        };
        let tid = this.tdoc?.docId as ObjectId | undefined;
        if (!tid) {
            tid = await ContestModel.add(
                domainId, nextTitle, nextContent, this.user._id, rule, beginAt, endAt, found.pids, false,
                {
                    _code: nextCode,
                    dtoj,
                    duration: personal > 0 ? personal : null,
                    allowPause: nextAllowPause,
                } as any,
            );
        } else {
            await ContestModel.edit(domainId, tid, {
                title: nextTitle,
                content: nextContent,
                rule,
                beginAt,
                endAt,
                pids: found.pids,
                _code: nextCode,
                dtoj,
                duration: personal > 0 ? personal : null,
                allowPause: nextAllowPause,
            } as any);
        }
        this.response.redirect = this.url('dtoj_contest_detail', { tid });
    }
}

const titles = {
    dtoj_contest: '比赛',
    dtoj_contest_detail: '比赛详情',
    dtoj_contest_create: '新建比赛',
    dtoj_contest_edit: '编辑比赛',
};

export async function apply(ctx: Context) {
    ctx.Route('contest_main', '/contest', DtojContestHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('dtoj_contest_create', '/contest/create', DtojContestEditHandler);
    ctx.Route('dtoj_contest_detail', '/contest/:tid', DtojContestDetailHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('dtoj_contest_edit', '/contest/:tid/edit', DtojContestEditHandler);
    dropEarlierRoutes(ctx, ['/contest', '/contest/create', '/contest/:tid', '/contest/:tid/edit']);
    for (const lang of ['zh', 'zh_TW', 'en', 'kr']) {
        ctx.i18n.load(lang, titles);
    }
}
