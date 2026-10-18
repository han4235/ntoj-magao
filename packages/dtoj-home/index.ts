import {
    Context, PERM, PRIV, ProblemModel, Types, ValidationError, moment, param,
} from 'hydrooj';
import {
    DtojDataHandler, DtojPageHandler, dropEarlierRoutes, myPendingHomework, queryString,
} from 'dtoj-ui';
import { wikiGroups } from 'dtoj-wiki';
import {
    brand, heroFontOptions, heroGradientOptions, heroLineVariantOptions, homeCardTitles, homeEditMenu, homeSectionIds, homeSectionTitles, places,
} from './data';
import { buildCountdownDisplay } from './countdown';
import { buildCheckinEvents, checkinCalendar } from './checkin';
import { checkinFortunes, fortuneIndexForDay } from './fortunes';
import { cardLookPicker, cardLookStyle, homeCardSizeOptions, homeEditSectionToCardId, spanOfSize } from './cardSize';
import { layoutCardsForEdit, layoutCatalog, splitHomeLayout } from './layout';
import {
    checkinFortuneCount,
} from './data';
import {
    countdownRowsForEdit, loadHomeConfig, patchHeroBackground, saveCardPlaces, saveHomeSection,
} from './store';
import { HERO_BG_PUBLIC_PATH, readHeroBackground, saveHeroBackgroundUpload } from './heroUpload';

const levelNames = ['入门', '普及−', '普及/提高−', '普及+/提高', '提高+/省选−', '省选/NOI−', 'NOI/NOI+/CTSC'];

function problemLevel(pdoc: { difficulty?: number }) {
    const n = Number(pdoc.difficulty);
    if (!Number.isInteger(n) || n < 1 || n > levelNames.length) return '';
    return levelNames[n - 1];
}

function passRate(nSubmit = 0, nAccept = 0) {
    if (!nSubmit) return null;
    return Math.round((nAccept / nSubmit) * 100);
}

class DtojHomeHandler extends DtojPageHandler {
    async get() {
        const domainId = this.args.domainId;
        const u = this.user;
        const guest = !u || !u._id;
        const name = guest ? '示例同学' : String(u.uname || '示例同学');
        const cfg = await loadHomeConfig(domainId);
        const zone = this.user.timeZone || 'Asia/Shanghai';
        const coin = cfg.asset.coin;
        const streak = cfg.checkin.demoStreak;
        const cal = checkinCalendar(zone);
        const uid = guest ? 0 : Number(u._id) || 0;
        const pending = guest ? [] : await myPendingHomework(domainId, uid);
        const hwPending = pending.map((tdoc) => ({
            title: String(tdoc.title || ''),
            deadline: moment(tdoc.penaltySince).tz(zone).format('MM-DD HH:mm'),
        }));
        const fortuneIndex = fortuneIndexForDay(uid, cal.dayKey);
        const checkinFortune = checkinFortunes[fortuneIndex] || checkinFortunes[0];
        const { boardLayout, bandLayout } = splitHomeLayout(cfg.layout);
        this.view('dtoj_home', {
            brand,
            hero: cfg.hero,
            coin,
            streak,
            who: name,
            mark: name.slice(0, 1),
            hwPending,
            checkinUid: uid,
            checkinDayKey: cal.dayKey,
            checkinCalendar: cal,
            checkinEvents: buildCheckinEvents(cfg.countdowns, zone),
            checkinFortuneJson: JSON.stringify(checkinFortune),
            checkinWelcomeText: cfg.checkin.welcomeText,
            checkinFortuneSuffix: cfg.checkin.fortuneTitleSuffix,
            checkinFooterTemplate: cfg.checkin.footerTemplate,
            checkinEmptyEventsText: cfg.checkin.emptyEventsText,
            checkinFortuneCount,
            boardLayout,
            bandLayout,
            homeLayout: cfg.layout,
            cardSizes: cfg.cardSizes,
            cardLookStyle: Object.fromEntries(cfg.layout.map((id) => [id, cardLookStyle(cfg.cardLooks[id])])),
            checkinGoodColor: cfg.checkin.goodColor,
            checkinBadColor: cfg.checkin.badColor,
            cardPlacesJson: JSON.stringify(cfg.layout.map((id) => ({
                id,
                row: cfg.cardPlaces[id].row,
                col: cfg.cardPlaces[id].col,
                span: spanOfSize(cfg.cardSizes[id]),
            }))),
            homeCardTitles,
            countdownSubtitle: cfg.countdownSubtitle,
            countdowns: buildCountdownDisplay(cfg.countdowns, zone),
            assetNote: cfg.asset.note,
            activities: cfg.activities,
            announcements: cfg.announcements,
            paths: cfg.paths,
            wikiGroups,
            canEditHome: this.user.hasPerm(PERM.PERM_EDIT_DOMAIN),
        });
    }
}

