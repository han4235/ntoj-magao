import { escapeRegExp } from 'lodash';
import {
    canViewAllDomainRecords, ContestModel, ContestNotFoundError, Context, CreateError as Err, db, DocumentModel,
    DomainModel, ForbiddenError, Handler,
    HomeworkNotAttendedError, HomeworkNotLiveError, moment, NotAssignedError, ObjectId, OplogModel, param,
    PERM, PermissionError, ProblemModel, ProblemNotFoundError, PRIV, query, RecordModel, STATUS,
    STATUS_SHORT_TEXTS,
    StorageModel, TrainingModel, Types, UserModel, ValidationError,
} from 'hydrooj';
import {
    askHomeworkQuestion, bridgeInboxReply, listHomeworkProgress, listHomeworkQuestions,
    notifyHomeworkAttended, notifyHomeworkCompleted, replyHomeworkQuestion,
} from './homeworkQA';
import { applyInboxNotices } from './inboxNotices';
import { notifyGroupSubmission } from './groupActivity';
import {
    assignSignature, homeworkMergeGroups, mergeAssignLabel, mergedPids, mergedWindow, pickMergeTarget,
} from './homeworkMerge';
import { emptyHomeworks, hasHomeworkSubmission, homeworkRosterStats, myAttendedHomeworkIds, myCompletedHomeworks, classCompletedHomeworks, myHomeworkGroups } from './homeworkScope';
import {
    addableGroupMembers, applyUserGroups, canManageGroups, groupAdminUids, groupCreators, groupOwnedBy,
    groupOwnerUids, groupUsageCounts, HIDDEN_DOMAIN_USER_IDS, joinableGroups, manageableGroups,
    managesAllGroups, memberNames, myGroupNames, ownsGroup,
} from './userGroups';
import {
    CreateStudentsResult, createStudents, initStudentPasswords, listStudents, setStudentNote,
    studentNotesForUsers,
    STUDENT_DEFAULT_PASSWORD, studentRoleName,
} from './domainUsers';

export { studentNotesForUsers } from './domainUsers';
export { hasHomeworkSubmission, myAttendedHomeworkIds, myHomeworkGroups, myPendingHomework } from './homeworkScope';

/** 交过题的作业不给撤认领，见 DtojHomeworkUnclaimHandler 与 hasHomeworkSubmission。 */
export const HomeworkSubmittedError = Err(
    'HomeworkSubmittedError',
    ForbiddenError,
    '这套作业已经交过题了，撤销认领会把认领记录和成绩一起清掉，先跟老师确认。',
);

const DOMAIN_ROLE_SETTING_KEYS = new Set(['default.userRole', 'default.teacherRole']);
const LESSON_COLL = 'dtoj_lesson_prep';

interface LessonPrepDoc {
    _id: ObjectId;
    domainId: string;
    owner: number;
    title: string;
    group: string;
    startAt: Date;
    endAt: Date;
    pids: number[];
    trainingId?: ObjectId | null;
    trainingNodeId?: number | null;
    createdAt: Date;
    updatedAt: Date;
}

declare module 'hydrooj' {
    interface Collections {
        dtoj_lesson_prep: LessonPrepDoc;
    }
}

/**
 * 题目页「添加作业」建的作业用的扣分规则，抄自 partials/homework_default_penalty_rules.yaml。
 *
 * 这份作业的截止（penaltySince）与结束（endAt）是同一时刻，延期窗口为 0，规则本身用不上；
 * 留着是为了老师事后在作业编辑页加了延期天数时，扣分能照常生效而不是撞上 undefined。
 */
const HOMEWORK_PENALTY_RULES = {
    1: 0.9, 3: 0.8, 12: 0.75, 9999: 0.5,
};

/**
 * 加一个月。
 *
 * JS 的 setMonth 会让 1-31 溢出成 3-3 这种日子，所以先把日号压到月初、加完月份再把
 * 日号放回去，放不回去就夹到目标月最后一天（3-31 → 4-30），与 moment 的行为一致。
 */
function addOneMonth(from: Date) {
    const day = from.getDate();
    const to = new Date(from);
    to.setDate(1);
    to.setMonth(to.getMonth() + 1);
    const lastDay = new Date(to.getFullYear(), to.getMonth() + 1, 0).getDate();
    to.setDate(Math.min(day, lastDay));
    return to;
}

/** 按用户时区把时间点写成「YYYY-MM-DD HH:mm」，给弹层里的时间提示用。 */
function timeText(date: Date, timeZone: string) {
    // sv-SE 给的是 ISO 形状的「YYYY-MM-DD HH:mm:ss」，裁掉秒即可
    return date.toLocaleString('sv-SE', { timeZone }).slice(0, 16);
}

/**
 * 「添加作业」弹层里可勾的分组与人员。
 *
 * 两边的取值都直接当 assign 提交：真分组用组名，按人布置用 uid 的字符串
 * （listGroup 会为每个 uid 合成一条同名的组，见 homeworkScope.ts）。
 */
