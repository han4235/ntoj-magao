import { ObjectId } from 'mongodb';
import {
    Handler, PERM, PRIV, STATUS, STATUS_CODES, STATUS_SHORT_TEXTS, STATUS_TEXTS, SettingModel,
} from 'hydrooj';
import type { ProblemDoc, RecordDoc, Udoc } from 'hydrooj/src/interface';

const LIMIT_GE = new Set([
    STATUS.STATUS_TIME_LIMIT_EXCEEDED,
    STATUS.STATUS_MEMORY_LIMIT_EXCEEDED,
    STATUS.STATUS_OUTPUT_LIMIT_EXCEEDED,
]);

export function memoryText(kb: number) {
    let s = kb * 1024;
    const unit = 1024;
    const names = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    for (const name of names) {
        if (s < unit) return `${Math.round(s * 10) / 10} ${name}`;
        s /= unit;
    }
    return `${Math.round(s * unit)} ${names[names.length - 1]}`;
}

export function recordStatusLabel(status: number) {
    const short = STATUS_SHORT_TEXTS[status as STATUS];
    if (short) return short;
    return STATUS_TEXTS[status as STATUS] || '';
}

function codeLengthText(code: string) {
    const n = code ? Buffer.byteLength(code, 'utf8') : 0;
    if (n < 1024) return `${n}B`;
    return `${(Math.round((n / 1024) * 100) / 100).toFixed(2)}KB`.replace('.00', '');
}

function caseTimeText(ms: number, status: number) {
    const ge = LIMIT_GE.has(status);
    return `${ge ? '≥' : ''}${Math.round(ms || 0)}ms`;
}

function recordPublicId(rid: ObjectId | string) {
    const hex = typeof rid === 'string' ? rid : rid.toString();
    return `R${hex.slice(-9).toUpperCase()}`;
}

function findTestdataFile(pdoc: ProblemDoc, caseId: number) {
    const data = pdoc.data || [];
    const candidates = [`${caseId}.in`, `${caseId}.inp`, `input${caseId}.txt`, `${caseId}.data`];
    for (const name of candidates) {
        const hit = data.find((f) => f.name === name);
        if (hit) return hit.name;
    }
    const prefix = `${caseId}.`;
    return data.find((f) => f.name.startsWith(prefix))?.name;
}

function findTestdataInFile(pdoc: ProblemDoc, caseId: number) {
    const data = pdoc.data || [];
    const candidates = [`${caseId}.in`, `${caseId}.inp`, `input${caseId}.txt`];
    for (const name of candidates) {
        if (data.find((f) => f.name === name)) return name;
    }
    const hit = data.find((f) => f.name === `${caseId}.data`);
    return hit?.name;
}

function findTestdataOutFile(pdoc: ProblemDoc, caseId: number) {
    const data = pdoc.data || [];
    const candidates = [`${caseId}.out`, `${caseId}.ans`, `output${caseId}.txt`, `${caseId}.output`];
    for (const name of candidates) {
        if (data.find((f) => f.name === name)) return name;
    }
    return undefined;
}

function testdataSize(pdoc: ProblemDoc, filename?: string) {
    if (!filename) return undefined;
    return (pdoc.data || []).find((f) => f.name === filename)?.size;
}

type CaseFilePair = { input?: string; output?: string; inputSize?: number; outputSize?: number };

/** 子任务模式下 tc.id 只是小组内的序号，直接拿它拼 "3.in"
 *  会串到别的小组第 3 个文件上（于是每个小组的第 1 个点都指向 1.in）。
 *  这里按「小组升序、组内按 id 升序」把测试点换算成全局序号，才对应得上
 *  1.in / 2.in 这种按数据文件顺序的命名。 */
