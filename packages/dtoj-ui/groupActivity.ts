import { ObjectId } from 'mongodb';
import {
    MessageModel, STATUS_TEXTS, UserModel, db,
} from 'hydrooj';
import { Logger } from 'hydrooj/src/logger';

/**
 * 组员动态：老师名下小组里的学生一交题，老师收到站内消息。
 *
 * 消息以学生的身份发出（不是系统账号），老师那边落成「和这位学生的会话」，
 * 与作业答疑、认领/交完那几条通知同一套写法，见 homeworkQA.ts。点开直达那一条提交记录。
 *
 * 频次按「每位老师 × 每位学生 × 每种动作 × 自然日」限一条。一个班几十号人，
 * 逐条推一天就是几百条，红点会一直亮着，反而没人看。当天第一条到了就说明这个
 * 学生已经在做题，后面的老师自己去作业页和记录页看。
 *
 * 收件人只认组的创建者（owner），不扩散到 maintainers：消息是以学生的身份发出的，
 * 和学生的会话该归谁，跟着建组的人走最不容易错。
 */

const logger = new Logger('dtoj-group-activity');

const COLL = 'dtoj_group_activity';
const ACTION_SUBMIT = 'submit';

interface GroupActivityDoc {
    _id: ObjectId;
    domainId: string;
    /** 收件的老师 */
    teacher: number;
    /** 有动作的学生 */
    uid: number;
    action: string;
    /** 北京时间的自然日，形如 2026-10-18 */
    day: string;
    at: Date;
}

declare module 'hydrooj' {
    interface Collections {
        dtoj_group_activity: GroupActivityDoc;
    }
}

/** 自然日按北京时间切。容器跑在 UTC，直接用服务器本地时间会把早上 8 点当成新的一天。 */
const DAY_OFFSET_MS = 8 * 3600 * 1000;

function dayKey(at: Date) {
    return new Date(at.getTime() + DAY_OFFSET_MS).toISOString().slice(0, 10);
}

/** 站点主域是 system，其余域要带 /d/<domainId> 前缀，否则链接落到主域上。 */
function recordUrl(domainId: string, rid: ObjectId) {
    const path = `/record/${rid.toHexString()}`;
    return domainId === 'system' ? path : `/d/${domainId}${path}`;
}

let indexEnsured = false;

/**
 * 占下「这位老师今天这个学生的这条动作」。抢到返回 true，说明该发这条消息。
 *
 * 靠唯一索引去重，不先查后写：一次判题可能并发到几条，查与写之间的窗口会让人收到两条。
 */
async function claimToday(domainId: string, teacher: number, uid: number, action: string, day: string) {
    if (!indexEnsured) {
        await db.collection(COLL).createIndex(
            { domainId: 1, teacher: 1, uid: 1, action: 1, day: 1 }, { unique: true },
        );
        indexEnsured = true;
    }
    try {
        await db.collection(COLL).insertOne({
            _id: new ObjectId(), domainId, teacher, uid, action, day, at: new Date(),
        });
        return true;
    } catch (e: any) {
        if (e?.code === 11000) return false;
        throw e;
    }
}

/** 这个学生所在小组的创建者，去掉他自己（老师在自己建的组里也待着的情况）。 */
async function groupOwnerUids(domainId: string, uid: number) {
    const gdocs = await UserModel.collGroup.find({ domainId, uids: uid }).toArray();
    const owners = new Set<number>();
    for (const gdoc of gdocs) {
        const owner = gdoc.owner;
        if (typeof owner === 'number' && owner > 0 && owner !== uid) owners.add(owner);
    }
    return owners;
}

/**
 * 一次判题完成后调用。只推真实提交：自测（pretest）、hack、批量重测都不算学生的动态。
 *
 * 自测记录挂在一个全零的伪比赛 id 下，判题主流程也是按这个前缀把它们摘出去的。
 */
export async function notifyGroupSubmission(
    domainId: string, rdoc: any, pdoc?: any, rejudge?: boolean,
) {
    if (!rdoc || rejudge) return;
    if (rdoc.type === 'pretest' || rdoc.type === 'hack') return;
    if (rdoc.contest?.toString().startsWith('0'.repeat(23))) return;
    const uid = rdoc.uid;
    if (!Number.isInteger(uid) || uid <= 0) return;

    try {
        const owners = await groupOwnerUids(domainId, uid);
        if (!owners.size) return;
        const day = dayKey(new Date());
        const notice = JSON.stringify({
            message: '提交了题目 {0}，结果：{1}。',
            params: [pdoc?.title || `#${rdoc.pid}`, STATUS_TEXTS[rdoc.status] || 'Unknown'],
            url: recordUrl(domainId, rdoc._id),
        });
        await Promise.all([...owners].map(async (teacher) => {
            if (!(await claimToday(domainId, teacher, uid, ACTION_SUBMIT, day))) return;
            await MessageModel.send(
                uid, teacher, notice,
                MessageModel.FLAG_UNREAD | MessageModel.FLAG_I18N,
            );
        }));
    } catch (e: any) {
        // 通知发不出去不能连累判题结果回写
        logger.error('group activity notify failed: %s', e?.stack || e);
    }
}