async function homeworkAssignOptions(domainId: string) {
    const [groups, dudocs] = await Promise.all([
        UserModel.listGroup(domainId),
        DomainModel.getMultiUserInDomain(domainId, { join: true }).project({ uid: 1 }).toArray(),
    ]);
    const udict = await UserModel.getList(domainId, dudocs.map((d) => d.uid));
    const students = Object.values(udict)
        .filter((u) => u.hasPriv(PRIV.PRIV_USER_PROFILE) && !HIDDEN_DOMAIN_USER_IDS.has(u._id))
        .map((u) => ({ uid: u._id, uname: u.uname, name: u.displayName || u.uname }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return {
        groups: groups.map((g) => ({ name: g.name, count: g.uids?.length || 0 })),
        students,
    };
}

function filterDomainUserRudocs(rudocs: Record<string, { _id: number }[]>) {
    for (const role of Object.keys(rudocs)) {
        rudocs[role] = rudocs[role].filter((u) => !HIDDEN_DOMAIN_USER_IDS.has(u._id));
        if (!rudocs[role].length) delete rudocs[role];
    }
}

async function domainRoleSelectRange(domainId: string) {
    const roles = await DomainModel.getRoles(domainId);
    const range: Record<string, string> = {};
    for (const role of roles) {
        if (role._id === 'guest') continue;
        range[role._id] = role._id;
    }
    return range;
}

export function queryOf(handler: Handler, key: string) {
    const raw = handler.args[key];
    if (Array.isArray(raw)) return String(raw[0] || '');
    if (raw == null) return '';
    return String(raw);
}

export function pick(raw: string, allowed: string[], fallback: string) {
    return allowed.includes(raw) ? raw : fallback;
}

export function queryString(parts: Record<string, string | number | undefined>) {
    return Object.entries(parts)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
        .join('&');
}

export class DtojPageHandler extends Handler {
    noCheckPermView = true;

    view(name: string, body: Record<string, any> = {}) {
        this.response.template = `${name}.html`;
        this.response.body = body;
    }
}

export class DtojDataHandler extends DtojPageHandler {
    noCheckPermView = false;
}

/**
 * 作业列表。行为对齐 core 的 HomeworkMainHandler，改两件事：
 *
 * 一、没有「看全部作业」权限的人（学生）不再看到分给别人的作业。
 *    core 的过滤条件里有一条 `assign: { $size: 0 }`，意思是没指定给任何人的作业对全站可见，
 *    于是学生会在列表里看到别人班的作业。这里把这条去掉，学生只看两类：
 *      - assign 命中自己的用户组（含按 uid 单点布置）→ 待认领或已认领的作业
 *      - 自己已经认领过的（哪怕后来被移出用户组）→ 历史作业
 *
 * 二、教师之间互相隔离。教师名下的组归他，列表里只出现「自己发的 + 分到自己组的」
 *    作业，别的老师布置的看不到；小组筛选也只列自己名下那几个。
 *    管理员（能管全部分组）不受限，并且多一个「教师」筛选：先选老师再选他的小组。
 *
 * 另外给每行补 hwAssigned / hwAttended，让页面能标出「待认领 / 已认领」。
 */
class DtojHomeworkMainHandler extends DtojPageHandler {
    // 小组是多选，重复的 group 参数由 ArrayOf 收成数组；空值在这里先过一遍再按库里真实组名核验
    @param('group', Types.ArrayOf(Types.String, true), true)
    @param('teacher', Types.PositiveInt, true)
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    @param('from', Types.Date, true)
    @param('to', Types.Date, true)
    @param('classQ', Types.String, true)
    @param('classGroup', Types.ArrayOf(Types.String, true), true)
    @param('classFrom', Types.Date, true)
    @param('classTo', Types.Date, true)
    async get(
        domainId: string, groupPicked: string[] = [], teacherPick: number, page = 1, q = '',
        fromDate = '', toDate = '', classQ = '', classGroupPicked: string[] = [],
        classFromDate = '', classToDate = '',
    ) {
        const canViewAll = this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK);
        const loggedIn = this.user.hasPriv(PRIV.PRIV_USER_PROFILE);
        // 管理员 = 能管全部分组（域主与 root 有这一位，教师只有 MANAGE_GROUP）；教师 = 其余能看全部作业的人
        const isAdmin = managesAllGroups(this.user);
        const isTeacher = !isAdmin && canViewAll;
        // 管理员按教师筛；教师、学生一律看自己的口径，传进来的 teacher 直接忽略
        const teacher = isAdmin && teacherPick ? teacherPick : null;

        // 能看到的小组：管理员全部、教师只有自己名下的、学生只有自己加入的
        const groups = await UserModel.listGroup(domainId, canViewAll ? undefined : this.user._id);
        const ownedGroups = groups.filter((gdoc) => groupOwnedBy(gdoc, this.user._id));
        const visibleGroups = isAdmin ? groups : isTeacher ? ownedGroups : groups;
        // 没有 owner 的老组算在管理员头上，选教师的时候才有人能认领它们
        const adminUids = isAdmin ? await groupAdminUids(domainId) : new Set<number>();
        const ownerUidsOf = (gdoc: { owner?: number, maintainers?: number[] }) => groupOwnerUids(gdoc, adminUids);
        // 组名里可能有中文和空格，所以不用 Types.Name 做 saslprep 归一化，直接跟库里的名字比
        const groupNames = visibleGroups.map((gdoc) => gdoc.name);
        const picked = [...new Set(groupPicked.map((name) => (name || '').trim()).filter(Boolean))];
        const unknown = picked.find((name) => !groupNames.includes(name));
        if (unknown) throw new NotAssignedError(unknown);

        const myGroups = loggedIn ? await myHomeworkGroups(domainId, this.user._id) : [];
        const classroomGroups = myGroups.filter((name) => !/^\d+$/.test(name));
        const pickedClassGroups = [...new Set(classGroupPicked.map((name) => (name || '').trim()).filter(Boolean))];
        const unknownClassGroup = pickedClassGroups.find((name) => !classroomGroups.includes(name));
        if (unknownClassGroup) throw new NotAssignedError(unknownClassGroup);
        const attended = loggedIn ? await myAttendedHomeworkIds(domainId, this.user._id) : new Set<string>();
        const tz = this.user.timeZone || 'Asia/Shanghai';

        // 学生的课堂练习直接来自其所属小组的备课；开课后持续可见，不因结束时间而收起。
        // 训练章节来源的课时一开放就自动加入课程；TrainingModel.enroll 对重复参加有幂等保护。
        const classroomLessons: any[] = [];
        let classroomRefreshAt: number | null = null;
        let classFrom = classFromDate;
        let classTo = classToDate;
        if (classFrom && classTo && classFrom > classTo) [classFrom, classTo] = [classTo, classFrom];
        if (loggedIn && !canViewAll && myGroups.length) {
            const now = new Date();
            const classroomFilter: Record<string, any> = {
                domainId,
                group: { $in: pickedClassGroups.length ? pickedClassGroups : myGroups },
                startAt: { $lte: now },
            };
            const classFromAt = classFrom ? moment.tz(classFrom, 'YYYY-MM-DD', tz).startOf('day').toDate() : null;
            const classToAt = classTo ? moment.tz(classTo, 'YYYY-MM-DD', tz).endOf('day').toDate() : null;
            if (classFromAt || classToAt) classroomFilter.$and = [];
            if (classFromAt) classroomFilter.$and.push({ endAt: { $gte: classFromAt } });
            if (classToAt) classroomFilter.$and.push({ startAt: { $lte: classToAt } });
            if (classQ) {
                const escaped = escapeRegExp(classQ.toLowerCase());
                const pattern = new RegExp(classQ.length >= 2 ? escaped : `\\A${escaped}`, 'gim');
                classroomFilter.$or = [{ title: pattern }, { group: pattern }];
            }
            const activeDocs = await db.collection(LESSON_COLL).find(classroomFilter)
                .sort({ startAt: -1 }).toArray();
            const upcoming = await db.collection(LESSON_COLL).find({
                domainId,
                group: { $in: myGroups },
                startAt: { $gt: now },
            }).sort({ startAt: 1 }).limit(1).toArray();
            const trainingIds = [...new Map(activeDocs
                .map((lesson) => lesson.trainingId)
                .filter((id): id is ObjectId => id instanceof ObjectId)
                .map((id) => [id.toHexString(), id])).values()];
            const trainingDocs = trainingIds.length
                ? await TrainingModel.getMulti(domainId, { docId: { $in: trainingIds } }).toArray()
                : [];
            const trainingById = new Map(trainingDocs.map((doc) => [doc.docId.toHexString(), doc]));
            for (const id of trainingIds) {
                if (!trainingById.has(id.toHexString())) continue;
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await TrainingModel.enroll(domainId, id, this.user._id);
                } catch (err) {
                    const name = String((err as any)?.name || (err as any)?.constructor?.name || '');
                    if (!name.includes('TrainingAlreadyEnroll')) throw err;
                }
            }
            const classroomPids = [...new Set(activeDocs.flatMap((lesson) => lesson.pids || []))];
            const classroomPdict = await ProblemModel.getList(
                domainId, classroomPids,
                this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id,
                false,
            );
            classroomLessons.push(...activeDocs.map((lesson) => {
                const training = lesson.trainingId ? trainingById.get(lesson.trainingId.toHexString()) : null;
                return {
                    id: lesson._id,
                    title: lesson.title,
                    group: lesson.group,
                    start: moment(lesson.startAt).tz(tz).format('YYYY-MM-DD HH:mm'),
                    end: moment(lesson.endAt).tz(tz).format('YYYY-MM-DD HH:mm'),
                    trainingId: training?.docId,
                    trainingTitle: training?.title,
                    problems: (lesson.pids || []).map((pid: number) => {
                        const pdoc = classroomPdict[pid];
                        return {
                            pid,
                            title: pdoc?.title || '题目当前不可见',
                            url: pdoc ? this.url('problem_detail', { pid: pdoc.pid || pid }) : '',
                        };
                    }),
                };
            }));
            const nextTransition = upcoming[0]?.startAt.getTime();
            if (nextTransition) classroomRefreshAt = nextTransition;
        }

        const filter: Record<string, any> = { rule: 'homework' };
        if (isTeacher) {
            // 自己发的（含按 uid 布置的）or 分到自己名下小组的
            filter.$and = [{
                $or: [
                    { owner: this.user._id },
                    { maintainer: this.user._id },
                    { assign: { $in: ownedGroups.map((gdoc) => gdoc.name) } },
                ],
            }];
        } else if (teacher) {
            // 管理员的「教师」筛选，口径与教师自己看到的范围一致
            filter.$and = [{
                $or: [
                    { owner: teacher },
                    { maintainer: teacher },
                    { assign: { $in: groups.filter((gdoc) => ownerUidsOf(gdoc).has(teacher)).map((gdoc) => gdoc.name) } },
                ],
            }];
        } else if (!canViewAll) {
            const scope: Record<string, any>[] = [
                { owner: this.user._id },
                { maintainer: this.user._id },
                { assign: { $in: myGroups } },
            ];
            if (attended.size) scope.push({ _id: { $in: [...attended] } });
            filter.$or = scope;
        }
        if (picked.length) filter.assign = { $in: picked };
        if (q) {
            const escaped = escapeRegExp(q.toLowerCase());
            filter.title = { $regex: new RegExp(q.length >= 2 ? escaped : `\\A${escaped}`, 'gim') };
        }

        // 时间范围按用户所在时区整天算：起那天 00:00、止那天 23:59:59。
        // 只要作业的进行期（开始 → 最终截止）跟这段时间有重叠就列出来，
        // 这样查「这周要做哪些作业」时，跨周的作业不会漏掉。
        let from = fromDate;
        let to = toDate;
        if (from && to && from > to) [from, to] = [to, from];
        const fromAt = from ? moment.tz(from, 'YYYY-MM-DD', tz).startOf('day').toDate() : null;
        const toAt = to ? moment.tz(to, 'YYYY-MM-DD', tz).endOf('day').toDate() : null;
        if (fromAt || toAt) {
            const range: Record<string, any> = {};
            if (toAt) range.beginAt = { $lte: toAt };
            if (fromAt) range.endAt = { $gte: fromAt };
            // 权限那一段已经占了 $or，日期条件用 $and 单独放，免得把范围写串
            filter.$and = [...(filter.$and || []), range];
        }

        const cursor = ContestModel.getMulti(domainId, filter)
            .sort({ penaltySince: -1, endAt: -1, beginAt: -1, _id: -1 });
        const [tdocs, tpcount] = await this.paginate(cursor, page, 'contest');

        // 月历只画当前页：未开始/进行中的作业只占截止那天，结束的才画真实区间
        const calendar = [];
        for (const tdoc of tdocs) {
            const cal = { ...tdoc, url: this.url('homework_detail', { tid: tdoc.docId }) };
            if (ContestModel.isExtended(tdoc) || ContestModel.isDone(tdoc)) {
                cal.endAt = tdoc.endAt;
                cal.penaltySince = tdoc.penaltySince;
            } else cal.endAt = tdoc.penaltySince;
            calendar.push(cal);
        }

        // 行上要标「待认领 / 已认领」：assign 命中我就是分给我的，attend 记录我认领过没有
        const groupSet = new Set(myGroups);
        // 已认领 / 未认领都以名单为准：老师改过分配之后，被移出名单的人
        // 之前的认领记录还在库里，但那已经不算这次作业的成绩了。
        // 这两列只有看得到的人需要算，学生那边模板不渲染。
        const stats = canViewAll
            ? await homeworkRosterStats(domainId, tdocs)
            : new Map<string, { roster: Set<number> | null, claimed: Set<number> }>();
        // 徽章上的「已完成」：老师看名单上是不是人人 AC，学生看自己是不是每道题都 AC
        const myDone = loggedIn ? await myCompletedHomeworks(domainId, this.user._id, tdocs) : new Set<string>();
        const classDone = canViewAll ? await classCompletedHomeworks(domainId, tdocs, stats) : new Set<string>();
        const homeworkPids = [...new Set(tdocs.flatMap((tdoc) => tdoc.pids || []))];
        const homeworkPdict = await ProblemModel.getList(
            domainId, homeworkPids, true, false, ProblemModel.PROJECTION_CONTEST_LIST,
        );
        const rows = tdocs.map((tdoc) => {
            const stat = stats.get(String(tdoc.docId));
            return {
                ...tdoc,
                hwProblems: (tdoc.pids || []).slice(0, 2)
                    .map((pid) => homeworkPdict[pid]?.title)
                    .filter((title): title is string => Boolean(title)),
                hwAssigned: (tdoc.assign || []).some((name) => groupSet.has(name)),
                hwAttended: attended.has(String(tdoc.docId)),
                hwCompleted: (canViewAll ? classDone : myDone).has(String(tdoc.docId)),
                hwClaimed: stat ? stat.claimed.size : (tdoc.attend || 0),
                hwUnclaimed: stat?.roster ? Math.max(0, stat.roster.size - stat.claimed.size) : null,
            };
        });

        // 合并建议：同一批人收到了好几份作业，就给一个一键并成一份的入口。
        // 只对能改作业的人算；扫的是当前筛选条件下的全部作业而不是当前页，
        // 免得同一批人的作业正好分在两页时漏掉。
        const mergeGroups = [];
        if (this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK) || this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK)) {
            const canEditAll = this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
            const candidates = (await ContestModel.getMulti(domainId, filter).toArray())
                .filter((tdoc) => canEditAll || this.user.own(tdoc));
            // 「已认领」按名单口径，和作业行上那一列保持一致
            const candidateStats = await homeworkRosterStats(domainId, candidates);
            // 已结束但没人认领、没交过题的作业也允许并进来：它们只贡献题目，没有历史可改
            const empty = await emptyHomeworks(domainId, candidates);
            const mergeGroupsRaw = homeworkMergeGroups(
                candidates, (tdoc) => empty.has(String(tdoc.docId)),
            );
            // 按人布置的 assign 存的是 uid，直接摊出来就是「16」，这里换成学生名
            const numUids = new Set<number>();
            for (const mergeGroup of mergeGroupsRaw) {
                for (const name of mergeGroup.assign) if (/^\d+$/.test(name)) numUids.add(+name);
            }
            const numUdict = numUids.size
                ? await UserModel.getListForRender(domainId, [...numUids], false)
                : {};
            const nameOf = (uid: number) => numUdict[uid]?.displayName || numUdict[uid]?.uname;
            const when = (date: Date) => moment(date).tz(this.user.timeZone || 'Asia/Shanghai').format('M-D H:mm');
            for (const merge of mergeGroupsRaw) {
                const target = pickMergeTarget(merge.tdocs);
                mergeGroups.push({
                    key: merge.key,
                    label: mergeAssignLabel(merge.assign, nameOf),
                    pids: mergedPids(merge.tdocs).length,
                    targetTid: String(target.docId),
                    targetTitle: target.title,
                    tdocs: merge.tdocs.map((tdoc) => ({
                        tid: String(tdoc.docId),
                        title: tdoc.title,
                        pids: (tdoc.pids || []).length,
                        done: ContestModel.isDone(tdoc),
                        beginText: when(tdoc.beginAt),
                        penaltyText: when(tdoc.penaltySince),
                        attend: candidateStats.get(String(tdoc.docId))?.claimed.size ?? (tdoc.attend || 0),
                    })),
                });
            }
        }

        // 小组选项：名字 + 归谁管，管理员选完教师后前端按归属账号过滤这张表
        const allOwnerUids = [...new Set(visibleGroups.flatMap((gdoc) => [...ownerUidsOf(gdoc)]))];
        const ownerDict = allOwnerUids.length ? await UserModel.getListForRender(domainId, allOwnerUids, false) : {};
        const nameOfOwner = (uid?: number) => (typeof uid === 'number'
            ? ownerDict[uid]?.displayName || ownerDict[uid]?.uname || `#${uid}`
            : '');
        const groupOptions = visibleGroups
            .filter((gdoc) => !Number.isSafeInteger(+gdoc.name))
            .map((gdoc) => {
                const owners = [...ownerUidsOf(gdoc)];
                return {
                    name: gdoc.name,
                    owners,
                    // 老组没有 owner，标成「管理员」，跟小组管理页的叫法一致
                    ownerName: typeof gdoc.owner === 'number'
                        ? nameOfOwner(gdoc.owner)
                        : (owners.length ? '管理员' : ''),
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

        // 「教师」下拉只给管理员：候选 = 名下有组的 + 发过作业的 + 管理员自己，再要求这个人建得了作业
        let teacherOptions: { uid: number, name: string }[] = [];
        if (isAdmin) {
            const candidates = new Set<number>(adminUids);
            for (const gdoc of groups) {
                if (typeof gdoc.owner === 'number') candidates.add(gdoc.owner);
                for (const uid of gdoc.maintainers || []) candidates.add(uid);
            }
            const owners = await ContestModel.getMulti(domainId, { rule: 'homework' })
                .project<{ owner?: number }>({ owner: 1 })
                .toArray();
            for (const tdoc of owners) if (typeof tdoc.owner === 'number') candidates.add(tdoc.owner);
            if (teacher) candidates.add(teacher);
            // 用 getList 而不是 getListForRender：要按权限位筛掉「能出现但建不了作业」的人
            const dict = candidates.size ? await UserModel.getList(domainId, [...candidates]) : {};
            teacherOptions = [...candidates]
                .filter((uid) => !HIDDEN_DOMAIN_USER_IDS.has(uid))
                .filter((uid) => dict[uid]?.hasPerm(PERM.PERM_CREATE_HOMEWORK))
                .map((uid) => ({ uid, name: dict[uid].displayName || dict[uid].uname || `#${uid}` }))
                .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
        }

        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (teacher) params.set('teacher', String(teacher));
        for (const name of picked) params.append('group', name);
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        if (classQ) params.set('classQ', classQ);
        for (const name of pickedClassGroups) params.append('classGroup', name);
        if (classFrom) params.set('classFrom', classFrom);
        if (classTo) params.set('classTo', classTo);
        this.response.body = {
            tdocs: rows,
            classroomLessons,
            classroomRefreshAt,
            calendar,
            mergeGroups,
            tpcount,
            page,
            qs: params.toString(),
            isAdmin,
            teacher,
            teacherOptions,
            groupOptions,
            group: picked,
            classGroup: pickedClassGroups,
            q,
            from,
            to,
            classQ,
            classFrom,
            classTo,
            classroomGroups,
            hwSelfOnly: !canViewAll && loggedIn,
        };
        this.response.template = 'homework_main.html';
    }
}

/** 学生查看已开放课时的个人练习进度；仅返回当前登录者自己的题目状态。 */
class DtojClassroomLessonHandler extends DtojPageHandler {
    @param('id', Types.ObjectId)
    async get(domainId: string, id: ObjectId) {
        const lesson = await db.collection(LESSON_COLL).findOne({ _id: id, domainId });
        if (!lesson || lesson.startAt > new Date()) throw new NotAssignedError('classroom practice', id);

        const groups = await myHomeworkGroups(domainId, this.user._id);
        if (!groups.includes(lesson.group)) throw new NotAssignedError('classroom practice', id);

        const pids = [...new Set(lesson.pids || [])];
        const pdict = pids.length ? await ProblemModel.getList(
            domainId, pids,
            this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id,
            false,
        ) : {};
        const visiblePids = pids.filter((pid) => pdict[pid]?.pid);
        const statusDict = visiblePids.length
            ? await ProblemModel.getListStatus(domainId, this.user._id, visiblePids)
            : {};
        const recordIds = [...new Map(Object.values(statusDict)
            .filter((status) => status.rid instanceof ObjectId)
            .map((status) => [status.rid.toHexString(), status.rid])).values()];
        const recordRows = recordIds.length ? await RecordModel.getMulti(domainId, {
            uid: this.user._id,
            pid: { $in: visiblePids },
            _id: { $in: recordIds },
        }).project<{ _id: ObjectId, status: number }>({ _id: 1, status: 1 }).toArray() : [];
        const recordDict = Object.fromEntries(recordRows.map((record) => [record._id.toHexString(), record]));

        const problems = pids.map((pid) => {
            const pdoc = pdict[pid];
            const status = pdoc?.pid ? statusDict[pid] : null;
            const record = status?.rid ? recordDict[status.rid.toHexString()] : null;
            const statusCode = record?.status ?? status?.status;
            const statusKey = statusCode as STATUS;
            const isAccepted = statusKey === STATUS.STATUS_ACCEPTED;
            const isPending = [
                STATUS.STATUS_WAITING, STATUS.STATUS_FETCHED,
                STATUS.STATUS_COMPILING, STATUS.STATUS_JUDGING,
            ].includes(statusKey);
            return {
                pid,
                title: pdoc?.pid ? pdoc.title : '题目当前不可见',
                url: pdoc?.pid ? this.url('problem_detail', { pid: pdoc.pid || pid }) : '',
                statusText: !status ? '未提交'
                    : isAccepted ? '已通过'
                        : isPending ? '评测中' : `最近状态 ${STATUS_SHORT_TEXTS[statusKey] || '已提交'}`,
                state: !status ? 'todo' : isAccepted ? 'accepted' : isPending ? 'pending' : 'attempted',
                rid: record?._id,
            };
        });
        const acceptedCount = problems.filter((problem) => problem.state === 'accepted').length;
        const attemptedCount = problems.filter((problem) => problem.state !== 'todo').length;
        const tz = this.user.timeZone || 'Asia/Shanghai';

        this.response.template = 'classroom_lesson_detail.html';
        this.response.body = {
            title: lesson.title,
            group: lesson.group,
            start: moment(lesson.startAt).tz(tz).format('YYYY-MM-DD HH:mm'),
            end: moment(lesson.endAt).tz(tz).format('YYYY-MM-DD HH:mm'),
            problems,
            acceptedCount,
            attemptedCount,
            total: problems.length,
            progress: problems.length ? Math.round(acceptedCount * 100 / problems.length) : 0,
            trainingId: lesson.trainingId,
        };
    }
}

/**
 * 合并作业：把分给同一批人的几份作业并成一份。
 *
 * 为什么并进现成的一份而不是新建一份再删旧的：新建会换 docId，
 * 学生收藏的作业链接、站内消息里的链接全会失效；并进现成的一份，
 * 至少那条链接还能打开。优先并进还没结束的那份，这样并完作业继续在跑。
 *
 * 合并做五件事：
 *   1. 题目取并集，保留那份的题目排在最前；
 *   2. 时间只按还没结束的那几份取：最早开始、最晚截止，不因已结束的旧作业把期限往后推；
 *   3. 别处的提交先挂到保留那份的 journal 上，再改 record.contest —— 只改 record
 *      不改 journal 的话，作业成绩表里看不到这些提交；
 *   4. 认领状态补齐，学生重新打开时还是「已认领」；
 *   5. 其余几份连附件、答疑一起清掉。
 */
class DtojHomeworkMergeHandler extends DtojDataHandler {
    @param('tids', Types.CommaSeperatedArray)
    @param('title', Types.Title)
    async post(domainId: string, tids: string[], title: string) {
        const ids = [...new Set(tids.map((tid) => tid.trim()).filter(Boolean))];
        if (ids.length < 2) throw new ValidationError('tids');
        const tdocs = [];
        for (const id of ids) {
            // ContestModel.get 在文档不存在时直接抛 ContestNotFoundError，所以这里得压成 null，
            // 否则重复提交根本走不到下面的「已经并过」分支。
            const tdoc = ObjectId.isValid(id)
                ? await ContestModel.get(domainId, new ObjectId(id)).catch(() => null)
                : null;
            if (tdoc?.rule === 'homework') tdocs.push(tdoc);
        }
        // 连点两下、浏览器回退后重发、或者另一个标签页里还挂着旧弹层，都会把已经被删掉的那份
        // 再提交一遍。这时候合并其实早就做完了，直接把人和到保留的那份上，不要甩一个「找不到作业」。
        if (!tdocs.length) throw new ContestNotFoundError(domainId, ids[0]);
        if (tdocs.length === 1) {
            this.response.body = { tid: tdocs[0].docId };
            this.response.redirect = this.url('homework_detail', { tid: tdocs[0].docId });
            return;
        }
        // 已经结束的作业成绩已定，原则上不并；唯一的例外是那份「空的」——
        // 没人认领也没人交过题，并进来只是把题目挪过去，没有历史可改。
        const empty = await emptyHomeworks(domainId, tdocs);
        if (tdocs.every((tdoc) => ContestModel.isDone(tdoc))) throw new ValidationError('tids');
        for (const tdoc of tdocs) {
            if (ContestModel.isDone(tdoc) && !empty.has(String(tdoc.docId))) throw new ValidationError('tids');
        }
        // 自己建的作业可以合并；动别人建的作业要有「编辑任意作业」的权限
        if (!tdocs.every((tdoc) => this.user.own(tdoc))) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        // 只并「同一批人」的：assign 只有一个字面差别就拒绝，免得把别班的人卷进来
        if (new Set(tdocs.map((tdoc) => assignSignature(tdoc.assign))).size > 1) {
            throw new ValidationError('tids');
        }

        const target = pickMergeTarget(tdocs);
        const rest = tdocs.filter((tdoc) => String(tdoc.docId) !== String(target.docId));
        const pids = mergedPids([target, ...rest]);
        const { beginAt, penaltySince, endAt } = mergedWindow(tdocs);

        // 先搬提交：按记录的顺序写回 journal，成绩表重算出来才和原来一致
        for (const tdoc of rest) {
            const rdocs = await RecordModel.getMulti(domainId, { contest: tdoc.docId }).toArray();
            for (const rdoc of rdocs) {
                await ContestModel.updateStatus(domainId, target.docId, rdoc.uid, rdoc._id, rdoc.pid, {
                    status: rdoc.status, score: rdoc.score, subtasks: rdoc.subtasks, lang: rdoc.lang,
                });
            }
            if (rdocs.length) {
                await RecordModel.updateMulti(domainId, { contest: tdoc.docId }, { contest: target.docId });
            }
        }

        // 再搬认领：保留那份还没有这个人的认领记录时补一条，已有就跳过
        for (const tdoc of rest) {
            const tsdocs = await ContestModel.getMultiStatus(domainId, { docId: tdoc.docId, attend: { $gte: 1 } }).toArray();
            for (const tsdoc of tsdocs) {
                const existing = await ContestModel.getStatus(domainId, target.docId, tsdoc.uid);
                if (existing?.attend) continue;
                await ContestModel.attend(domainId, target.docId, tsdoc.uid);
            }
        }

        await ContestModel.edit(domainId, target.docId, {
            title, pids, beginAt, penaltySince, endAt,
        });

        // 其余几份：附件、答疑先处理掉，再把作业本身删掉（contest.del 会清状态文档）
        for (const tdoc of rest) {
            await StorageModel.del(
                (tdoc.files || []).map((file) => `contest/${domainId}/${tdoc.docId}/public/${file.name}`),
                this.user._id,
            );
            await DocumentModel.coll.updateMany(
                {
                    domainId,
                    docType: DocumentModel.TYPE_CONTEST_CLARIFICATION,
                    parentType: DocumentModel.TYPE_CONTEST,
                    parentId: tdoc.docId,
                },
                { $set: { parentId: target.docId } },
            );
            await ContestModel.del(domainId, tdoc.docId);
        }
        await ContestModel.recalcStatus(domainId, target.docId);

        this.response.body = { tid: target.docId };
        this.response.redirect = this.url('homework_detail', { tid: target.docId });
    }
}

/**
 * 撤销认领。
 *
 * core 的作业详情只有认领（HomeworkDetailHandler.postAttend），点错了没法往回走，
 * 所以在插件这侧单开一条 POST 路由，作业详情页的「取消认领」按钮指向它。
 *
 * 只在「还撤得动」时放行：自己认领过、作业没结束、且一道题都没交。最后一条是硬要求，
 * 理由见 hasHomeworkSubmission。
 */
class DtojHomeworkUnclaimHandler extends DtojDataHandler {
    @param('tid', Types.ObjectId)
    async post(domainId: string, tid: ObjectId) {
        const tdoc = await ContestModel.get(domainId, tid);
        if (tdoc?.rule !== 'homework') throw new ContestNotFoundError(domainId, tid);
        // 和作业详情页同一道门槛：不是分给我的作业，连这个接口都不该够得着
        if (tdoc.assign?.length && !this.user.own(tdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)) {
            const groups = await myHomeworkGroups(domainId, this.user._id);
            if (!new Set(tdoc.assign).intersection(new Set(groups)).size) throw new NotAssignedError('homework', tid);
        }
        this.checkPerm(PERM.PERM_ATTEND_HOMEWORK);
        const tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        if (!tsdoc?.attend) throw new HomeworkNotAttendedError(this.user._id);
        if (ContestModel.isDone(tdoc)) throw new HomeworkNotLiveError(tid);
        if (await hasHomeworkSubmission(domainId, tid, this.user._id)) throw new HomeworkSubmittedError(tid);
        await ContestModel.cancelAttend(domainId, tid, this.user._id);
        this.response.redirect = this.url('homework_detail', { tid });
    }
}

/** 这次作业算不算「我管得着」：作业归属（创建者/作业管理员）或有编辑任意作业的权限。 */
function canManageHomework(handler: Handler, tdoc: any) {
    return handler.user.own(tdoc) || handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
}

/**
 * 题目页侧栏的「添加作业」：给这道题现建一份作业，分给勾中的分组或同学。
 *
 * 为什么不复用 core 的作业编辑表单：那边新建时默认「明天零点开始、七天后截止」，
 * 而这里要的是「现在开始、一个月后截止」；走自己的入口，默认值才不用回来改。
 * assign 的语义与 core 完全一致（见 homeworkAssignOptions），建完直接跳作业详情页，
 * 想改时间或加题都在那页上做。
 */
class DtojProblemAddHomeworkHandler extends DtojDataHandler {
    @param('pid', Types.ProblemId)
    @param('title', Types.Title)
    @param('assign', Types.CommaSeperatedArray, true)
    async post(domainId: string, pid: string | number, title: string, assign: string[] = []) {
        // 校验器按逗号切但不裁空白，空值也照收，所以这里自己清一遍
        const picked = [...new Set(assign.map((i) => i.trim()).filter((i) => i))];
        if (!picked.length) throw new ValidationError('assign');
        const pdoc = await ProblemModel.get(domainId, pid);
        if (!pdoc) throw new ProblemNotFoundError(domainId, pid);
        // 看不见的隐藏题不能拿来布置；门槛与 core 的作业编辑页一致（doThrow 默认开启）
        await ProblemModel.getList(
            domainId, [pdoc.docId], this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id,
        );
        const beginAt = new Date();
        const penaltySince = addOneMonth(beginAt);
        const tid = await ContestModel.add(
            domainId, title, '', this.user._id, 'homework', beginAt, penaltySince, [pdoc.docId], false,
            { penaltySince, penaltyRules: HOMEWORK_PENALTY_RULES, assign: picked },
        );
        this.response.redirect = this.url('homework_detail', { tid });
    }
}

/**
 * 学生在作业页提问。
 *
 * 门槛和作业详情页一致：分给我的、或我认领过的才够得着；老师不受「分给谁」限制。
 * 默认私问，学生自己勾「公开」才会让同一次作业的其他人看到，见 homeworkQA。
 */
class DtojHomeworkAskHandler extends DtojDataHandler {
    @param('tid', Types.ObjectId)
    @param('content', Types.Content)
    @param('subject', Types.Int, true)
    @param('isPublic', Types.Boolean, true)
    async post(domainId: string, tid: ObjectId, content: string, subject = 0, isPublic = false) {
        const tdoc = await ContestModel.get(domainId, tid);
        if (tdoc?.rule !== 'homework') throw new ContestNotFoundError(domainId, tid);
        this.checkPerm(PERM.PERM_VIEW_HOMEWORK);
        if (!canManageHomework(this, tdoc)) {
            const groups = await myHomeworkGroups(domainId, this.user._id);
            if (tdoc.assign?.length && !new Set(tdoc.assign).intersection(new Set(groups)).size) {
                throw new NotAssignedError('homework', tid);
            }
        }
        await this.limitRate('add_discussion', 3600, 60);
        await askHomeworkQuestion(
            domainId, tdoc, this.user._id, content, !!isPublic, +subject || 0,
            this.request.ip, this.url('homework_detail', { tid }),
        );
        this.back();
    }
}

/** 老师回复一条提问。管不了这次作业的人用不了。 */
class DtojHomeworkReplyHandler extends DtojDataHandler {
    @param('tid', Types.ObjectId)
    @param('did', Types.ObjectId)
    @param('content', Types.Content)
    async post(domainId: string, tid: ObjectId, did: ObjectId, content: string) {
        const tdoc = await ContestModel.get(domainId, tid);
        if (tdoc?.rule !== 'homework') throw new ContestNotFoundError(domainId, tid);
        if (!canManageHomework(this, tdoc)) throw new ForbiddenError(PERM.PERM_EDIT_HOMEWORK);
        // 只认挂在这份作业下的提问，免得拿别的作业的 did 来回帖
        const qdoc = await DocumentModel.get(domainId, DocumentModel.TYPE_CONTEST_CLARIFICATION, did);
        if (!qdoc || String(qdoc.parentId) !== String(tid)) throw new ContestNotFoundError(domainId, tid);
        await this.limitRate('add_discussion', 3600, 60);
        await replyHomeworkQuestion(
            domainId, tdoc, did, this.user._id, content, this.request.ip,
            this.url('homework_detail', { tid }),
        );
        this.back();
    }
}

/** 作业负责人或管理员删除答疑提问/回复；replyId 为空时删除整条提问及其回复。 */
class DtojHomeworkDeleteMessageHandler extends DtojDataHandler {
    @param('tid', Types.ObjectId)
    @param('did', Types.ObjectId)
    @param('replyId', Types.ObjectId, true)
    async post(domainId: string, tid: ObjectId, did: ObjectId, replyId?: ObjectId) {
        const tdoc = await ContestModel.get(domainId, tid);
        if (tdoc?.rule !== 'homework') throw new ContestNotFoundError(domainId, tid);
        if (!canManageHomework(this, tdoc)) throw new ForbiddenError(PERM.PERM_EDIT_HOMEWORK);

        const qdoc = await DocumentModel.get(domainId, DocumentModel.TYPE_CONTEST_CLARIFICATION, did);
        if (!qdoc || qdoc.parentType !== DocumentModel.TYPE_CONTEST || String(qdoc.parentId) !== String(tid)) {
            throw new ContestNotFoundError(domainId, tid);
        }

        if (replyId) {
            const exists = (qdoc.reply || []).some((reply: any) => String(reply._id) === String(replyId));
            if (!exists) throw new ValidationError('replyId');
            await DocumentModel.deleteSub(domainId, DocumentModel.TYPE_CONTEST_CLARIFICATION, did, 'reply', replyId);
            await OplogModel.log(this, 'dtoj.homeworkQA.deleteReply', {
                domainId, tid: String(tid), did: String(did), replyId: String(replyId),
            });
        } else {
            await DocumentModel.deleteOne(domainId, DocumentModel.TYPE_CONTEST_CLARIFICATION, did);
            await OplogModel.log(this, 'dtoj.homeworkQA.deleteQuestion', {
                domainId, tid: String(tid), did: String(did),
            });
        }
        this.response.redirect = this.url('homework_detail', { tid });
    }
}

/**
 * 自助加入分组。
 *
 * 个人主页的「加入分组」弹层提交到这里：勾上的加进去，取消勾选的把我摘出来。
 * 只能改自己的组籍，管理员那边另有 /domain/group 管全部。规则见 userGroups.ts。
 */
class DtojUserGroupHandler extends Handler {
    noCheckPermView = true;

    @param('uid', Types.Int)
    @param('groups', Types.CommaSeperatedArray, true)
    async post(domainId: string, uid: number, groups: string[] = []) {
        if (uid !== this.user._id) throw new ForbiddenError('Not your own profile');
        await applyUserGroups(domainId, this.user._id, new Set(groups));
        this.response.redirect = this.url('user_detail', { uid });
    }
}

/**
 * 教师视角的小组管理。
 *
 * 为什么不复用 /domain/group：那个页面的门槛是 PERM_EDIT_DOMAIN（拿到就等于拿到整个域，
 * 连角色表都能改），组员还是个裸 uid 输入框。这边只要管组权限，组员从名单里勾。
 *
 * 三条硬约束，理由分散在下面各处：
 *   1. 只看得见、只能动自己名下的组（除非有 PERM_MANAGE_GROUP_ALL）
 *   2. 组名建完不许改 —— tdoc.assign 存的就是组名字符串，改名会让历史分派全断
 *   3. 只能加没有管理权限的账号 —— 组参与 assign，不能拿它给自己开门
 */
function requireGroupManager(handler: Handler) {
    if (!canManageGroups(handler.user)) throw new PermissionError(PERM.PERM_MANAGE_GROUP);
}

/** 取出这个组并要求归我管。不存在的组、别人的组，一律按没权限处理，不区分对待。 */
async function requireMyGroup(handler: Handler, domainId: string, name: string) {
    const [gdoc] = await UserModel.listGroup(domainId, undefined, [name]);
    if (!gdoc || !ownsGroup(handler.user, gdoc)) throw new PermissionError(PERM.PERM_MANAGE_GROUP);
    return gdoc;
}

class DtojGroupHandler extends DtojDataHandler {
    // 这个 get 没有查询参数、也就没有 @param，而 domainId 的注入是挂在 @param 上面的
    // （见 framework/framework/decorators.ts 的 domainIdStyle 分支），所以这里照 core 的
    // DomainUserGroupHandler 那样从 args 里取，别写成 get(domainId: string)。
    async get({ domainId }: { domainId: string }) {
        requireGroupManager(this);
        const [groups, members] = await Promise.all([
            manageableGroups(domainId, this.user),
            addableGroupMembers(domainId),
        ]);
        const usage = await groupUsageCounts(domainId, groups.map((gdoc) => gdoc.name));
        const creators = await groupCreators(domainId, groups);
        // 组员里可能有不在「可加入」名单上的人（后来当了老师之类），名字单独取一遍
        const uids = new Set<number>(members.map((m) => m.uid));
        for (const gdoc of groups) for (const uid of gdoc.uids || []) uids.add(uid);
        const creatorOptions = [...new Set(groups.map((gdoc) => creators[gdoc.name]))]
            .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        this.view('dtoj_domain_group', {
            groups: groups.map((gdoc) => ({
                name: gdoc.name,
                mine: gdoc.owner === this.user._id,
                creator: creators[gdoc.name],
                uids: [...(gdoc.uids || [])],
                used: usage[gdoc.name] || 0,
            })),
            creatorOptions,
            members,
            names: await memberNames(domainId, [...uids]),
            canManageAll: managesAllGroups(this.user),
        });
    }
}

/** 建组。组名不可重复、建完不可改；owner 记成建组人。 */
class DtojGroupCreateHandler extends DtojDataHandler {
    @param('name', Types.Name)
    async post(domainId: string, name: string) {
        requireGroupManager(this);
        const want = (name || '').trim();
        // 纯数字的组名要挡掉：UserModel.listGroup 会给每个 uid 补一条同名合成组，
        // 建一个叫「16」的组，assign 里的「16」就分不清是人还是组了
        if (Number.isSafeInteger(+want)) throw new ValidationError('name');
        if (!await UserModel.createGroup(domainId, want, this.user._id)) {
            throw new ValidationError('name', null, `已经有一个叫「${want}」的小组了，换个名字`);
        }
        this.response.redirect = this.url('dtoj_group');
    }
}

/** 保存组员。逐个人按名单核过才写得进去，不靠前端那个勾选框。 */
class DtojGroupMembersHandler extends DtojDataHandler {
    @param('name', Types.Name)
    @param('uids', Types.NumericArray, true)
    async post(domainId: string, name: string, uids: number[] = []) {
        const gdoc = await requireMyGroup(this, domainId, name);
        const allowed = new Set((await addableGroupMembers(domainId)).map((m) => m.uid));
        const current = new Set(gdoc.uids || []);
        // 名单外的老组员原样留着，这次只是改不动他们 —— 老师一保存就把老数据抹掉更糟
        const want = new Set([...current].filter((uid) => !allowed.has(uid)));
        for (const uid of uids) if (allowed.has(uid)) want.add(uid);
        // 按人做原子的增删，不整表覆盖。学生自助加入和老师保存名单赶在一起时，
        // 覆盖式写入会把对方刚加的人抹掉，逐人增删不会
        await Promise.all([
            ...[...want].filter((uid) => !current.has(uid))
                .map((uid) => UserModel.addGroupUser(domainId, gdoc.name, uid)),
            ...[...current].filter((uid) => !want.has(uid))
                .map((uid) => UserModel.removeGroupUser(domainId, gdoc.name, uid)),
        ]);
        this.response.redirect = this.url('dtoj_group');
    }
}

/** 删自己的组。assign 里有它的作业/比赛会变成死引用，所以有引用就不给删。 */
class DtojGroupDeleteHandler extends DtojDataHandler {
    @param('name', Types.Name)
    async post(domainId: string, name: string) {
        const gdoc = await requireMyGroup(this, domainId, name);
        const usage = await groupUsageCounts(domainId, [gdoc.name]);
        const used = usage[gdoc.name] || 0;
        if (used) throw new ValidationError('name', null, `还有 ${used} 份作业或比赛在用它，先改掉那些分派再删`);
        await UserModel.delGroup(domainId, gdoc.name);
        this.response.redirect = this.url('dtoj_group');
    }
}

const DOMAIN_STUDENT_PAGE_SIZE = 30;

/**
 * 教师的「管理用户」。
 *
 * 只有三件事：看学生名单、把用户名建成学生账号、给学生重置密码。改角色、移出域、删账号
 * 这里都没有 —— 那些还归管理员的 /domain/user（那个页面的门槛是 PERM_EDIT_DOMAIN，
 * 拿到就等于拿到整个域）。范围收窄的实现在 domainUsers.ts 里：两个写入口都按「本域学生」
 * 重新核一遍，不认页面传来的角色或 uid。
 */
class DtojDomainUserHandler extends DtojDataHandler {
    @query('page', Types.PositiveInt, true)
    @query('q', Types.Content, true)
    @query('find', Types.Int, true)
    async get(domainId: string, page = 1, q = '', find?: number) {
        await this.renderPage(domainId, { page, q, find });
    }

    @param('usernames', Types.Content)
    async postCreate(domainId: string, usernames: string) {
        // 一行一个；逗号、顿号、分号也当分隔符 —— 从表格里复制出来多半是这几种
        const names = usernames.split(/[\s,，、;；]+/).filter(Boolean);
        if (!names.length) throw new ValidationError('usernames');
        const result = await createStudents(domainId, names, this.request.ip);
        await OplogModel.log(this, 'dtoj.domain.createStudents', {
            domainId, created: result.created, linked: result.linked, failed: result.failed.map((i) => i.uname),
        });
        await this.renderPage(domainId, { page: 1, result });
    }

    @param('uids', Types.NumericArray, true)
    async postInitPassword(domainId: string, uids: number[] = []) {
        const done = await initStudentPasswords(domainId, uids);
        await OplogModel.log(this, 'dtoj.domain.initStudentPassword', { domainId, uids: done });
        await this.renderPage(domainId, { page: 1, initDone: done.length });
    }

    /**
     * 列表和操作结果都从这儿出。POST 完直接重画这一页，结果就留在表单上方，
     * 省得再想一个提示条的位置（也免了跳转后被刷新重提交的尴尬）。
     */
    private async renderPage(domainId: string, opts: {
        page?: number,
        q?: string,
        find?: number,
        result?: CreateStudentsResult,
        initDone?: number,
    }) {
        const [domain, all] = await Promise.all([DomainModel.get(domainId), listStudents(domainId, opts.q)]);
        // find 是 core 那边的一栏「按 uid 找人」，这里保留是为了从别处跳过来能对上号
        const list = opts.find ? all.filter((student) => student.uid === opts.find) : all;
        const ucount = list.length;
        const upcount = Math.max(1, Math.ceil(ucount / DOMAIN_STUDENT_PAGE_SIZE));
        const page = Math.min(Math.max(1, opts.page || 1), upcount);
        this.view('dtoj_domain_user', {
            domain,
            rows: list.slice((page - 1) * DOMAIN_STUDENT_PAGE_SIZE, page * DOMAIN_STUDENT_PAGE_SIZE),
            page,
            upcount,
            ucount,
            q: opts.q || '',
            find: opts.find,
            role: studentRoleName(),
            defaultPassword: STUDENT_DEFAULT_PASSWORD,
            result: opts.result,
            initDone: opts.initDone,
        });
    }
}

/** 老师和域管理员都能维护本域学生备注；权限与目标学生身份在服务端重新核验。 */
class DtojStudentNoteHandler extends DtojDataHandler {
    noCheckPermView = true;

    @param('uid', Types.PositiveInt)
    @param('note', Types.String, true)
    async post(domainId: string, uid: number, note = '') {
        if (!this.user.hasPerm(PERM.PERM_MANAGE_STUDENT, PERM.PERM_EDIT_DOMAIN)) {
            throw new PermissionError(PERM.PERM_MANAGE_STUDENT);
        }
        const saved = await setStudentNote(domainId, uid, note);
        await OplogModel.log(this, 'dtoj.domain.setStudentNote', { domainId, uid });
        this.response.body = { ok: true, note: saved };
    }
}

/**
 * 供课件系统（ppt-system）确认「当前来访者是谁」。
 *
 * ppt-system 与 OJ 同域部署（/ppt/），浏览器会把 OJ 的 sid Cookie 一并带过去，
 * 它拿这个 Cookie 来调本接口，据此在自己那边建会话 —— 这样站内用户不必再登录一次。
 *
 * 只返回调用者自己的身份，不泄露他人信息；未登录一律 401。
 * 课件系统按「能否编辑任意题目」区分教师与访客：这比按角色名判断稳，角色名可被改动，
 * 权限位不会。本站是单域部署，所以取当前（system）域的权限。
 */
class DtojOjSessionHandler extends Handler {
    noCheckPermView = true;
    notUsage = true;

    async get() {
        // 身份相关的响应绝不能被缓存，否则会把甲的身份回给乙
        this.response.addHeader('Cache-Control', 'no-store');
        this.response.type = 'application/json';

        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            this.response.status = 401;
            this.response.body = { ok: false };
            return;
        }

        // 区分三种身份：
        //   域管理员（域内角色 root，拥有全部域权限，含 PERM_EDIT_DOMAIN）→ ADMIN
        //   教师（域内「教师」角色，含 PERM_EDIT_PROBLEM）→ TEACHER
        //   其他人（学生等）→ USER
        // 课件系统据此决定能否阅览课件，所以这里的判定要稳。
        const isAdmin = this.user.hasPerm(PERM.PERM_EDIT_DOMAIN);
        const isTeacher = this.user.hasPerm(PERM.PERM_EDIT_PROBLEM);
        this.response.body = {
            ok: true,
            uid: this.user._id,
            uname: this.user.uname,
            displayName: this.user.displayName || this.user.uname,
            role: isAdmin ? 'ADMIN' : (isTeacher ? 'TEACHER' : 'USER'),
        };
    }
}