function sectionOk(section: string) {
    return (homeSectionIds as readonly string[]).includes(section);
}

function cardSizeFields(section: string, cfg: Awaited<ReturnType<typeof loadHomeConfig>>) {
    const cardId = homeEditSectionToCardId[section];
    if (!cardId) {
        if (section === 'layout') {
            return {
                cardSizeOptions: homeCardSizeOptions,
                docsCardSize: cfg.cardSizes.docs,
                ...lookFields('docs', cfg),
            };
        }
        return {};
    }
    return {
        cardSizeOptions: homeCardSizeOptions,
        cardSize: cfg.cardSizes[cardId],
        ...lookFields(cardId, cfg),
    };
}

function lookFields(cardId: string, cfg: Awaited<ReturnType<typeof loadHomeConfig>>) {
    const id = cardId as keyof typeof cfg.cardLooks;
    const look = cfg.cardLooks[id];
    if (!look) return {};
    const picker = cardLookPicker(id, look);
    return {
        cardBorder: picker.border,
        cardBackground: picker.background,
        cardColorOn: picker.on,
    };
}

function editForm(section: string, cfg: Awaited<ReturnType<typeof loadHomeConfig>>) {
    const sizeFields = cardSizeFields(section, cfg);
    if (section === 'hero') {
        return {
            hero: cfg.hero,
            heroFonts: heroFontOptions,
            heroFontsJson: JSON.stringify(heroFontOptions),
            heroGradients: heroGradientOptions,
            heroGradientsJson: JSON.stringify(heroGradientOptions),
            heroLineVariants: heroLineVariantOptions,
            heroLineVariantsJson: JSON.stringify(heroLineVariantOptions),
        };
    }
    if (section === 'countdown') {
        return {
            ...sizeFields,
            countdownSubtitle: cfg.countdownSubtitle,
            countdownRows: countdownRowsForEdit(cfg.countdowns),
        };
    }
    if (section === 'checkin') {
        return {
            ...sizeFields,
            welcomeText: cfg.checkin.welcomeText,
            fortuneTitleSuffix: cfg.checkin.fortuneTitleSuffix,
            footerTemplate: cfg.checkin.footerTemplate,
            goodColor: cfg.checkin.goodColor,
            badColor: cfg.checkin.badColor,
            checkinFortuneCount,
        };
    }
    if (section === 'asset') {
        return { ...sizeFields, coin: cfg.asset.coin, note: cfg.asset.note };
    }
    if (section === 'activities') {
        const acts = cfg.activities.length
            ? cfg.activities.map((item) => ({
                id: item.id,
                href: item.href,
                title: item.title,
                about: item.about,
            }))
            : [{ id: '', href: '', title: '', about: '' }];
        return { ...sizeFields, acts };
    }
    if (section === 'news') {
        const news = cfg.announcements.length
            ? cfg.announcements.map((item) => ({ title: item.title, body: item.body }))
            : [{ title: '', body: '' }];
        return { ...sizeFields, news };
    }
    if (section === 'paths') {
        return { ...sizeFields, pathRows: cfg.paths };
    }
    if (section === 'layout') {
        return {
            ...sizeFields,
            layoutCards: layoutCardsForEdit(cfg.layout),
            layoutCatalog: layoutCatalog(cfg.layout),
        };
    }
    return { ...sizeFields };
}

class DtojHomeEditHubHandler extends DtojDataHandler {
    async get() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        this.view('dtoj_home_edit_hub', {
            page_name: 'dtoj_home_edit',
            homeEditMenu,
            homeSectionTitles,
            currentSection: '',
        });
    }
}

class DtojHomeEditHandler extends DtojDataHandler {
    section = '';

