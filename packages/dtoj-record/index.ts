import { ObjectId } from 'mongodb';
import {
    Context, PERM, ProblemModel, RecordModel, STATUS, STATUS_CODES, STATUS_SHORT_TEXTS, STATUS_TEXTS,
    SettingModel, Types, UserModel, canViewAllDomainRecords, param,
} from 'hydrooj';
import { RecordNotFoundError } from 'hydrooj/src/error';
import * as contest from 'hydrooj/src/model/contest';
import {
    RecordDetailConnectionHandler,
    RecordDetailHandler,
} from 'hydrooj/src/handler/record';
import {
    canViewPracticeRecordDetail,
    canViewRecordSourceCode,
} from './recordAccess';
import { DtojDataHandler, dropEarlierRoutes, queryString } from 'dtoj-ui';
import { buildCaseFileUrlMap, buildDtojRecordDetailView, canViewProblemTestdataFiles } from './dtojRecordDetail';

function memoryText(kb: number) {
    let s = kb * 1024;
    const unit = 1024;
    const names = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    for (const name of names) {
        if (s < unit) return `${Math.round(s * 10) / 10} ${name}`;
        s /= unit;
    }
    return `${Math.round(s * unit)} ${names[names.length - 1]}`;
}

function recordStatusLabel(status: number) {
    const short = STATUS_SHORT_TEXTS[status as STATUS];
    if (short) return short;
    return STATUS_TEXTS[status as STATUS] || '';
}

function langChoices() {
    const langs = SettingModel.langs;
    const prefixes = new Set(
        Object.keys(langs).filter((key) => key.includes('.')).map((key) => key.split('.')[0]),
    );
    const choices = [];
    for (const key of Object.keys(langs)) {
        if (prefixes.has(key) || langs[key].hidden || langs[key].disabled) continue;
        choices.push({ id: key, display: langs[key].display });
    }
    return choices;
}

class DtojRecordHandler extends DtojDataHandler {
    @param('page', Types.PositiveInt, true)
    @param('pid', Types.ProblemId, true)
    @param('uidOrName', Types.UidOrName, true)
    @param('lang', Types.String, true)
    @param('status', Types.Int, true)
    @param('source', Types.String, true)
    async get(
        domainId: string, page = 1, pid?: string | number,
        uidOrName?: string, lang?: string, status?: number, source?: string,
    ) {
        const q: any = {};
        let invalid = false;
        if (uidOrName) {
            const udoc = await UserModel.getById(domainId, +uidOrName)
                || await UserModel.getByUname(domainId, uidOrName)
                || await UserModel.getByEmail(domainId, uidOrName);
            if (udoc) q.uid = udoc._id;
            else invalid = true;
        }
        let pdocForView: Awaited<ReturnType<typeof ProblemModel.get>> | null = null;
        const canViewAllRecords = canViewAllDomainRecords(this.user);
        if (pid) {
            pdocForView = await ProblemModel.get(domainId, pid, ProblemModel.PROJECTION_LIST);
            if (pdocForView) q.pid = pdocForView.docId;
            else invalid = true;
        }
        const problemRecordList = !!pdocForView && !invalid;
        if (!canViewAllRecords) {
            if (problemRecordList) {
                this.checkPerm(PERM.PERM_VIEW_PROBLEM);
            } else if (q.uid !== undefined && q.uid !== this.user._id) {
                this.checkPerm(PERM.PERM_VIEW_RECORD);
            } else {
                q.uid = this.user._id;
            }
        }
        if (lang) q.lang = lang;
        if (typeof status === 'number') q.status = status;
        // 来源：practice=题库练习，contest=作业/比赛，空=全部。
        // 学生只能看到自己的作业提交；查看他人或本题全部提交时仍只返回题库记录，避免比赛期间泄题。
        const selfOnly = q.uid !== undefined && q.uid === this.user._id;
        let src = source === 'practice' || source === 'contest' ? source : '';
        if (!canViewAllRecords && !selfOnly) src = 'practice';
        if (src === 'practice') q.contest = null;
        else if (src === 'contest') q.contest = { $ne: null };
        const canFilterSource = canViewAllRecords || !problemRecordList;
        const projection: Record<string, 1> = {};
        for (const key of RecordModel.PROJECTION_LIST) projection[key] = 1;
        const [rdocs, rpcount] = invalid
            ? [[], 0]
            : await this.paginate(
                RecordModel.getMulti(domainId, q).sort('_id', -1).project(projection),
                page,
                'record',
            );
        const canViewHidden = this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id;
        const [udict, pdict] = await Promise.all([
            UserModel.getList(domainId, rdocs.map((rdoc) => rdoc.uid)),
            this.user.hasPerm(PERM.PERM_VIEW_PROBLEM)
                ? ProblemModel.getList(domainId, rdocs.map((rdoc) => rdoc.pid), canViewHidden, false, ProblemModel.PROJECTION_LIST)
                : {},
        ]);
        const running = new Set([STATUS.STATUS_JUDGING, STATUS.STATUS_COMPILING, STATUS.STATUS_FETCHED]);
        const records = rdocs.map((rdoc) => {
            const pdoc = pdict[rdoc.pid];
            const visible = pdoc && pdoc.title && pdoc.title !== '*';
            const udoc = udict[rdoc.uid];
            return {
                id: rdoc._id,
                statusKey: recordStatusLabel(rdoc.status),
                code: STATUS_CODES[rdoc.status] || '',
                progress: running.has(rdoc.status) && typeof rdoc.progress === 'number' ? rdoc.progress : null,
                score: typeof rdoc.score === 'number' ? rdoc.score : '—',
                time: rdoc.time ? `${Math.round(rdoc.time)}ms` : '—',
                memory: rdoc.memory ? memoryText(rdoc.memory) : '—',
                lang: SettingModel.langs[rdoc.lang]?.display || rdoc.lang || '—',
                problem: visible ? pdoc.title : '*',
                problemLink: visible ? (pdoc.pid || pdoc.docId) : '',
                user: udoc?.uname || '—',
                uid: rdoc.uid,
                submittedAt: rdoc._id,
            };
        });
        this.view('dtoj_record', {
            problemRecordList,
            pdoc: pdocForView,
            records,
            langs: langChoices(),
            statuses: Object.entries(STATUS_TEXTS).map(([id]) => ({
                id,
                text: recordStatusLabel(Number(id)),
            })),
            uidOrName: uidOrName || '',
            pid: pid || '',
            lang: lang || '',
            status: typeof status === 'number' ? String(status) : '',
            source: src,
            canFilterSource,
            page,
            pages: rpcount,
            qs: queryString({
                uidOrName, pid, lang, status, source: src || undefined,
            }),
        });
    }
}