/**
 * 顶栏未读角标的对账接口，给 nav.html 里那段实时脚本用。
 *
 * 角标本身是服务端渲染的，页面里那段脚本订阅 message 频道负责实时加一；但切到后台
 * 期间连接是断的，而且消息可能已经在别的标签页读完了 —— 单靠本地计数会挂着一个假的
 * 未读数，所以切回前台时来这里问一次真数。
 *
 * 只回自己的计数，别人的碰不到；未登录由路由上的 PRIV_USER_PROFILE 挡掉。
 */
class DtojUnreadHandler extends DtojDataHandler {
    async get() {
        this.response.addHeader('Cache-Control', 'no-store');
        this.response.type = 'application/json';
        this.response.body = { n: this.user.unreadMsg || 0 };
    }
}

export function dropEarlierRoutes(ctx: Context, paths: string[]) {
    const stack = (ctx as any).server.router.stack as { path?: string }[];
    const want = new Set(paths);
    const last = new Map<string, number>();
    for (let i = 0; i < stack.length; i++) {
        const path = stack[i].path;
        if (path && want.has(path)) last.set(path, i);
    }
    for (let i = stack.length - 1; i >= 0; i--) {
        const path = stack[i].path;
        if (path && want.has(path) && last.get(path) !== i) stack.splice(i, 1);
    }
}