    @param('section', Types.String)
    async prepare(_domainId: string, section = '') {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        this.section = section;
    }

    async show(domainId: string, error = '') {
        const cfg = await loadHomeConfig(domainId);
        this.view('dtoj_home_edit', {
            section: this.section,
            sectionTitle: homeSectionTitles[this.section as keyof typeof homeSectionTitles],
            homeCardTitlesJson: JSON.stringify(homeCardTitles),
            homeEditMenu,
            homeSectionTitles,
            currentSection: this.section,
            error,
            heroUploadUrl: this.section === 'hero' ? this.url('dtoj_home_hero_upload') : '',
            heroBgPublicPath: HERO_BG_PUBLIC_PATH,
            ...editForm(this.section, cfg),
        });
    }

    @param('section', Types.String)
    async get(domainId: string, section = '') {
        if (!sectionOk(section)) {
            this.response.redirect = this.url('homepage');
            return;
        }
        this.section = section;
        await this.show(domainId);
    }

    @param('section', Types.String)
    async post(domainId: string, section = '') {
        if (!sectionOk(section)) {
            this.response.redirect = this.url('homepage');
            return;
        }
        this.section = section;
        try {
            await saveHomeSection(domainId, section, this.request.body || {});
            this.response.redirect = this.url('homepage');
        } catch (e) {
            await this.show(domainId, '保存失败，请检查填写内容。');
        }
    }
}

class DtojHomeLayoutHandler extends DtojDataHandler {
    @param('places', Types.String, true)
    async post(domainId: string, places = '') {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        let items: { id: string; row: number; col: number; span: number }[] = [];
        try { items = JSON.parse(String(places || '')); } catch (e) { items = []; }
        if (!Array.isArray(items)) items = [];
        await saveCardPlaces(domainId, items);
        this.response.template = null;
        this.response.body = { ok: true };
    }
}

class DtojHomeHeroUploadHandler extends DtojDataHandler {
    async post(domainId: string) {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const url = await saveHeroBackgroundUpload(domainId, file, this.user._id);
        await patchHeroBackground(domainId, url);
        this.response.template = null;
        this.response.body = { ok: true, url };
    }
}

class DtojHomeHeroBackgroundHandler extends DtojPageHandler {
    async get(domainId: string) {
        const asset = await readHeroBackground(domainId);
        this.response.type = asset.type;
        this.response.body = asset.body;
        this.response.addHeader('Cache-Control', 'public, max-age=3600');
    }
}

class DtojPlaceHandler extends DtojPageHandler {
    place = 'bugfind';
    pageName = 'dtoj_bugfind';

    async get() {
        this.view('dtoj_place', { ...places[this.place], pageName: this.pageName });
    }
}
class DtojBugfindHandler extends DtojPlaceHandler {
    place = 'bugfind';
    pageName = 'dtoj_bugfind';
}
class DtojJigsawHandler extends DtojPlaceHandler {
    place = 'jigsaw';
    pageName = 'dtoj_jigsaw';
}
class DtojBlackboxHandler extends DtojPlaceHandler {
    place = 'blackbox';
    pageName = 'dtoj_blackbox';
}
class DtojFarmHandler extends DtojPlaceHandler {
    place = 'farm';
    pageName = 'dtoj_farm';
}