class DtojRecordDetailHandler extends RecordDetailHandler {
    @param('rid', Types.ObjectId)
    async prepare(domainId: string, rid: ObjectId) {
        this.rdoc = await RecordModel.get(domainId, rid);
        if (!this.rdoc) throw new RecordNotFoundError(rid);
        const isOwnOrTeammate = await contest.isOwnOrTeammateRecord(domainId, this.rdoc, this.user._id);
        if (!canViewPracticeRecordDetail(this.user, this.rdoc, isOwnOrTeammate)) {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
    }

    @param('rid', Types.ObjectId)
    @param('download', Types.Boolean)
    @param('rev', Types.ObjectId, true)
    async get(domainId: string, rid: ObjectId, download = false, rev?: ObjectId) {
        await super.get(domainId, rid, download, rev);
        if (download || !this.response.body?.rdoc) return;
        const body = this.response.body;
        const isOwnOrTeammate = this.rdoc.uid === this.user._id
            || await contest.isOwnOrTeammateRecord(domainId, this.rdoc, this.user._id);
        const psdoc = body.pdoc
            ? await ProblemModel.getStatus(domainId, body.pdoc.docId, this.user._id)
            : null;
        const allowCode = canViewRecordSourceCode(this.user, this.rdoc, psdoc, isOwnOrTeammate);
        if (!allowCode) {
            body.rdoc = { ...body.rdoc, code: '', files: {}, compilerTexts: [] };
        } else if (!body.rdoc.code && this.rdoc.code) {
            body.rdoc = {
                ...body.rdoc,
                code: this.rdoc.code,
                files: this.rdoc.files,
                compilerTexts: this.rdoc.compilerTexts,
            };
        }
        Object.assign(body, buildDtojRecordDetailView(this, {
            rdoc: body.rdoc,
            pdoc: body.pdoc,
            udoc: body.udoc,
        }));
        body.codeLocked = !allowCode && !isOwnOrTeammate;
        this.response.template = 'dtoj_record_detail.html';
    }
}

class DtojRecordDetailConnectionHandler extends RecordDetailConnectionHandler {
    @param('rid', Types.ObjectId)
    @param('noTemplate', Types.Boolean, true)
    async prepare(domainId: string, rid: ObjectId, noTemplate = false) {
        await super.prepare(domainId, rid, noTemplate);
        if (this.canViewCode) return;
        const rdoc = await RecordModel.get(domainId, rid);
        if (!rdoc || rdoc.contest) return;
        const isOwn = rdoc.uid === this.user._id;
        if (isOwn) return;
        const psdoc = await ProblemModel.getStatus(domainId, rdoc.pid, this.user._id);
        if (canViewRecordSourceCode(this.user, rdoc, psdoc, false)) this.canViewCode = true;
    }

    async sendUpdate(rdoc: import('hydrooj/src/interface').RecordDoc) {
        if (this.noTemplate) {
            this.send({ rdoc });
            return;
        }
        this.send({
            status: rdoc.status,
            status_html: await this.renderHTML('dtoj_record_detail_status.html', {
                rdoc,
                pdoc: this.pdoc,
                caseFiles: buildCaseFileUrlMap(this as any, this.pdoc, rdoc),
                canViewCaseFiles: canViewProblemTestdataFiles(this as any, this.pdoc),
            }),
            summary_html: await this.renderHTML('dtoj_record_detail_summary.html', { rdoc, pdoc: this.pdoc }),
        });
    }
}

function dropEarlierWs(ctx: Context, path: string) {
    const stack = (ctx as any).server.router.wsStack as { regexp: RegExp }[];
    const hits = stack.filter((layer) => layer.regexp.test(path));
    for (const layer of hits.slice(0, -1)) {
        const index = stack.indexOf(layer);
        if (index >= 0) stack.splice(index, 1);
    }
}

export async function apply(ctx: Context) {
    ctx.Route('record_main', '/record', DtojRecordHandler);
    ctx.Route('record_detail', '/record/:rid', DtojRecordDetailHandler);
    ctx.Connection('record_detail_conn', '/record-detail-conn', DtojRecordDetailConnectionHandler);
    dropEarlierRoutes(ctx, ['/record', '/record/:rid']);
    dropEarlierWs(ctx, '/record-detail-conn');
    for (const lang of ['zh', 'zh_TW', 'en', 'kr']) {
        ctx.i18n.load(lang, { dtoj_record: '评测记录', record_detail: '记录详情' });
    }
}