function requireLessonTeacher(handler: Handler) {
    if (!canManageGroups(handler.user)) throw new PermissionError(PERM.PERM_MANAGE_GROUP);
}

function lessonTimeText(date: Date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const part = (name: string) => parts.find((item) => item.type === name)?.value || '';
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function lessonTime(value: string, field: string) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw new ValidationError(field);
    const date = new Date(`${value}:00+08:00`);
    if (Number.isNaN(date.getTime()) || lessonTimeText(date) !== value) throw new ValidationError(field);
    return date;
}

function lessonDate(value: string) {
    if (!/^\d{4}-\d\d-\d\d$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00+08:00`);
    return Number.isNaN(date.getTime()) || lessonTimeText(date).slice(0, 10) !== value ? null : date;
}

async function lessonGroups(domainId: string, handler: Handler) {
    requireLessonTeacher(handler);
    return manageableGroups(domainId, handler.user);
}

async function lessonTrainingOptions(domainId: string, handler: Handler) {
    if (!handler.user.hasPerm(PERM.PERM_VIEW_TRAINING)) return [];
    const courses = await TrainingModel.getMulti(domainId, {}).toArray();
    return courses.flatMap((course) => (course.dag || [])
        .filter((node: any) => Number.isSafeInteger(+node._id) && +node._id > 0 && node.pids?.length)
        .map((node: any) => ({
            value: `${course.docId.toHexString()}:${node._id}`,
            title: `${course.title} / ${node.title || `第 ${node._id} 章`}`,
            count: node.pids.length,
        })))
        .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
}

async function lessonProblems(domainId: string, handler: Handler, raw: string) {
    const tokens = raw.split(/[\s,，]+/).filter(Boolean);
    if (!tokens.length || tokens.length > 50) throw new ValidationError('pids');
    const pids: number[] = [];
    for (const token of tokens) {
        // eslint-disable-next-line no-await-in-loop
        const pdoc = await ProblemModel.get(domainId, token);
        if (!pdoc) throw new ValidationError('pids', null, `题库里没有题号 ${token}`);
        if (!pids.includes(pdoc.docId)) pids.push(pdoc.docId);
    }
    await ProblemModel.getList(domainId, pids, handler.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || handler.user._id);
    return pids;
}

async function lessonProblemSource(domainId: string, handler: Handler, trainingChapter: string, rawPids: string) {
    if (!trainingChapter) {
        return { pids: await lessonProblems(domainId, handler, rawPids), trainingId: null, trainingNodeId: null };
    }
    if (!handler.user.hasPerm(PERM.PERM_VIEW_TRAINING)) throw new PermissionError(PERM.PERM_VIEW_TRAINING);
    const match = trainingChapter.match(/^([a-f\d]{24}):(\d+)$/i);
    if (!match || !ObjectId.isValid(match[1])) throw new ValidationError('trainingChapter');
    const trainingId = new ObjectId(match[1]);
    const trainingNodeId = Number(match[2]);
    if (!Number.isSafeInteger(trainingNodeId) || trainingNodeId < 1) throw new ValidationError('trainingChapter');
    const course = await TrainingModel.get(domainId, trainingId).catch(() => null);
    const chapter = course?.dag?.find((node: any) => +node._id === trainingNodeId);
    if (!course || !chapter?.pids?.length) throw new ValidationError('trainingChapter');
    const pids = Array.from(new Set<number>(
        (chapter.pids as number[]).map((pid) => Number(pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    ));
    if (!pids.length) throw new ValidationError('trainingChapter');
    await ProblemModel.getList(
        domainId, pids,
        handler.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || handler.user._id,
    );
    return { pids, trainingId, trainingNodeId };
}

async function lessonEditDoc(domainId: string, handler: Handler, id: ObjectId) {
    requireLessonTeacher(handler);
    const doc = await db.collection(LESSON_COLL).findOne({ _id: id, domainId });
    if (!doc || (!managesAllGroups(handler.user) && doc.owner !== handler.user._id)) {
        throw new PermissionError(PERM.PERM_MANAGE_GROUP);
    }
    return doc;
}

class DtojLessonPrepHandler extends DtojDataHandler {
    @query('from', Types.String, true)
    @query('to', Types.String, true)
    @query('teacher', Types.PositiveInt, true)
    async get({ domainId }: { domainId: string }, from = '', to = '', teacherPick?: number) {
        const groups = await lessonGroups(domainId, this);
        const isAdmin = managesAllGroups(this.user);
        const adminUids = isAdmin ? await groupAdminUids(domainId) : new Set<number>();
        let teacherOptions: { uid: number, name: string }[] = [];
        if (isAdmin) {
            const candidates = new Set<number>(adminUids);
            const members = await DomainModel.getMultiUserInDomain(domainId, { join: true })
                .project<{ uid: number }>({ uid: 1 })
                .toArray();
            for (const member of members) candidates.add(member.uid);
            for (const group of groups) {
                if (typeof group.owner === 'number') candidates.add(group.owner);
                for (const uid of group.maintainers || []) candidates.add(uid);
            }
            const users = candidates.size ? await UserModel.getList(domainId, [...candidates]) : {};
            teacherOptions = [...candidates]
                .filter((uid) => !HIDDEN_DOMAIN_USER_IDS.has(uid))
                .filter((uid) => users[uid]?.hasPerm(
                    PERM.PERM_MANAGE_GROUP_ALL, PERM.PERM_MANAGE_GROUP,
                    PERM.PERM_CREATE_HOMEWORK, PERM.PERM_EDIT_PROBLEM,
                ))
                .map((uid) => ({ uid, name: users[uid].displayName || users[uid].uname || `#${uid}` }))
                .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
        }
        const teacher = isAdmin && teacherOptions.some((item) => item.uid === teacherPick) ? teacherPick : null;
        const visibleGroups = teacher
            ? groups.filter((group) => groupOwnerUids(group, adminUids).has(teacher))
            : groups;
        const fromDate = from ? lessonDate(from) : null;
        const toDate = to ? lessonDate(to) : null;
        const invalidRange = (!!from && !fromDate) || (!!to && !toDate)
            || (!!fromDate && !!toDate && fromDate > toDate);
        const filter: Record<string, any> = {
            domainId,
            group: { $in: visibleGroups.map((group) => group.name) },
        };
        if (teacher) filter.owner = teacher;
        else if (!isAdmin) filter.owner = this.user._id;
        if (fromDate || toDate) {
            filter.startAt = {};
            if (fromDate) filter.startAt.$gte = fromDate;
            if (toDate) filter.startAt.$lt = new Date(toDate.getTime() + 24 * 60 * 60 * 1000);
        }
        const docs = visibleGroups.length && !invalidRange
            ? await db.collection(LESSON_COLL).find(filter).sort({ startAt: 1 }).limit(200).toArray()
            : [];
        const pids = [...new Set(docs.flatMap((doc) => doc.pids))];
        const pdict = await ProblemModel.getList(domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id, false);
        const lessons = docs.map((doc) => ({
            id: doc._id.toHexString(), title: doc.title, group: doc.group,
            start: lessonTimeText(doc.startAt).replace('T', ' '),
            end: lessonTimeText(doc.endAt).replace('T', ' '), count: doc.pids.length,
            preview: doc.pids.slice(0, 3).map((pid) => ({ pid, title: pdict[pid]?.title || `题目 #${pid}` })),
        }));
        const groupSections = visibleGroups.map((group) => ({
            name: group.name,
            lessons: lessons.filter((lesson) => lesson.group === group.name),
        }));
        this.view('dtoj_lesson_prep', {
            groups: groupSections,
            from, to, invalidRange, isAdmin, teacher, teacherOptions, hasGroups: groups.length > 0,
        });
    }
}

