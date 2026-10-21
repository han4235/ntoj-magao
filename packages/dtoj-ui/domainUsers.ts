import {
    DomainModel, ForbiddenError, PERM, PRIV, SystemModel, Types, UserModel, ValidationError,
} from 'hydrooj';
import { HIDDEN_DOMAIN_USER_IDS } from './userGroups';

/*
 * 教师的「管理用户」用到的读写。
 *
 * 老师要的是「把新生录进来、忘密码了给重置一下」，不是「改域里的角色」。所以这里
 * 只碰学生这一种角色：列表按角色过滤、建号固定成学生、重置密码前再核一遍对方是
 * 不是本域学生。改角色、移出域、删账号都不在这里，那些仍然只归管理员（/domain/user）。
 *
 * 学生角色名不写死：user.create 建号时用的是 defaultDomainRoleForNewUser()，那个函数
 * 读的是 default.userRole 设置、兜底才是「学生」。这里跟着读同一处，免得将来配了别的
 * 角色名，新加的人在列表里反而找不到。
 */

/** 与 core 的「初始化密码」同一个值，学生在登录页看到的提示也按这个来 */
export const STUDENT_DEFAULT_PASSWORD = '123456';

export function studentRoleName() {
    const role = SystemModel.get('default.userRole');
    return typeof role === 'string' && role.trim() ? role.trim() : '学生';
}

export interface StudentRow {
    uid: number;
    uname: string;
    name: string;
    note: string;
    studentId?: string;
}

/** 本域的学生账号，按显示名排；q 可匹配姓名、账号、UID 或备注。 */
export async function listStudents(domainId: string, q = '') {
    const dudocs = await DomainModel.getMultiUserInDomain(domainId, {
        join: true,
        role: studentRoleName(),
    }).toArray();
    const uids = dudocs.map((dudoc) => dudoc.uid);
    const notes = new Map(dudocs.map((dudoc) => [dudoc.uid, String(dudoc.studentNote || '')]));
    const udict = await UserModel.getList(domainId, uids);
    const needle = q.trim().toLowerCase();
    return uids
        .map((uid) => udict[uid])
        .filter((udoc) => udoc.hasPriv(PRIV.PRIV_USER_PROFILE))
        .filter((udoc) => !HIDDEN_DOMAIN_USER_IDS.has(udoc._id))
        .map((udoc) => ({
            uid: udoc._id,
            uname: udoc.uname,
            name: udoc.displayName || udoc.uname,
            note: notes.get(udoc._id) || '',
            studentId: udoc.studentId,
        }))
        .filter((row) => !needle
            || row.name.toLowerCase().includes(needle)
            || row.uname.toLowerCase().includes(needle)
            || String(row.uid).includes(needle)
            || row.note.toLowerCase().includes(needle))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 当前域内学生的教师备注，供教师可见的进度/评测列表复用。 */
export async function studentNotesForUsers(domainId: string, uids: number[]): Promise<Record<number, string>> {
    const wanted = [...new Set(uids.filter((uid) => Number.isSafeInteger(uid) && uid > 0))];
    if (!wanted.length) return {};
    const dudocs = await DomainModel.getMultiUserInDomain(domainId, {
        uid: { $in: wanted },
        role: studentRoleName(),
        join: true,
    }).project({ uid: 1, studentNote: 1 }).toArray();
    const notes: Record<number, string> = {};
    for (const dudoc of dudocs) {
        const note = String(dudoc.studentNote || '').trim();
        if (note) notes[dudoc.uid] = note;
    }
    return notes;
}

/** 给本域学生保存老师备注；不修改账号全站的 displayName。 */
export async function setStudentNote(domainId: string, uid: number, rawNote: string) {
    const note = String(rawNote || '').trim();
    if (Array.from(note).length > 40) throw new ValidationError('note');
    const isStudent = await DomainModel.getMultiUserInDomain(domainId, {
        uid,
        role: studentRoleName(),
        join: true,
    }).limit(1).hasNext();
    if (!isStudent) throw new ForbiddenError();
    await DomainModel.setUserInDomain(domainId, uid, { studentNote: note });
    return note;
}

/** 邮箱按用户名派生，和 core 建号那套一致；撞了往后加序号。 */
async function mailFor(uname: string) {
    const base = uname.toLowerCase().replace(/@/g, '_at_');
    let mail = `${base}@hydro.local`;
    let suffix = 0;
    while (await UserModel.getByEmail('system', mail)) {
        suffix += 1;
        mail = `${base}.${suffix}@hydro.local`;
    }
    return mail;
}

/** 有管理权限的账号不能拿来当学生 —— 否则建号 / 加人的动作能顺手改掉别人的角色。 */
function hasManagePower(udoc: { hasPerm(...perms: bigint[]): boolean }) {
    return udoc.hasPerm(
        PERM.PERM_EDIT_DOMAIN,
        PERM.PERM_MANAGE_GROUP_ALL,
        PERM.PERM_MANAGE_GROUP,
        PERM.PERM_MANAGE_STUDENT,
    );
}

export interface CreateStudentsResult {
    created: string[];
    linked: string[];
    failed: { uname: string, reason: string }[];
}

/**
 * 批量把用户名建成学生账号。
 *
 * 用户名已经存在时不重复建：本来就在本域当学生的跳过，是别的域的用户就拉进本域
 * 并设成学生（密码不动），已经有管理权限或在本域是别的角色的一律拒绝。
 */
export async function createStudents(domainId: string, names: string[], regip: string): Promise<CreateStudentsResult> {
    const role = studentRoleName();
    const out: CreateStudentsResult = { created: [], linked: [], failed: [] };
    const seen = new Set<string>();
    for (const raw of names) {
        const uname = String(raw || '').trim();
        if (!uname || seen.has(uname)) continue;
        seen.add(uname);
        if (!Types.Username[1](uname)) {
            out.failed.push({ uname, reason: '用户名不合法（不能有空格或特殊符号）' });
            continue;
        }
        try {
            const exists = await UserModel.getByUname('system', uname);
            if (exists) {
                if (hasManagePower(exists)) {
                    out.failed.push({ uname, reason: '这个账号有管理权限，不能当学生加进来' });
                    continue;
                }
                const dudoc = await UserModel.getById(domainId, exists._id);
                if (dudoc?.role === role) continue;
                if (dudoc?.role) {
                    out.failed.push({ uname, reason: `已在本域，角色是「${dudoc.role}」` });
                    continue;
                }
                await DomainModel.setUserInDomain(domainId, exists._id, { join: true, role });
                out.linked.push(uname);
                continue;
            }
            await UserModel.create(await mailFor(uname), uname, STUDENT_DEFAULT_PASSWORD, undefined, regip);
            out.created.push(uname);
        } catch (e: any) {
            out.failed.push({ uname, reason: e?.message || String(e) });
        }
    }
    return out;
}

/**
 * 给这批 uid 重置密码。
 *
 * 传进来的 uid 逐个核过「是本域的学生」才动，不信任页面传来的值 —— 老师的这个入口
 * 不该有办法重置到教师或管理员的密码。
 */
export async function initStudentPasswords(domainId: string, uids: number[]) {
    const wanted = new Set(uids);
    const students = await listStudents(domainId);
    const targets = students.filter((s) => wanted.has(s.uid)).map((s) => s.uid);
    await Promise.all(targets.map((uid) => UserModel.setPassword(uid, STUDENT_DEFAULT_PASSWORD)));
    return targets;
}