class DtojProblemHandler extends DtojDataHandler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    @param('tag', Types.String, true)
    @param('diff', Types.String, true)
    @param('sort', Types.String, true)
    @param('tags', Types.String, true)
    async get(domainId: string, page = 1, q = '', tag = '', diff = '', sort = '', tags = '') {
        const query: any = {};
        if (!this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) {
            query.$or = [
                { hidden: false },
                { owner: this.user._id },
                { maintainer: this.user._id },
            ];
        }
        await this.ctx.parallel('problem/list', query, this, []);
        const docs = await ProblemModel.getMulti(domainId, query).toArray();
        const keyword = q.trim().toLowerCase();
        const wanted = levelNames.includes(diff) ? diff : '';
        const order = ['old', 'id', 'easy', 'hard'].includes(sort) ? sort : 'new';
        const cards = docs.map((pdoc) => ({
            title: pdoc.title,
            hang: String(pdoc.title || '').startsWith('【'),
            pid: String(pdoc.pid || pdoc.docId),
            link: pdoc.pid || pdoc.docId,
            docId: pdoc.docId,
            hidden: !!pdoc.hidden,
            tags: pdoc.tag || [],
            level: problemLevel(pdoc),
            diff: Number.isInteger(Number(pdoc.difficulty)) ? Number(pdoc.difficulty) : 0,
            rank: Number(pdoc.difficulty) || 0,
            rate: passRate(pdoc.nSubmit, pdoc.nAccept),
        }));
        const tagSet = new Set<string>();
        for (const card of cards) for (const name of card.tags) tagSet.add(name);
        const matched = cards.filter((card) => {
            if (wanted && card.level !== wanted) return false;
            if (tag && !card.tags.includes(tag)) return false;
            if (!keyword) return true;
            const blob = `${card.pid} ${card.title} ${card.tags.join(' ')}`.toLowerCase();
            return blob.includes(keyword);
        });
        matched.sort((a, b) => {
            if (order === 'id') return a.pid.localeCompare(b.pid, 'en');
            if (order === 'easy' || order === 'hard') {
                const unset = order === 'easy' ? 1e9 : -1;
                const ar = a.rank || unset;
                const br = b.rank || unset;
                if (ar !== br) return order === 'easy' ? ar - br : br - ar;
                return a.pid.localeCompare(b.pid, 'en');
            }
            const delta = a.docId - b.docId;
            return order === 'old' ? delta : -delta;
        });
        const size = 30;
        const pages = Math.max(1, Math.ceil(matched.length / size));
        const safePage = Math.min(page, pages);
        const lucky = matched.length ? matched[Math.floor(Math.random() * matched.length)] : null;
        const collapsed = tags === '0';
        const listQuery = { q, tag, diff: wanted, sort: order };
        this.view('dtoj_problems', {
            problems: matched.slice((safePage - 1) * size, safePage * size),
            tags: [...tagSet].sort((a, b) => a.localeCompare(b, 'zh')),
            levels: levelNames,
            total: matched.length,
            q,
            tag,
            diff: wanted,
            sort: order,
            showTags: !collapsed,
            lucky: lucky ? lucky.link : '',
            page: safePage,
            pages,
            qs: queryString({ ...listQuery, tags: collapsed ? '0' : undefined }),
            toggleQs: queryString({ ...listQuery, tags: collapsed ? undefined : '0' }),
            canCreate: this.user.hasPerm(PERM.PERM_CREATE_PROBLEM),
            canDelete: this.user.hasPerm(PERM.PERM_EDIT_PROBLEM),
            loggedIn: this.user.hasPriv(PRIV.PRIV_USER_PROFILE),
        });
    }
}

const titles = {
    dtoj_home: '首页',
    dtoj_place: '说明',
    dtoj_bugfind: '找茬',
    dtoj_jigsaw: '拼图',
    dtoj_blackbox: '黑盒',
    dtoj_farm: '农场',
    dtoj_problems: '题库',
    dtoj_home_edit: '首页配置',
    dtoj_home_edit_hub: '首页配置',
};

export async function apply(ctx: Context) {
    ctx.Route('homepage', '/', DtojHomeHandler);
    ctx.Route('dtoj_home_edit_hub', '/home/edit', DtojHomeEditHubHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('dtoj_home_edit', '/home/edit/:section', DtojHomeEditHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('dtoj_home_layout', '/home/layout', DtojHomeLayoutHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('dtoj_home_hero_upload', '/home/hero/upload', DtojHomeHeroUploadHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('dtoj_home_hero_background', '/home/hero/background', DtojHomeHeroBackgroundHandler);
    ctx.Route('dtoj_bugfind', '/bugfind', DtojBugfindHandler);
    ctx.Route('dtoj_jigsaw', '/jigsaw', DtojJigsawHandler);
    ctx.Route('dtoj_blackbox', '/blackbox', DtojBlackboxHandler);
    ctx.Route('dtoj_farm', '/farm', DtojFarmHandler);
    ctx.Route('dtoj_problems', '/dtoj/p', DtojProblemHandler, PERM.PERM_VIEW_PROBLEM);
    dropEarlierRoutes(ctx, ['/']);
    for (const lang of ['zh', 'zh_TW', 'en', 'kr']) {
        ctx.i18n.load(lang, titles);
    }
}