class DtojLessonPrepNewHandler extends DtojDataHandler {
    async get({ domainId }: { domainId: string }) {
        const [groups, trainingOptions] = await Promise.all([lessonGroups(domainId, this), lessonTrainingOptions(domainId, this)]);
        this.view('dtoj_lesson_prep_edit', { groups: groups.map((group) => group.name), trainingOptions, lesson: null });
    }

    @param('title', Types.String)
    @param('group', Types.String)
    @param('startAt', Types.String)
    @param('endAt', Types.String)
    @param('pids', Types.String, true)
    @param('trainingChapter', Types.String, true)
    async post(domainId: string, title: string, group: string, startAt: string, endAt: string, pids = '', trainingChapter = '') {
        const groups = await lessonGroups(domainId, this);
        if (!groups.some((item) => item.name === group)) throw new ValidationError('group');
        const name = title.trim();
        if (!name || name.length > 100) throw new ValidationError('title');
        const start = lessonTime(startAt, 'startAt');
        const end = lessonTime(endAt, 'endAt');
        if (end <= start) throw new ValidationError('endAt');
        const source = await lessonProblemSource(domainId, this, trainingChapter, pids);
        const now = new Date();
        await db.collection(LESSON_COLL).insertOne({
            _id: new ObjectId(), domainId, owner: this.user._id, title: name, group,
            startAt: start, endAt: end, pids: source.pids,
            trainingId: source.trainingId, trainingNodeId: source.trainingNodeId,
            createdAt: now, updatedAt: now,
        });
        this.response.redirect = this.url('dtoj_lesson_prep');
    }
}