function buildCaseIndexMap(
    testCases: { id?: number; subtaskId?: number }[],
): Map<string, number> {
    const groups = new Map<number, { id?: number; subtaskId?: number }[]>();
    for (const tc of testCases) {
        const sid = tc.subtaskId ?? 0;
        const list = groups.get(sid);
        if (list) list.push(tc);
        else groups.set(sid, [tc]);
    }
    const map = new Map<string, number>();
    let offset = 0;
    for (const sid of [...groups.keys()].sort((a, b) => a - b)) {
        const list = groups.get(sid)!.slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
        list.forEach((tc, i) => {
            map.set(`${sid}:${tc.id ?? 0}`, offset + i + 1);
        });
        offset += list.length;
    }
    return map;
}

/** 测试点卡片的编号。
 *
 *  两种数据并存：多数题的子任务号从 0 起（转换器生成的），客观题却直接拿题号当子任务号，
 *  从 1 起、组内序号固定是 0。所以先看有没有 0 号子任务：有就按 0 起、统一加 1 显示。
 *  （子任务号原样显示的只有核心的 record_detail_status.html，那边 0 起的题会显示 #0。）
 *
 *  多子任务时编号是 `子任务-组内序号`，但组里只有一个点就只写子任务号 —— 客观题每题一个
 *  子任务，否则会出现「#2-0」这种其实只有一个点的编号。只有一个子任务的普通题不显示子任务号，
 *  就是测试点本身的序号，与改动前一致。
 */
export function buildCaseLabelMap(testCases: { id?: number; subtaskId?: number }[]) {
    const groups = new Map<number, { id?: number }[]>();
    for (const tc of testCases) {
        const sid = tc.subtaskId ?? 0;
        const list = groups.get(sid);
        if (list) list.push(tc);
        else groups.set(sid, [tc]);
    }
    const multiGroup = groups.size > 1;
    const offset = groups.has(0) ? 1 : 0;
    const labels: Record<string, string> = {};
    for (const [sid, list] of groups) {
        const sorted = list.slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
        sorted.forEach((tc, i) => {
            const cid = tc.id || i + 1;
            let num = String(cid);
            if (multiGroup) num = sorted.length > 1 ? `${sid + offset}-${cid}` : String(sid + offset);
            labels[`${sid}:${tc.id ?? 0}`] = num;
        });
    }
    return labels;
}

/** 某个测试点对应的输入/输出文件名，附带文件大小。
 *  大小交给前端判断「能不能在页面内预览」，大了就直接给下载。 */
function caseFilenames(
    pdoc: ProblemDoc,
    indexMap: Map<string, number>,
    tc: { id?: number; subtaskId?: number },
): CaseFilePair {
    const caseId = indexMap.get(`${tc.subtaskId ?? 0}:${tc.id ?? 0}`) ?? tc.id ?? 0;
    const input = findTestdataInFile(pdoc, caseId);
    const output = findTestdataOutFile(pdoc, caseId);
    return {
        input,
        output,
        inputSize: testdataSize(pdoc, input),
        outputSize: testdataSize(pdoc, output),
    };
}

export function canViewProblemTestdataFiles(handler: Handler, pdoc?: ProblemDoc | null) {
    return !!pdoc && (
        pdoc.owner === handler.user._id
        || handler.user.hasPriv(PRIV.PRIV_READ_PROBLEM_DATA)
        || handler.user.hasPerm(PERM.PERM_READ_PROBLEM_DATA)
    );
}

function testdataDownloadUrl(handler: Handler, pdoc: ProblemDoc, filename: string) {
    return handler.url('problem_file_download', {
        pid: pdoc.docId,
        filename,
        query: { type: 'testdata', noDisposition: '1' },
    });
}

export type CaseFileUrls = { in?: string; out?: string; inSize?: number; outSize?: number };

export function buildCaseFileUrlMap(
    handler: Handler,
    pdoc: ProblemDoc | null | undefined,
    rdoc: RecordDoc,
): Record<string, CaseFileUrls> {
    if (!canViewProblemTestdataFiles(handler, pdoc) || !pdoc) return {};
    const map: Record<string, CaseFileUrls> = {};
    const indexMap = buildCaseIndexMap(rdoc.testCases || []);
    for (const tc of rdoc.testCases || []) {
        const key = `${tc.subtaskId ?? 0}:${tc.id ?? 0}`;
        const {
            input, output, inputSize, outputSize,
        } = caseFilenames(pdoc, indexMap, tc);
        if (!input && !output) continue;
        map[key] = {
            in: input ? testdataDownloadUrl(handler, pdoc, input) : undefined,
            out: output ? testdataDownloadUrl(handler, pdoc, output) : undefined,
            inSize: inputSize,
            outSize: outputSize,
        };
    }
    return map;
}

