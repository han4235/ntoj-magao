import {
    Context, MessageModel, SystemModel,
} from 'hydrooj';

/**
 * 站内消息里「通知类」正文的显示处理。
 *
 * 学生提问、认领作业、交完作业、小组动态这些消息以当事人的身份发出，正文存成 i18n 的 JSON
 * （{ message, params, url }），本意是让前端按各自的界面语言翻出来。但 ui-default
 * 只在「发件人是系统账号」时才解析它 —— MessagePadDialogueContentContainer 的
 * renderContent 里写的是 `if (msg.from === 1)`。发件人换成学生之后，会话列表的摘要
 * 和会话正文就把这段 JSON 原样显示出来了。
 *
 * 于是这里在后端出口把正文翻成人话：渲染成当前语言的一句话，把 url 挪到消息自身
 * （前端提示气泡读的是 mdoc.url），再摘掉 FLAG_I18N，免得又被解析一次。
 *
 * 只改发给前端的副本，不动数据库里的原文。所以下列依赖原文的地方不受影响：
 *   - bridgeInboxReply 靠正文里的 did 定位老师回的是哪一条提问
 *   - 重新打开页面会再走一遍这里的翻译，文案仍跟着界面语言
 */

interface NoticeBody {
    message?: string;
    params?: (string | number)[];
    url?: string;
}

/**
 * 一条通知消息在界面上该显示成什么。就地改写，调用方交进来的是发给前端的副本。
 *
 * 不管正文解不解得开，FLAG_I18N 都要先摘掉：这个标记的含义是「正文是待翻译的
 * i18n 串」，而我们出去的是已经翻好的文本，留着它只会让前端再解析一次。
 */
function renderNotice(mdoc: any, lang?: string) {
    if (!mdoc || !(mdoc.flag & MessageModel.FLAG_I18N)) return;
    mdoc.flag &= ~MessageModel.FLAG_I18N;
    let body: NoticeBody;
    try {
        body = JSON.parse(mdoc.content);
    } catch {
        return; // 普通文本，只是碰巧带了 i18n 标记
    }
    if (typeof body?.message !== 'string') return;
    const target = lang || SystemModel.get('server.language') || 'zh';
    mdoc.content = app.i18n.translate(body.message, [target]).format(...(body.params || []));
    if (body.url) mdoc.url = body.url;
}

export function applyInboxNotices(ctx: Context) {
    // 会话列表与会话正文的数据源，按看的人的语言翻。
    ctx.on('handler/after/HomeMessages#get', (that) => {
        const dialogues = (that.response.body as any)?.messages;
        if (!dialogues) return;
        for (const target of Object.keys(dialogues)) {
            for (const mdoc of dialogues[target].messages || []) {
                renderNotice(mdoc, that.user.viewLang);
            }
        }
    });

    /*
     * 实时推送。前端收到后直接塞进会话，所以这条也得改，否则同一个人的消息
     * 「刷新出来的」和「刚推过来的」长得不一样。
     *
     * 这里必须同步改完，不能再 await 一次去取收件人的语言。抢得到是因为
     * home.ts 的监听器在读到 mdoc 之前先 await 了一次用户查询（notifyMessage 里的
     * user.getById），而 bus 是同步派发的：排在后面的这一层改完，才轮到它继续。
     *
     * 代价是只能按站点默认语言翻。看的人若不是这个语言，刷新一次会变成他的语言。
     * 收件人通常是同一批老师，这个差别不值得为它多存一份语言缓存。
     */
    ctx.on('user/message', (_uids, mdoc) => {
        renderNotice(mdoc);
    });
}