class DtojLessonPrepEditHandler extends DtojDataHandler {
    @param('id', Types.ObjectId)
    async get(domainId: string, id: ObjectId) {
        const [doc, groups, trainingOptions] = await Promise.all([
            lessonEditDoc(domainId, this, id), lessonGroups(domainId, this), lessonTrainingOptions(domainId, this),
        ]);
        this.view('dtoj_lesson_prep_edit', {
            groups: groups.map((group) => group.name),
            trainingOptions,
            lesson: {
                id: doc._id.toHexString(), title: doc.title, group: doc.group,
                startAt: lessonTimeText(doc.startAt), endAt: lessonTimeText(doc.endAt), pids: doc.pids.join(','),
                trainingChapter: doc.trainingId && doc.trainingNodeId ? `${doc.trainingId.toHexString()}:${doc.trainingNodeId}` : '',
            },
        });
    }

    @param('id', Types.ObjectId)
    @param('title', Types.String)
    @param('group', Types.String)
    @param('startAt', Types.String)
    @param('endAt', Types.String)
    @param('pids', Types.String, true)
    @param('trainingChapter', Types.String, true)
    async post(domainId: string, id: ObjectId, title: string, group: string, startAt: string, endAt: string, pids = '', trainingChapter = '') {
        await lessonEditDoc(domainId, this, id);
        const groups = await lessonGroups(domainId, this);
        if (!groups.some((item) => item.name === group)) throw new ValidationError('group');
        const name = title.trim();
        if (!name || name.length > 100) throw new ValidationError('title');
        const start = lessonTime(startAt, 'startAt');
        const end = lessonTime(endAt, 'endAt');
        if (end <= start) throw new ValidationError('endAt');
        const source = await lessonProblemSource(domainId, this, trainingChapter, pids);
        await db.collection(LESSON_COLL).updateOne({ _id: id, domainId }, {
            $set: {
                title: name, group, startAt: start, endAt: end, pids: source.pids,
                trainingId: source.trainingId, trainingNodeId: source.trainingNodeId, updatedAt: new Date(),
            },
        });
        this.response.redirect = this.url('dtoj_lesson_prep');
    }
}