export function buildDtojRecordDetailView(
    handler: Handler,
    payload: {
        rdoc: RecordDoc;
        pdoc?: ProblemDoc | null;
        udoc?: Udoc | null;
    },
) {
    const { rdoc, pdoc, udoc } = payload;
    const langDisplay = SettingModel.langs[rdoc.lang]?.display || rdoc.lang || '—';
    const statusKey = recordStatusLabel(rdoc.status);
    const statusTone = STATUS_CODES[rdoc.status as STATUS] || '';
    const ge = LIMIT_GE.has(rdoc.status);
    const cases = (rdoc.testCases || [])
        .slice()
        .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
        .map((tc, i) => ({
            num: tc.id ?? i + 1,
            label: recordStatusLabel(tc.status),
            tone: STATUS_CODES[tc.status as STATUS] || 'unknown',
            meta: `${caseTimeText(tc.time, tc.status)}/${memoryText(tc.memory || 0)}`,
            message: tc.message || '',
        }));
    const canReadData = canViewProblemTestdataFiles(handler, pdoc);
    const caseFiles = buildCaseFileUrlMap(handler, pdoc, rdoc);
    // 下载列表的编号跟卡片保持一致，见 buildCaseLabelMap
    const indexMap = buildCaseIndexMap(rdoc.testCases || []);
    const caseLabels = buildCaseLabelMap(rdoc.testCases || []);
    const downloads: { num: string; url: string }[] = [];
    if (canReadData && pdoc) {
        for (const tc of rdoc.testCases || []) {
            if (tc.status === STATUS.STATUS_ACCEPTED) continue;
            const caseNo = indexMap.get(`${tc.subtaskId ?? 0}:${tc.id ?? 0}`) ?? tc.id ?? 0;
            const filename = caseFilenames(pdoc, indexMap, tc).input || findTestdataFile(pdoc, caseNo);
            if (!filename) continue;
            downloads.push({
                num: caseLabels[`${tc.subtaskId ?? 0}:${tc.id ?? 0}`] ?? String(tc.id ?? 0),
                url: handler.url('problem_file_download', {
                    pid: pdoc.docId,
                    filename,
                    query: { type: 'testdata' },
                }),
            });
        }
    }
    const showCode = !!(rdoc.code || rdoc.files?.code);
    const codeLang = SettingModel.langs[rdoc.lang]?.highlight || 'cpp';
    return {
        recordPublicId: recordPublicId(rdoc._id),
        statusKey,
        statusTone,
        langDisplay,
        codeLength: rdoc.code ? codeLengthText(rdoc.code) : '—',
        totalTime: rdoc.time ? `${ge ? '≥' : ''}${Math.round(rdoc.time)}ms` : '—',
        totalMemory: rdoc.memory ? memoryText(rdoc.memory) : '—',
        scoreText: typeof rdoc.score === 'number' ? String(rdoc.score) : '—',
        cases,
        caseFiles,
        caseLabels,
        canViewCaseFiles: canReadData,
        downloads,
        showCode,
        codeLang,
        judging: typeof rdoc.status === 'number' && [STATUS.STATUS_JUDGING, STATUS.STATUS_COMPILING, STATUS.STATUS_FETCHED, STATUS.STATUS_WAITING].includes(rdoc.status),
        progress: typeof rdoc.progress === 'number' ? rdoc.progress : null,
        compilerText: (rdoc.compilerTexts || []).join('\n'),
        judgeText: rdoc.judgeTexts || [],
        udoc,
        pdoc,
        rdoc,
    };
}