class DtojLessonPrepDeleteHandler extends DtojDataHandler {
    @param('id', Types.ObjectId)
    async post(domainId: string, id: ObjectId) {
        await lessonEditDoc(domainId, this, id);
        await db.collection(LESSON_COLL).deleteOne({ _id: id, domainId });
        this.response.redirect = this.url('dtoj_lesson_prep');
    }
}

const nav: [string, string, string][] = [
    ['homepage', 'dtoj_home', '首页'],
    ['dtoj_problems', 'dtoj_problems', '题库'],
    ['training_main', 'dtoj_training', '训练'],
    ['homework_main', 'homework', '作业'],
    ['contest_main', 'dtoj_contest', '比赛'],
    ['record_main', 'dtoj_record', '评测记录'],
    ['home_messages', 'home_messages', '站内消息'],
    ['dtoj_community', 'dtoj_community', '社区'],
    ['discussion_main', 'dtoj_discuss', '讨论'],
    ['dtoj_shop', 'dtoj_shop', '神秘商店'],
];

export async function apply(ctx: Context) {
    ctx.on('handler/after/DomainUser#get', async (that) => {
        const rudocs = that.response.body?.rudocs as Record<string, { _id: number }[]> | undefined;
        if (rudocs) filterDomainUserRudocs(rudocs);
    });

    ctx.on('handler/after/UserDetail#get', async (that) => {
        const body = that.response.body as Record<string, any> | undefined;
        if (!body?.isSelfProfile) return;
        // 只给本人看：别人的主页上没有加入分组这个入口
        const groups = await joinableGroups(that.args.domainId);
        body.joinableGroups = groups;
        // 弹层顶部按创建者筛选用的选项，去重后排序。只有一种创建者时模板不渲染它。
        // 与教师的小组管理页同一套算法（见 DtojGroupHandler），两边改动要一起看。
        body.groupCreatorOptions = [...new Set(groups.map((g) => g.creator))]
            .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        body.myGroups = await myGroupNames(that.args.domainId, that.user._id);
    });

    ctx.on('handler/after/SystemSetting#get', async (that) => {
        const settings = that.response.body?.settings as { key?: string, type?: string, range?: Record<string, string> }[] | undefined;
        if (!settings?.length) return;
        const range = await domainRoleSelectRange(that.args.domainId || 'system');
        if (!Object.keys(range).length) return;
        for (const item of settings) {
            if (item.key && DOMAIN_ROLE_SETTING_KEYS.has(item.key)) {
                item.type = 'select';
                item.range = range;
            }
        }
    });

    // 顶栏「站内消息」的未读红点（见 nav.html）读的是本请求的 UserContext，
    // 而 HomeMessages 在方法里才把 unreadMsg 清零，这里补一刀，免得停在消息页还亮着。
    ctx.on('handler/after/HomeMessages#get', (that) => {
        that.user.unreadMsg = 0;
    });

    // 通知类消息的正文要在后端出口翻好，见 inboxNotices.ts
    applyInboxNotices(ctx);

    const items = global.Hydro.ui.nodes.Nav as unknown[];
    items.splice(0, items.length);
    for (const [name, prefix, displayName] of nav) {
        if (name === 'record_main') {
            global.Hydro.ui.inject('Nav', name, {
                prefix,
                displayName,
                query: (handler: Handler) => (
                    handler.user.hasPriv(PRIV.PRIV_USER_PROFILE)
                    && !canViewAllDomainRecords(handler.user)
                        ? { uidOrName: handler.user._id }
                        : {}
                ),
            }, (handler: Handler) => (
                handler.user.hasPriv(PRIV.PRIV_USER_PROFILE)
                || canViewAllDomainRecords(handler.user)
            ));
            continue;
        }
        if (name === 'home_messages') {
            // 站内消息只给已登录用户。未读红点在 nav.html 里按 UserContext.unreadMsg 渲染。
            global.Hydro.ui.inject('Nav', name, { prefix, displayName }, PRIV.PRIV_USER_PROFILE);
            continue;
        }
        global.Hydro.ui.inject('Nav', name, { prefix, displayName });
    }
    // 课件系统入口。站点挂在 OJ 同域子路径 /ppt/（由 ppt-system 的 basePath 决定），
    // 因此在 OJ 侧不存在对应的 Hydro 路由，这里用显式 href 而不是路由名 ——
    // url() 只解析已注册的路由，找不到会退化成 '#'。
    // 登录即可见：课件对教师和学生都开放，能看哪些标签由 ppt-system 的授权决定，
    // 未登录访客不给入口（进去了也只会被弹去登录页）。
    global.Hydro.ui.inject('Nav', 'dtoj_courseware', {
        href: '/ppt/',
        displayName: '课件',
        // 排在「评测记录」之后、「站内消息」之前（作业原先待的位置），与作业对调。
        before: 'home_messages',
    }, (handler: Handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE));
    global.Hydro.ui.inject('Nav', 'dtoj_lesson_prep', {
        prefix: 'dtoj_lesson_prep', displayName: '备课', before: 'home_messages',
    }, (handler: Handler) => canManageGroups(handler.user));
    global.Hydro.ui.inject('Nav', 'domain_dashboard', { prefix: 'domain', displayName: '管理域' }, PERM.PERM_EDIT_DOMAIN);

    // 教师的「管理域」。教师没有 PERM_EDIT_DOMAIN，进不了 core 的 /domain/dashboard，
    // 所以另开一项指向插件自己的页面；顶栏的「小组」入口已经撤掉，都从这里进。
    // 与之配套的是下面两个 DomainManage 侧栏项（管理小组 / 管理用户）。
    global.Hydro.ui.inject('Nav', 'dtoj_domain', {
        href: '/group',
        // 侧栏两项的 page_name 都是 dtoj_domain_*，前缀取 dtoj_domain 就能在两者上都点亮
        prefix: 'dtoj_domain',
        displayName: '管理域',
        after: 'domain_dashboard',
    }, (handler: Handler) => !handler.user.hasPerm(PERM.PERM_EDIT_DOMAIN)
        && handler.user.hasPerm(PERM.PERM_MANAGE_GROUP, PERM.PERM_MANAGE_GROUP_ALL, PERM.PERM_MANAGE_STUDENT));

    // 域管理侧栏给教师的两项。core 的 7 个 DomainManage 项都要求 PERM_EDIT_DOMAIN
    // （见 hydrooj/src/lib/ui.ts），教师一个都看不到，这里补上教师该有的两个。
    // 侧栏文案取自 item name 的 i18n（见 domain_base.html 的 _() 调用）。
    //
    // 得排除掉有 PERM_EDIT_DOMAIN 的人：core 的 domain_group / domain_user 文案就是
    // 「管理小组」「管理用户」，不判断的话管理员侧栏会出现两遍同名项。
    const teacherOnly = (handler: Handler) => !handler.user.hasPerm(PERM.PERM_EDIT_DOMAIN);
    global.Hydro.ui.inject('DomainManage', 'dtoj_group', { family: 'Access Control', icon: 'user' },
        (handler: Handler) => teacherOnly(handler)
            && handler.user.hasPerm(PERM.PERM_MANAGE_GROUP, PERM.PERM_MANAGE_GROUP_ALL));
    global.Hydro.ui.inject('DomainManage', 'dtoj_domain_user', { family: 'Access Control', icon: 'user' },
        (handler: Handler) => teacherOnly(handler) && handler.user.hasPerm(PERM.PERM_MANAGE_STUDENT));

    // Nav 项的文字取自 item.name 的 i18n 目录（见 nav.html 的 _() 调用），
    // 不注册的话顶栏会直接显示 'dtoj_courseware' 这个名字。
    ctx.i18n.load('zh', { dtoj_courseware: '课件' });
    ctx.i18n.load('zh_TW', { dtoj_courseware: '課件' });
    ctx.i18n.load('en', { dtoj_courseware: 'Courseware' });
    ctx.i18n.load('zh', { dtoj_lesson_prep: '备课' });
    ctx.i18n.load('zh_TW', { dtoj_lesson_prep: '備課' });
    ctx.i18n.load('en', { dtoj_lesson_prep: 'Lesson prep' });
    ctx.i18n.load('zh', { dtoj_classroom_lesson: '课堂练习' });
    ctx.i18n.load('zh_TW', { dtoj_classroom_lesson: '課堂練習' });
    ctx.i18n.load('en', { dtoj_classroom_lesson: 'Classroom practice' });
    ctx.i18n.load('zh', { 'Student note': '学生备注', 'Search UID, username, or note': '搜索 UID、用户名或备注' });
    ctx.i18n.load('zh_TW', { 'Student note': '學生備註', 'Search UID, username, or note': '搜尋 UID、使用者名稱或備註' });
    ctx.i18n.load('en', { 'Student note': 'Student note', 'Search UID, username, or note': 'Search UID, username, or note' });
    ctx.i18n.load('ko', { 'Student note': '학생 메모', 'Search UID, username, or note': 'UID, 사용자 이름 또는 메모 검색' });
    // 教师域管理侧栏的两项（名字与 core 侧栏保持同一套说法）
    ctx.i18n.load('zh', { dtoj_group: '管理小组' });
    ctx.i18n.load('zh_TW', { dtoj_group: '管理小組' });
    ctx.i18n.load('en', { dtoj_group: 'Groups' });
    ctx.i18n.load('zh', { dtoj_domain_user: '管理用户' });
    ctx.i18n.load('zh_TW', { dtoj_domain_user: '管理用戶' });
    ctx.i18n.load('en', { dtoj_domain_user: 'Users' });
    // 顶栏那项也走 i18n：nav.html 取的是 item.name（args 里的 displayName 模板读不到）
    ctx.i18n.load('zh', { dtoj_domain: '管理域' });
    ctx.i18n.load('zh_TW', { dtoj_domain: '管理域' });
    ctx.i18n.load('en', { dtoj_domain: 'Manage' });

    // 课件系统据此确认来访者身份，见 DtojOjSessionHandler
    ctx.Route('dtoj_oj_session', '/oj-session', DtojOjSessionHandler);

    // 顶栏未读角标切回前台时的对账接口，见 DtojUnreadHandler
    ctx.Route('dtoj_unread', '/dtoj/unread', DtojUnreadHandler, PRIV.PRIV_USER_PROFILE);

    ctx.Route('dtoj_lesson_prep', '/lesson-prep', DtojLessonPrepHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('dtoj_lesson_prep_new', '/lesson-prep/new', DtojLessonPrepNewHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('dtoj_lesson_prep_edit', '/lesson-prep/:id/edit', DtojLessonPrepEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('dtoj_lesson_prep_delete', '/lesson-prep/:id/delete', DtojLessonPrepDeleteHandler, PRIV.PRIV_USER_PROFILE);

    // 作业列表按「只看自己的作业」重写过滤条件，见 DtojHomeworkMainHandler
    ctx.Route('homework_main', '/homework', DtojHomeworkMainHandler, PERM.PERM_VIEW_HOMEWORK);
    dropEarlierRoutes(ctx, ['/homework']);
    ctx.Route('dtoj_classroom_lesson', '/homework/classroom/:id', DtojClassroomLessonHandler, PRIV.PRIV_USER_PROFILE);

    // 撤销认领。core 没有这个接口，见 DtojHomeworkUnclaimHandler
    ctx.Route('homework_unclaim', '/homework/:tid/unclaim', DtojHomeworkUnclaimHandler, PERM.PERM_ATTEND_HOMEWORK);

    // 把分给同一批人的几份作业并成一份，见 DtojHomeworkMergeHandler。
    // 路径避开 /homework/:tid，免得被作业详情那条动态路由吃掉。
    ctx.Route('dtoj_homework_merge', '/dtoj/homework-merge', DtojHomeworkMergeHandler, PRIV.PRIV_USER_PROFILE);

    // 个人主页自助加入分组，见 DtojUserGroupHandler
    ctx.Route('dtoj_user_group', '/user/:uid/group', DtojUserGroupHandler, PRIV.PRIV_USER_PROFILE);

    // 教师的小组管理，见 DtojGroupHandler 上面那段说明。
    // 只挂登录门槛（管组权限是「或」，路由上表达不了），实际判定在方法里。
    ctx.Route('dtoj_group', '/group', DtojGroupHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('dtoj_group_create', '/group/create', DtojGroupCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('dtoj_group_members', '/group/members', DtojGroupMembersHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('dtoj_group_delete', '/group/delete', DtojGroupDeleteHandler, PRIV.PRIV_USER_PROFILE);

    // 教师的「管理用户」，见 DtojDomainUserHandler。挂 PERM_MANAGE_STUDENT：
    // 这个权限位只够看学生、建学生、重置学生密码，拿不到改角色和域设置。
    ctx.Route('dtoj_domain_user', '/domain/student', DtojDomainUserHandler, PERM.PERM_MANAGE_STUDENT);
    // 备注写入口允许教师或域管理员；Handler 内部仍会核验目标是当前域的学生。
    ctx.Route('dtoj_student_note', '/dtoj/student-note', DtojStudentNoteHandler);

    // 题目页侧栏的「添加作业」，见 DtojProblemAddHomeworkHandler
    ctx.Route(
        'dtoj_problem_add_homework', '/p/:pid/add-homework',
        DtojProblemAddHomeworkHandler, PERM.PERM_CREATE_HOMEWORK,
    );

    // 弹层要的分组与人员清单。只给建得了作业的人算，学生看题目页时这一段直接跳过。
    ctx.on('handler/after/ProblemDetail#get', async (that) => {
        const body = that.response.body as Record<string, any> | undefined;
        if (!body?.pdoc) return;
        if (!that.user.hasPerm(PERM.PERM_CREATE_HOMEWORK)) return;
        const beginAt = new Date();
        body.hwAdd = {
            ...await homeworkAssignOptions(that.args.domainId),
            beginText: timeText(beginAt, that.user.timeZone),
            endText: timeText(addOneMonth(beginAt), that.user.timeZone),
        };
    });

    // 作业答疑与进度，见 homeworkQA。
    // 不覆盖 core 的作业详情路由，改为往它的响应里补数据，模板那边再渲染。
    ctx.on('handler/after/HomeworkDetail#get', async (that) => {
        const body = that.response.body as Record<string, any> | undefined;
        const tdoc = body?.tdoc;
        if (!tdoc || tdoc.rule !== 'homework') return;
        const canManage = canManageHomework(that, tdoc);
        const questions = await listHomeworkQuestions(tdoc.domainId, tdoc, {
            uid: that.user._id, canManage,
        });
        const uids = new Set<number>();
        for (const q of questions) {
            uids.add(q.owner);
            for (const r of q.reply || []) uids.add(r.owner);
        }
        body.hwQuestions = questions;
        body.hwQuestionUsers = await UserModel.getListForRender(
            tdoc.domainId, [...uids], that.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO),
        );
        body.hwCanManage = canManage;
        // 「作业概况」里的 已认领 / 未认领，同样按名单算，口径和列表页一致
        const stat = (await homeworkRosterStats(tdoc.domainId, [tdoc])).get(String(tdoc.docId));
        body.hwClaimed = stat?.claimed.size ?? (tdoc.attend || 0);
        body.hwUnclaimed = stat?.roster ? Math.max(0, stat.roster.size - stat.claimed.size) : null;
        // 自己的完成度：每道题都 AC 才算做完。core 的 psdict 按查看者自己算，
        // 所以老师看这页时它永远是空的，不能拿它判断学生做没做完。
        const myAc = new Set((body.tsdoc?.journal || [])
            .filter((entry: any) => entry.status === STATUS.STATUS_ACCEPTED && tdoc.pids.includes(entry.pid))
            .map((entry: any) => entry.pid));
        body.hwSelfDone = !!body.tsdoc?.attend && tdoc.pids.length > 0
            && tdoc.pids.every((pid: number) => myAc.has(pid));
        // 老师/管理员还要看得到全班每道题的通过情况，不只是自己的
        if (!canManage && !that.user.hasPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD)) return;
        const progress = await listHomeworkProgress(tdoc.domainId, tdoc, stat?.roster);
        const progressUids = progress.rows.map((row) => row.uid);
        const [udict, studentNotes] = await Promise.all([
            UserModel.getListForRender(tdoc.domainId, progressUids, false),
            canManage ? studentNotesForUsers(tdoc.domainId, progressUids) : Promise.resolve({}),
        ]);
        body.hwProgress = {
            ...progress,
            udict,
            studentNotes,
        };
    });

    // 认领后告诉老师。core 用 operation 字段派发 postAttend，钩子只报 #post，所以这里自己判
    ctx.on('handler/after/HomeworkDetail#post', async (that) => {
        if (that.request.body?.operation !== 'attend') return;
        const tdoc = that.tdoc;
        if (!tdoc || tdoc.rule !== 'homework') return;
        await notifyHomeworkAttended(
            tdoc, that.user._id,
            that.url('homework_detail', { tid: tdoc.docId }),
        );
    });

    // 交完所有题后告诉老师。提交时 contest.updateStatus 已写好 journal，这里直接数覆盖了几题
    ctx.on('handler/after/ProblemSubmit#post', async (that) => {
        const tdoc = that.tdoc;
        if (!tdoc || tdoc.rule !== 'homework') return;
        const tsdoc = await ContestModel.getStatus(tdoc.domainId, tdoc.docId, that.user._id);
        const done = new Set<number>((tsdoc?.journal || [])
            .map((entry: any) => entry.pid)
            .filter((pid: number) => tdoc.pids.includes(pid)));
        if (done.size < tdoc.pids.length) return;
        await notifyHomeworkCompleted(
            tdoc.domainId, tdoc, that.user._id,
            that.url('homework_detail', { tid: tdoc.docId }),
        );
    });

    // 老师在站内消息会话里直接回话，也写进他回的那条提问，见 bridgeInboxReply。
    // postSend 与 postDeleteMessage 都报 #post，靠参数区分：删消息那条没有 uid/content
    ctx.on('handler/after/HomeMessages#post', async (that) => {
        const args = that.args as { uid?: number, content?: string };
        if (!args.uid || !args.content) return;
        await bridgeInboxReply(
            that.user._id, +args.uid, String(args.content), that.request.ip,
        );
    });

    // 组员动态：小组里的学生交完题，给组的创建者发站内消息。
    // 频次（每位老师每天每位学生一条）与文案见 groupActivity.ts。
    ctx.on('record/judge', async (rdoc, _updated, pdoc, callback: any) => {
        await notifyGroupSubmission(rdoc.domainId, rdoc, pdoc, !!callback?.meta?.rejudge);
    });

    // 作业答疑的两条写入口，见 DtojHomeworkAskHandler / DtojHomeworkReplyHandler
    ctx.Route('homework_ask', '/homework/:tid/ask', DtojHomeworkAskHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_ask_reply', '/homework/:tid/ask/:did/reply', DtojHomeworkReplyHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_ask_delete', '/homework/:tid/ask/:did/delete', DtojHomeworkDeleteMessageHandler, PERM.PERM_VIEW_HOMEWORK);
}
