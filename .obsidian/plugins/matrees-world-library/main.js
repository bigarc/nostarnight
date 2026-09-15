/* Matrees World Library — clean source build, no embedded credentials. */
(function(){
const __modules={"api":function(module,exports,__require,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MatreesApi = exports.ApiError = void 0;
exports.parseJson = parseJson;
exports.decodeResponse = decodeResponse;
exports.pageRows = pageRows;
const scheduler_1 = __require("scheduler");
const network_1 = __require("network");
const types_1 = __require("types");
const utils_1 = __require("utils");
/** JSON.parse rounds Matrees snowflake IDs. Quote only unsafe integer literals before parsing. */
function preserveUnsafeIntegers(source) {
    let out = '', i = 0, inString = false, escape = false;
    while (i < source.length) {
        const ch = source[i];
        if (inString) {
            out += ch;
            if (escape)
                escape = false;
            else if (ch === '\\')
                escape = true;
            else if (ch === '"')
                inString = false;
            i++;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            i++;
            continue;
        }
        if (ch === '-' || (ch >= '0' && ch <= '9')) {
            const m = source.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
            if (m) {
                const token = m[0];
                let replacement = token;
                if (/^-?\d+$/.test(token)) {
                    try {
                        const n = BigInt(token);
                        if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER))
                            replacement = JSON.stringify(token);
                    }
                    catch { }
                }
                out += replacement;
                i += token.length;
                continue;
            }
        }
        out += ch;
        i++;
    }
    return out;
}
function parseJson(s) { return JSON.parse(preserveUnsafeIntegers(s)); }
class ApiError extends Error {
    code;
    endpoint;
    diagnostic;
    constructor(code, message, endpoint, diagnostic) {
        super(`${message}（${code}，${endpoint.split('?')[0]}）`);
        this.code = code;
        this.endpoint = endpoint;
        this.diagnostic = diagnostic;
    }
}
exports.ApiError = ApiError;
async function decodeResponse(s) {
    let v = parseJson(s);
    if (v?.encrypted === true && typeof v.data === 'string') {
        const raw = Uint8Array.from(atob(v.data), c => c.charCodeAt(0));
        const keyBytes = new TextEncoder().encode('MatreesEncryptionKey2024Secure32'.padEnd(32, '\0').slice(0, 32));
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
        const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), tagLength: 128 }, key, raw.slice(12));
        v = parseJson(new TextDecoder().decode(bytes));
    }
    return (0, types_1.obj)(v);
}
function pageRows(data) {
    if (Array.isArray(data))
        return { rows: (0, types_1.arr)(data) };
    const d = (0, types_1.obj)(data), key = ['contents', 'records', 'items', 'list', 'rows', 'data'].find(k => Array.isArray(d[k]));
    if (!key)
        throw Error('列表返回结构与已核对接口不符，已停止当前列表读取。');
    const number = (...v) => { for (const x of v) {
        const n = Number(x);
        if (Number.isFinite(n) && n >= 0)
            return n;
    } return undefined; };
    return { rows: (0, types_1.arr)(d[key]), pages: number(d.pages, d.totalPages, d.pageCount), total: number(d.total, d.totalElements, d.totalCount), current: number(d.curPage, d.current, d.currentPage, d.page, d.pageNum) };
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function retryDelay(error, attempt) {
    const e = error instanceof ApiError ? error : null, http = e?.diagnostic?.httpStatus ?? 0;
    if (e?.code === 429 || http === 429) {
        const value = e?.diagnostic?.retryAfter ?? '', seconds = Number(value);
        return Number.isFinite(seconds) && seconds > 0 ? Math.min(30000, seconds * 1000) : Math.min(12000, 1200 * 2 ** attempt);
    }
    if (e?.code === 0 || http >= 500)
        return Math.min(6000, 500 * 2 ** attempt);
    return 0;
}
class MatreesApi {
    token;
    mode;
    transport;
    onToken;
    onError;
    onWarning;
    get isClosed() { return this.closed; }
    base;
    user = null;
    invalid = false;
    refreshing = null;
    lastRefreshAt = 0;
    allowed = new Set();
    closed = false;
    scheduler;
    constructor(base, token, mode, transport, onToken, options = {}) {
        this.token = token;
        this.mode = mode;
        this.transport = transport;
        this.onToken = onToken;
        this.scheduler = new scheduler_1.RequestScheduler(options.readConcurrency ?? 1, options.requestIntervalMs ?? 0);
        this.base = (0, utils_1.baseUrl)(base);
        this.token = (0, network_1.normalizeToken)(token);
        if (!this.token)
            throw Error('请先填写 Token。');
    }
    async call(path, params = {}, worldId, method = 'GET', body, contextHeaders = {}) {
        const read = method === 'GET' || method === 'HEAD';
        return this.scheduler.run(read, async () => {
            let last;
            for (let attempt = 0; attempt < 4; attempt++)
                try {
                    return await this.performCall(path, params, worldId, method, body, contextHeaders);
                }
                catch (error) {
                    last = error;
                    const delay = read ? retryDelay(error, attempt) : 0;
                    if (!delay || attempt === 3) {
                        this.onError?.(error);
                        throw error;
                    }
                    this.onWarning?.(`请求暂时失败，${Math.round(delay / 100) / 10} 秒后重试：${path}`);
                    await wait(delay);
                }
            throw last;
        });
    }
    close() { this.closed = true; this.allowed.clear(); this.scheduler.stop(Error('连接已被关闭，请重新连接。')); }
    async performCall(path, params = {}, worldId, method = 'GET', body, contextHeaders = {}, retry = 0) {
        if (this.refreshing)
            await this.refreshing;
        if (this.closed)
            throw Error('连接已被切换或关闭，请重新连接。');
        if (this.invalid)
            throw Error('登录已失效，请重新填写 Token。');
        if (!/^\/mt\/[a-zA-Z0-9_/?=&.%+-]+$/.test(path) || path.includes('..'))
            throw Error('无效 API 路径。');
        const u = new URL(path, this.base);
        for (const [k, v] of Object.entries({ ...params, ...(worldId ? { worldId } : {}) }))
            if (v != null && v !== '')
                for (const x of Array.isArray(v) ? v : [v])
                    u.searchParams.append(k, String(x));
        const sentToken = this.token;
        const headers = { Authorization: sentToken, Accept: 'application/json', 'X-Matrees-Platform': 'web', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
        for (const [k, v] of Object.entries(contextHeaders))
            if (['workId', 'novelId'].includes(k))
                headers[k] = v;
        if (worldId)
            headers.WorldId = worldId;
        let res;
        try {
            res = await this.transport(u.href, method, headers, body === undefined ? undefined : JSON.stringify(body));
        }
        catch (error) {
            const detail = (0, network_1.errorDetail)(error, [this.token, sentToken]);
            throw new ApiError(0, (0, network_1.networkHint)(detail) + ' 详情：' + detail, path, { at: new Date().toISOString(), method, origin: u.origin, endpoint: u.pathname, params: Object.fromEntries([...u.searchParams].filter(([k]) => ['worldId', 'definitionSetId', 'page', 'size'].includes(k))), httpStatus: 0, contentType: '', responseKind: 'transport-error', message: detail });
        }
        if (this.closed)
            throw Error('连接已被切换或关闭，已忽略旧响应。');
        const responseHeader = (name) => Object.entries(res.headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? '';
        const clean = (s) => (0, network_1.errorDetail)(s, [this.token, sentToken]).replace(/[\r\n\t]/g, ' ').slice(0, 240);
        const diagnostic = { at: new Date().toISOString(), method, origin: u.origin, endpoint: u.pathname, params: Object.fromEntries([...u.searchParams].filter(([k]) => ['worldId', 'definitionSetId', 'page', 'size', 'pageNum', 'pageSize', 'current', 'folderId', 'workId', 'myGuilds', 'guildId'].includes(k)).map(([k, v]) => [k, clean(v)])), httpStatus: res.status, contentType: clean(responseHeader('content-type')), responseKind: !res.text.trim() ? 'empty' : /^\s*</.test(res.text) ? 'html/xml' : 'unknown', requestId: clean(responseHeader('x-request-id') || responseHeader('x-trace-id') || responseHeader('cf-ray')), server: clean(responseHeader('server')), retryAfter: clean(responseHeader('retry-after')) };
        diagnostic.responseHint = /Invalid CORS request/i.test(res.text) ? '响应包含 Invalid CORS request（跨域请求被拒绝）' : /Too Many Requests/i.test(res.text) ? '响应包含 Too Many Requests' : /captcha|verify you are human|challenge-platform/i.test(res.text) ? '响应包含网页验证提示' : undefined;
        const denied = (message) => new ApiError(res.status, message, path, diagnostic);
        const staleRetry = async () => { if (retry || !['GET', 'HEAD'].includes(method) || !(this.refreshing || sentToken !== this.token))
            return false; if (this.refreshing)
            await this.refreshing; return sentToken !== this.token; };
        if (res.status === 401 && await staleRetry())
            return this.performCall(path, params, worldId, method, body, contextHeaders, 1);
        if (res.status === 401) {
            this.invalid = true;
            this.allowed.clear();
            throw denied('Token 已失效或未被接受，请重新填写');
        }
        let envelope;
        try {
            envelope = await decodeResponse(res.text);
            diagnostic.responseKind = 'json';
        }
        catch {
            if (res.status === 403)
                throw denied('HTTP 403：当前资料被服务端拒绝读取');
            if (res.status === 429)
                throw denied('HTTP 429：请求过于频繁' + (diagnostic.retryAfter ? '；Retry-After：' + diagnostic.retryAfter : ''));
            throw denied(res.status >= 400 ? 'HTTP ' + res.status + '：服务器返回非 JSON 错误响应' : '响应不是可识别的 Matrees JSON');
        }
        const code = Number(envelope.code ?? res.status);
        diagnostic.businessCode = code;
        diagnostic.message = clean(String(envelope.msg ?? ''));
        if (res.status === 403 || res.status === 429)
            throw denied((res.status === 403 ? 'HTTP 403：服务端拒绝访问。' : 'HTTP 429：请求过于频繁。') + diagnostic.message);
        if ([401, 402, 415, 416].includes(code) && await staleRetry())
            return this.performCall(path, params, worldId, method, body, contextHeaders, 1);
        if ([401, 402, 415, 416].includes(code)) {
            this.invalid = true;
            this.allowed.clear();
            throw new ApiError(code, 'Token 已过期或会话被撤销', path, diagnostic);
        }
        if (res.status < 200 || res.status >= 300 || ![0, 200].includes(code))
            throw new ApiError(code, diagnostic.message || '服务端拒绝请求', path, diagnostic);
        const flush = Object.entries(res.headers).find(([k]) => k.toLowerCase() === 'flush-token')?.[1];
        if (flush && sentToken === this.token && !path.includes('/token/flush'))
            await this.refreshToken(flush, sentToken);
        else if (this.refreshing)
            await this.refreshing;
        return envelope.data;
    }
    async refreshToken(flush, expected) {
        if (this.refreshing)
            return this.refreshing;
        if (expected !== this.token || Date.now() - this.lastRefreshAt < 2000)
            return;
        this.lastRefreshAt = Date.now();
        const run = (async () => { try {
            const r = await this.transport(this.base + '/mt/common/token/flush', 'POST', { Authorization: expected, 'flush-token': flush, Accept: 'application/json', 'X-Matrees-Platform': 'web' });
            const e = await decodeResponse(r.text);
            if (this.closed)
                throw Error('连接已关闭，未保存旧会话的续期结果。');
            if (r.status < 200 || r.status >= 300 || Number(e.code) !== 200)
                throw Error('服务端拒绝登录续期（HTTP ' + r.status + '）。');
            const next = (0, network_1.normalizeToken)(typeof e.data === 'string' ? e.data : e.data?.token ?? '');
            if (!next)
                throw Error('登录续期响应缺少有效 Token。');
            this.token = next;
            await this.onToken?.(next);
        }
        catch (error) {
            this.invalid = true;
            this.allowed.clear();
            throw new ApiError(0, '登录续期或新 Token 保存失败：' + (0, network_1.errorDetail)(error, [this.token, expected, flush]), '/mt/common/token/flush');
        } })();
        this.refreshing = run;
        try {
            await run;
        }
        finally {
            if (this.refreshing === run)
                this.refreshing = null;
        }
    }
    async login() { const u = (0, types_1.obj)(await this.call('/mt/user/getUserInfo')); if (!(0, types_1.id)(u.userId))
        throw Error('无法从服务端确认当前用户。'); this.user = u; return u; }
    async collectPages(path, base, worldId, dialect) {
        const result = [];
        const seen = new Set();
        let previous = '';
        for (let page = 1; page <= 10000; page++) {
            const paging = dialect === 'page' ? { page, size: 100 } : dialect === 'pageNum' ? { pageNum: page, pageSize: 100 } : { current: page, size: 100 };
            const data = await this.call(path, { ...base, ...paging }, worldId), p = pageRows(data);
            const stamp = JSON.stringify(p.rows.map(x => x.definitionId ?? x.worldId ?? x.mediaId ?? x.eventId ?? x.workId ?? x.chapterId ?? x.mapId ?? x.id ?? x));
            if (page > 1 && p.rows.length && stamp === previous)
                return { result, complete: false, reason: '接口重复返回同一页' };
            previous = stamp;
            for (const row of p.rows) {
                const key = JSON.stringify(row);
                if (!seen.has(key)) {
                    seen.add(key);
                    result.push(row);
                }
            }
            if (p.current != null && p.current !== page)
                return { result, complete: false, reason: `服务端页码未前进（返回 ${p.current}，请求 ${page}）` };
            if (p.pages != null && page >= p.pages)
                return { result, complete: p.total == null || result.length >= p.total, reason: p.total != null && result.length < p.total ? `分页数量不完整（${result.length}/${p.total}）` : undefined };
            if (!p.rows.length)
                return { result, complete: p.total == null || result.length >= p.total, reason: p.total != null && result.length < p.total ? '列表提前结束' : undefined };
            if (p.pages == null && p.total != null && result.length >= p.total)
                return { result, complete: true };
            if (p.pages == null && p.total == null && p.rows.length < 100)
                return { result, complete: true };
        }
        return { result, complete: false, reason: '分页超过安全上限' };
    }
    async all(path, params = {}, worldId) {
        let best = [], last = '';
        for (const dialect of ['page', 'pageNum', 'current']) {
            try {
                const run = await this.collectPages(path, params, worldId, dialect);
                if (run.result.length > best.length)
                    best = run.result;
                if (run.complete)
                    return run.result;
                last = run.reason ?? last;
            }
            catch (e) {
                last = (0, network_1.errorDetail)(e);
                this.onWarning?.(`${path} 使用 ${dialect} 分页失败，尝试兼容分页方式。`);
            }
        }
        if (best.length) {
            this.onWarning?.(`${path}：${last || '分页未完整'}；已保留成功取得的 ${best.length} 条，继续同步其他资料。`);
            return best;
        }
        throw Error(`${path}：${last || '列表读取失败'}。`);
    }
    async userWorlds() {
        this.allowed.clear();
        const owned = (await this.all('/mt/world/listMyWorlds')).filter(w => (0, types_1.ownerId)(w) === (0, types_1.id)(this.user.userId));
        const joined = await this.all('/mt/world/manager/list');
        const participating = new Set(joined.map(w => (0, types_1.id)(w.worldId)).filter(Boolean));
        const merged = new Map();
        const merge = (w) => { const wid = (0, types_1.id)(w.worldId); if (!wid)
            throw Error('世界列表缺少 worldId，已停止读取。'); const prev = merged.get(wid) ?? {}; merged.set(wid, { ...prev, ...w, coverUrl: (0, utils_1.coverSource)(w, this.base) || (0, utils_1.coverSource)(prev, this.base), permissions: [...new Set([...arrStrings(prev.permissions), ...arrStrings(w.permissions)])], matreesGuilds: [...(0, types_1.arr)(prev.matreesGuilds), ...(0, types_1.arr)(w.matreesGuilds)] }); };
        for (const w of [...owned, ...joined])
            merge(w);
        const guilds = await this.all('/mt/guild/list', { myGuilds: true });
        for (const guild of guilds) {
            const gid = (0, types_1.id)(guild.guildId);
            if (!gid)
                continue;
            const info = guild.myRole ? guild : (0, types_1.obj)(await this.call('/mt/guild/getInfo/' + encodeURIComponent(gid)));
            if (!['LEADER', 'VICE_LEADER', 'MEMBER'].includes(String(info.myRole ?? '')))
                continue;
            const worlds = await this.all('/mt/guild/world/list/' + encodeURIComponent(gid));
            for (const row of worlds) {
                const w = { ...(0, types_1.obj)(row.world), ...row }, membership = (0, types_1.obj)(w.guildWorld);
                if (membership.guildId && (0, types_1.id)(membership.guildId) !== gid)
                    continue;
                if (membership.status !== 'APPROVED')
                    continue;
                const wid = (0, types_1.id)(w.worldId ?? membership.worldId);
                if (!wid)
                    continue;
                participating.add(wid);
                merge({ ...w, worldId: wid, matreesGuilds: [{ guildId: gid, title: info.title ?? guild.title ?? gid, role: info.myRole }] });
            }
        }
        return { rows: [...merged.values()], participating };
    }
    async worlds(page = 1, keyword = '') {
        if (!this.user)
            await this.login();
        if (this.mode === 'user') {
            const { rows } = await this.userWorlds();
            const found = rows.filter(w => String(w.title ?? '').toLowerCase().includes(keyword.toLowerCase()));
            this.allowed = new Set(rows.map(w => (0, types_1.id)(w.worldId)));
            await this.hydrateCovers(found);
            return { rows: found, pages: 1, total: found.length };
        }
        const data = pageRows(await this.call('/mt/world/list', { page, size: 24, ...(keyword ? { title: keyword } : {}) }));
        for (const w of data.rows)
            this.allowed.add((0, types_1.id)(w.worldId));
        await this.hydrateCovers(data.rows);
        return { rows: data.rows, pages: data.pages ?? 1, total: data.total ?? data.rows.length };
    }
    coverFileId(row) { const cover = row.cover, value = row.coverFileId ?? row.coverId ?? (cover && typeof cover === 'object' ? (cover.fileId ?? cover.id ?? cover.value) : cover); const fileId = (0, types_1.id)(value); return fileId && /^[A-Za-z0-9_-]{6,}$/.test(fileId) ? fileId : ''; }
    async fileUrl(fileId) { const data = await this.call('/mt/file/get/oss/url/' + encodeURIComponent(fileId)); const source = typeof data === 'string' ? data : data?.url ?? data?.ossUrl ?? data?.fileUrl ?? data?.downloadUrl ?? data?.src ?? data?.path; const resolved = (0, utils_1.urlSafe)(source, this.base); if (!resolved)
        throw Error('文件接口未返回可用 URL。'); return resolved; }
    async resolveCover(row) { const existing = (0, utils_1.coverSource)(row, this.base); if (existing) {
        row.coverUrl = existing;
        return;
    } const fileId = this.coverFileId(row); if (!fileId)
        return; row.coverUrl = await this.fileUrl(fileId); row.matreesCoverFileId = fileId; }
    async hydrateCovers(rows) { for (const row of rows)
        try {
            if (!(0, utils_1.coverSource)(row, this.base)) {
                const detail = (0, types_1.obj)(await this.call('/mt/world/getWorldInfo', {}, (0, types_1.id)(row.worldId)));
                if ((0, types_1.id)(detail.worldId) === (0, types_1.id)(row.worldId))
                    for (const [k, v] of Object.entries(detail))
                        if (v != null)
                            row[k] = v;
            }
            await this.resolveCover(row);
        }
        catch (e) {
            row.matreesCoverWarning = '封面详情读取失败：' + (0, network_1.errorDetail)(e);
        } }
    async assertWorld(wid) {
        if (!this.user)
            await this.login();
        this.allowed.delete(wid);
        let participating = false, listed = {};
        if (this.mode === 'user') {
            const scope = await this.userWorlds();
            listed = scope.rows.find(w => (0, types_1.id)(w.worldId) === wid) ?? {};
            participating = scope.participating.has(wid);
            if (!scope.rows.some(w => (0, types_1.id)(w.worldId) === wid))
                throw Error('普通入口仅允许读取当前账号拥有或参与的世界观；该世界不在最新列表中。');
        }
        const w = (0, types_1.obj)(await this.call('/mt/world/getWorldInfo', {}, wid));
        if ((0, types_1.id)(w.worldId) !== wid)
            throw Error('世界 ID 与服务端返回不一致。');
        if (this.mode === 'user' && !participating && (0, types_1.ownerId)(w) !== (0, types_1.id)(this.user.userId))
            throw Error('世界观归属已变化，且当前账号不在参与列表中。');
        const merged = { ...listed, ...w, coverUrl: (0, utils_1.coverSource)(w, this.base) || (0, utils_1.coverSource)(listed, this.base), matreesGuilds: listed.matreesGuilds ?? [] };
        try {
            await this.resolveCover(merged);
        }
        catch (e) {
            merged.matreesCoverWarning = '封面地址解析失败：' + (0, network_1.errorDetail)(e);
        }
        this.allowed.add(wid);
        return merged;
    }
    async read(path, params, wid) { if (!this.allowed.has(wid))
        await this.assertWorld(wid); return this.call(path, params, wid); }
    async createDefinitionProposal(wid, body) { const w = await this.assertWorld(wid); if ((0, types_1.ownerId)(w) !== (0, types_1.id)(this.user.userId))
        throw Error('上传命令只允许修改当前账号自己拥有的世界观。'); if (body.operateType !== 'create' && body.operateType !== 'update')
        throw Error('仅支持创建或更新提案。'); return (0, types_1.obj)(await this.call('/mt/proposal/definition', {}, wid, 'POST', { ...body, worldId: wid })); }
}
exports.MatreesApi = MatreesApi;
function arrStrings(v) { return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }

},
"collector":function(module,exports,__require,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collect = collect;
const api_1 = __require("api");
const types_1 = __require("types");
const utils_1 = __require("utils");
const DETAIL_WRAPPERS = ['definition', 'detail', 'item', 'entity', 'data', 'result', 'info'];
const CONTENT_FIELDS = ['content', 'body', 'document', 'doc', 'editorData', 'editorContent', 'richText', 'richContent', 'contentJson', 'contentJSON', 'contentData', 'contentValue', 'detailContent', 'definitionContent', 'text'];
function candidates(raw, depth = 0, out = []) {
    const o = (0, types_1.obj)(raw);
    if (!Object.keys(o).length || depth > 3)
        return out;
    out.push(o);
    for (const key of DETAIL_WRAPPERS)
        if (o[key] && typeof o[key] === 'object' && !Array.isArray(o[key]))
            candidates(o[key], depth + 1, out);
    return out;
}
function detailCandidate(raw, expected, wid) {
    const rows = candidates(raw);
    if (!rows.length)
        return {};
    const exact = rows.find(o => (0, types_1.id)(o.definitionId) === expected && (!o.worldId || (0, types_1.id)(o.worldId) === wid));
    if (exact)
        return exact;
    const byId = rows.find(o => (0, types_1.id)(o.definitionId) === expected);
    if (byId)
        return byId;
    const likely = rows.find(o => o.definitionId || o.content != null || o.title != null);
    return likely ?? rows[0];
}
function contentOf(o) { for (const key of CONTENT_FIELDS)
    if (Object.hasOwn(o, key))
        return { found: true, value: o[key] }; return { found: false, value: undefined }; }
function normalizeDetail(raw, listed, expected, wid) {
    const selected = detailCandidate(raw, expected, wid), returnedId = (0, types_1.id)(selected.definitionId), returnedWorld = (0, types_1.id)(selected.worldId);
    if (returnedId && returnedId !== expected)
        return { row: { ...listed, definitionId: expected, worldId: wid }, issue: `设定详情返回了其他条目的 ID（请求 ${expected}，返回 ${returnedId}）` };
    if (returnedWorld && returnedWorld !== wid)
        return { row: { ...listed, definitionId: expected, worldId: wid }, issue: `设定详情返回了其他世界的数据（请求 ${wid}，返回 ${returnedWorld}）` };
    const row = { ...listed, ...selected, definitionId: expected, worldId: wid };
    let content = contentOf(selected);
    if (!content.found) {
        for (const candidate of candidates(raw)) {
            const cid = (0, types_1.id)(candidate.definitionId), cwid = (0, types_1.id)(candidate.worldId), probe = contentOf(candidate);
            if (probe.found && (!cid || cid === expected) && (!cwid || cwid === wid)) {
                content = probe;
                break;
            }
        }
    }
    if (content.found)
        row.content = content.value;
    return { row };
}
async function collect(api, wid, extras, progress, options = {}) {
    return collectWorld(api, wid, extras, progress, options);
}
async function collectWorld(api, wid, extras, progress, options) {
    const parallel = options.readConcurrency == null ? 1 : (0, utils_1.concurrency)(options.readConcurrency), warnings = [];
    function warn(message, entityId) { warnings.push(message); progress(message, { phase: '读取资料', issue: { category: '正文/资料', entityId } }); }
    api.onWarning = message => warn(message);
    async function optional(name, fn, fallback) { try {
        return await fn();
    }
    catch (e) {
        if (api.invalid || api.isClosed)
            throw e;
        warn(name + '：' + (0, utils_1.redact)(e instanceof Error ? e.message : e));
        return fallback;
    } }
    progress('验证世界观归属与公会关系…', { phase: '授权' });
    const world = await api.assertWorld(wid);
    await options.onWorld?.(world);
    const s = { unavailable: {}, world, concept: {}, definitions: [], tree: [], memberships: {}, illustrationTree: [], illustrations: [], galleries: {}, extra: {}, events: [], maps: [], works: [], chapters: [], warnings, fetchedAt: new Date().toISOString() };
    progress('读取世界概念和设定集目录…', { phase: '世界资料' });
    s.concept = (0, types_1.obj)(await optional('世界概念', () => api.read('/mt/concept/getInfo', {}, wid), {}));
    if (!Object.hasOwn(s.concept, 'content') && world.statistics?.conceptWordCount === 0 && (!s.concept.worldId || (0, types_1.id)(s.concept.worldId) === wid))
        s.concept.content = '';
    if (s.concept.worldId && (0, types_1.id)(s.concept.worldId) !== wid) {
        s.concept = {};
        s.conceptIssue = '世界概念返回了其他世界的数据，已忽略本次概念正文。';
        warn(s.conceptIssue);
    }
    if (s.concept.content == null && !s.conceptIssue) {
        s.conceptIssue = '世界概念未返回正文，保留已有页面；首次同步创建占位页。';
        warn(s.conceptIssue);
    }
    await options.onConcept?.(s.concept, s.conceptIssue);
    s.tree = (0, types_1.arr)(await optional('设定集根目录', () => api.read('/mt/definition/listRootTree', {}, wid), []));
    const found = new Map(), sets = new Set(), visited = new Set();
    function add(rows, parent, tree = false) {
        for (const d of rows) {
            const key = (0, types_1.id)(d.definitionId);
            if (!key) {
                warn('设定列表出现缺少 definitionId 的条目，已跳过。');
                continue;
            }
            if (d.worldId && (0, types_1.id)(d.worldId) !== wid) {
                warn(`设定 ${key} 返回了其他世界的数据，已跳过。`, key);
                continue;
            }
            const prev = found.get(key) ?? {};
            found.set(key, { ...prev, ...d, definitionId: key, worldId: wid, ...(tree ? { definitionSet: true, father: d.father ?? parent ?? '0' } : {}) });
            if (tree || (0, types_1.truth)(d.definitionSet))
                sets.add(key);
            if (parent)
                s.memberships[key] = [...new Set([...(s.memberships[key] ?? []), parent])];
            if ((0, types_1.arr)(d.children).length)
                add((0, types_1.arr)(d.children), key, true);
        }
    }
    add(s.tree, undefined, true);
    add(await optional('设定总列表', () => api.all('/mt/definition/listDefinitionAll', {}, wid), []));
    for (;;) {
        const pending = [...sets].filter(x => !visited.has(x));
        if (!pending.length)
            break;
        const result = await (0, utils_1.settledPool)(pending, async (setId) => { visited.add(setId); progress(`逐集读取挂载设定：${found.get(setId)?.title ?? setId}`, { phase: '设定集目录', completed: visited.size - 1, total: sets.size, entity: setId }); const rows = await api.all('/mt/definition/listDefinitionAll', { definitionSetId: setId }, wid); add(rows, setId); }, parallel);
        for (const failure of result.errors) {
            const key = String(failure.item);
            warn(`设定集 ${found.get(key)?.title ?? key} 的下挂目录读取失败：${(0, utils_1.redact)(failure.error instanceof Error ? failure.error.message : failure.error)}；继续读取其他设定集。`, key);
        }
    }
    try {
        await options.onDefinitionIndex?.([...found.values()], structuredClone(s.memberships));
    }
    catch (e) {
        warn('建立本地设定目录索引时有条目失败：' + (0, utils_1.redact)(e instanceof Error ? e.message : e) + '；继续读取正文。');
    }
    const detailed = new Set();
    for (;;) {
        const pending = [...found.keys()].filter(x => !detailed.has(x));
        if (!pending.length)
            break;
        const result = await (0, utils_1.settledPool)(pending, async (key) => {
            detailed.add(key);
            const listed = found.get(key) ?? { definitionId: key, worldId: wid };
            progress(`读取设定正文：${listed.title ?? key}`, { phase: '设定正文', completed: detailed.size - 1, total: found.size, entity: key });
            let normalized;
            try {
                const raw = await api.read('/mt/definition/getInfo/' + encodeURIComponent(key), {}, wid);
                normalized = normalizeDetail(raw, listed, key, wid);
            }
            catch (e) {
                if (api.invalid || api.isClosed)
                    throw e;
                const message = e instanceof api_1.ApiError && e.code === 404 ? '设定详情不存在或已删除（404）' : '设定详情读取失败：' + (0, utils_1.redact)(e instanceof Error ? e.message : e);
                normalized = { row: { ...listed, definitionId: key, worldId: wid }, issue: message };
            }
            const d = normalized.row;
            let issue = normalized.issue ?? '';
            if (!issue && (0, types_1.truth)(d.isHidden) && !(0, types_1.truth)(d.hideUnlocked))
                issue = '设定被隐藏且尚未授权读取正文';
            if (!issue && d.content == null) {
                const counts = [d.contentWordCount, d.wordCount, d.statistics?.wordCount];
                if (counts.some(v => (typeof v === 'number' || typeof v === 'string' && /^\d+$/.test(v)) && Number(v) === 0) && !counts.some(v => Number(v) > 0))
                    d.content = '';
                else
                    issue = '设定详情缺少正文（不能确认是空白内容）';
            }
            found.set(key, { ...listed, ...d, definitionId: key, worldId: wid });
            if ((0, types_1.truth)(d.definitionSet))
                sets.add(key);
            if (issue) {
                delete found.get(key).content;
                s.unavailable[key] = issue;
                warn(`${String(d.title ?? key)} [${key}]：${issue}；已跳过该正文并继续读取后续设定。`, key);
            }
            else
                delete s.unavailable[key];
            s.memberships[key] = [...new Set([...(s.memberships[key] ?? []), ...(0, types_1.ids)(d.belongIds ?? d.belongSets ?? d.belong)])];
            try {
                await options.onDefinition?.(found.get(key), issue || undefined, [...found.values()], structuredClone(s.memberships));
            }
            catch (e) {
                warn(`${String(d.title ?? key)} [${key}]：本地增量写入失败：${(0, utils_1.redact)(e instanceof Error ? e.message : e)}；继续读取后续设定。`, key);
            }
            progress(`设定正文已处理 ${detailed.size}/${Math.max(found.size, detailed.size)}`, { phase: '设定正文', completed: detailed.size, total: Math.max(found.size, detailed.size), entity: key });
        }, parallel);
        for (const failure of result.errors) {
            const key = String(failure.item);
            if (api.invalid || api.isClosed)
                throw failure.error;
            warn(`设定 ${found.get(key)?.title ?? key} 处理异常：${(0, utils_1.redact)(failure.error instanceof Error ? failure.error.message : failure.error)}；继续读取。`, key);
        }
        const newSets = [...sets].filter(x => !visited.has(x));
        if (newSets.length) {
            const setResult = await (0, utils_1.settledPool)(newSets, async (key) => { visited.add(key); add(await api.all('/mt/definition/listDefinitionAll', { definitionSetId: key }, wid), key); }, parallel);
            for (const failure of setResult.errors) {
                const key = String(failure.item);
                warn(`新发现设定集 ${found.get(key)?.title ?? key} 的目录读取失败：${(0, utils_1.redact)(failure.error instanceof Error ? failure.error.message : failure.error)}。`, key);
            }
            try {
                await options.onDefinitionIndex?.([...found.values()], structuredClone(s.memberships));
            }
            catch (e) {
                warn('更新本地设定目录索引失败：' + (0, utils_1.redact)(e instanceof Error ? e.message : e) + '；继续同步。');
            }
        }
    }
    s.definitions = [...found.values()];
    progress(`已处理 ${s.definitions.length} 个设定/设定集，读取插画集…`, { phase: '插画集' });
    const it = await optional('插画目录', () => api.read('/mt/illustration/tree', {}, wid), {});
    s.illustrationTree = (0, types_1.arr)((0, types_1.obj)(it).folders ?? it);
    s.illustrations = await optional('插画列表', () => api.all('/mt/illustration/list', {}, wid), []);
    const folders = new Set();
    function walkFolders(rows) { for (const f of rows) {
        if ((0, types_1.id)(f.folderId))
            folders.add((0, types_1.id)(f.folderId));
        walkFolders((0, types_1.arr)(f.children));
    } }
    walkFolders(s.illustrationTree);
    const media = new Map(s.illustrations.map(m => [(0, types_1.id)(m.mediaId), m]));
    const folderResult = await (0, utils_1.settledPool)([...folders], async (folderId) => { for (const m of await api.all('/mt/illustration/list', { folderId }, wid))
        media.set((0, types_1.id)(m.mediaId), m); }, parallel);
    for (const failure of folderResult.errors)
        warn(`插画目录 ${String(failure.item)} 读取失败：${(0, utils_1.redact)(failure.error instanceof Error ? failure.error.message : failure.error)}。`);
    s.illustrations = [...media.values()];
    const galleryResult = await (0, utils_1.settledPool)(s.definitions, async (d) => { if (Number(d.relationCount?.illustrationCount) > 0 || (0, types_1.ids)(d.galleryImageIds).length || (0, types_1.ids)(d.galleryFolderIds).length)
        s.galleries[(0, types_1.id)(d.definitionId)] = await api.read('/mt/illustration/entityRefs', { itemType: 'definition', itemId: (0, types_1.id)(d.definitionId) }, wid); }, parallel);
    for (const failure of galleryResult.errors)
        warn(`设定插画关联读取失败：${(0, utils_1.redact)(failure.error instanceof Error ? failure.error.message : failure.error)}。`, (0, types_1.id)(failure.item.definitionId));
    if (extras) {
        progress('读取事件、历法、关系、地图和作品…', { phase: '扩展资料' });
        s.extra.calendars = await optional('历法', () => api.read('/mt/calendar/list', {}, wid), null);
        s.extra.relations = await optional('关系图谱', () => api.read('/mt/relation/graph/list', {}, wid), null);
        const events = await optional('事件列表', () => api.all('/mt/event/list', {}, wid), []), eventResult = await (0, utils_1.settledPool)(events, async (e) => ({ ...e, ...(0, types_1.obj)(await api.read('/mt/event/get/' + (0, types_1.id)(e.eventId), {}, wid)) }), parallel);
        s.events = eventResult.values.filter((x) => !!x);
        for (const failure of eventResult.errors) {
            s.events.push(failure.item);
            warn('事件 ' + String(failure.item.title ?? (0, types_1.id)(failure.item.eventId)) + ' 详情读取失败，已保留列表信息。');
        }
        const visitedMaps = new Set();
        async function maps(parent = '0') { const data = await optional('地图目录 ' + parent, () => api.read('/mt/map/list/' + wid + '/' + parent, {}, wid), []), rows = (0, types_1.arr)(Array.isArray(data) ? data : (0, types_1.obj)(data).contents ?? (0, types_1.obj)(data).maps); for (const m of rows) {
            const key = (0, types_1.id)(m.mapId);
            if (!key || visitedMaps.has(key))
                continue;
            visitedMaps.add(key);
            const full = await optional('地图 ' + key, async () => ({ ...m, ...(0, types_1.obj)(await api.read('/mt/map/getInfo/' + key, {}, wid)), bindings: await api.read('/mt/map/bind/list/' + key, {}, wid) }), m);
            s.maps.push(full);
            await maps(key);
        } }
        await maps();
        s.works = await optional('世界作品', () => api.all('/mt/work/worldList', {}, wid), []);
        for (const w of s.works) {
            const workId = (0, types_1.id)(w.workId);
            if (!workId || w.type && w.type !== 'novel') {
                if (w.type && w.type !== 'novel')
                    warnings.push(`作品 ${w.title ?? workId} 为 ${w.type}，已保存基础数据；剧本分场/漫画分页未转换。`);
                continue;
            }
            const detail = await optional('作品详情 ' + workId, () => api.call('/mt/work/getWorkInfo', {}, wid, 'GET', undefined, { workId }), {});
            Object.assign(w, (0, types_1.obj)(detail));
            if (w.novelType === 'short') {
                const short = await optional('短篇正文 ' + workId, () => api.call('/mt/novel/short/content', {}, wid, 'GET', undefined, { novelId: workId }), null);
                if (short != null)
                    s.chapters.push({ ...(0, types_1.obj)(short), chapterId: workId, workId, title: w.title, content: typeof short === 'string' ? short : (0, types_1.obj)(short).content });
                continue;
            }
            const data = await optional('作品章节 ' + workId, () => api.read('/mt/novel/chapter/list', { workId }, wid), []);
            s.extra['chapters-' + workId] = data;
            const chapters = [];
            function walk(v) { if (Array.isArray(v)) {
                v.forEach(walk);
                return;
            } const o = (0, types_1.obj)(v); if (o.chapterId)
                chapters.push(o); for (const k of ['chapters', 'volumes', 'children', 'contents'])
                if (o[k])
                    walk(o[k]); }
            walk(data);
            const chapterResult = await (0, utils_1.settledPool)(chapters, async (c) => ({ ...(0, types_1.obj)(await api.read('/mt/novel/chapter/getInfo/' + (0, types_1.id)(c.chapterId), {}, wid)), ...c, workId, volumeId: c.volumeId }), parallel);
            for (const x of chapterResult.values)
                if (x)
                    s.chapters.push(x);
            for (const failure of chapterResult.errors) {
                s.chapters.push({ ...failure.item, workId });
                warn('章节 ' + String(failure.item.title ?? (0, types_1.id)(failure.item.chapterId)) + ' 详情读取失败，已保留目录信息。');
            }
        }
    }
    function keepWorld(rows, label) { return rows.filter(entity => { if (!entity.worldId || (0, types_1.id)(entity.worldId) === wid)
        return true; warn(`${label} ${(0, types_1.id)(entity)} 返回了其他世界的数据，已忽略。`, (0, types_1.id)(entity)); return false; }); }
    s.definitions = keepWorld(s.definitions, '设定');
    s.events = keepWorld(s.events, '事件');
    s.illustrations = keepWorld(s.illustrations, '插画');
    s.maps = keepWorld(s.maps, '地图');
    s.works = keepWorld(s.works, '作品');
    s.chapters = keepWorld(s.chapters, '章节');
    return s;
}

},
"content":function(module,exports,__require,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeContent = decodeContent;
exports.parseDoc = parseDoc;
exports.tiptapHtml = tiptapHtml;
exports.sanitize = sanitize;
exports.contentHtml = contentHtml;
exports.plainText = plainText;
exports.mediaReferences = mediaReferences;
exports.mediaUrls = mediaUrls;
exports.toMarkdown = toMarkdown;
exports.markdownToDoc = markdownToDoc;
exports.appendLocal = appendLocal;
const types_1 = __require("types");
const utils_1 = __require("utils");
const api_1 = __require("api");
const allowedTags = new Set('center p div span h1 h2 h3 h4 h5 h6 strong b em i u s del strike mark code pre blockquote ul ol li table thead tbody tfoot tr th td img video audio source a br hr sub sup details summary'.split(' '));
function style(a) { const out = []; a = { ...a, textAlign: a.textAlign ?? a.align }; if (['center', 'right', 'justify', 'left'].includes(a.textAlign))
    out.push('text-align:' + a.textAlign); if (a.color && /^(#[\da-f]{3,8}|rgba?\([\d., %]+\)|[a-z]+)$/i.test(a.color))
    out.push('color:' + a.color); if (a.backgroundColor && /^(#[\da-f]{3,8}|rgba?\([\d., %]+\)|[a-z]+)$/i.test(a.backgroundColor))
    out.push('background-color:' + a.backgroundColor); const indent = Number(a.indent); if (indent > 0 && indent <= 12)
    out.push('margin-left:' + indent * 2 + 'em'); return out.length ? ` style="${(0, utils_1.esc)(out.join(';'))}"` : ''; }
function textEscape(s) { return s.replace(/\\/g, '\\\\').replace(/([`*_[\]<>])/g, '\\$1'); }
/** Decode nested serialized editor payloads while preserving unsafe numeric IDs as strings. */
function decodeContent(raw) {
    let v = raw;
    for (let i = 0; i < 12; i++) {
        if (typeof v === 'string') {
            const t = v.replace(/^\uFEFF/, '').trim();
            if (!/^[\[{\"]/.test(t))
                break;
            try {
                const next = (0, api_1.parseJson)(t);
                if (next === v)
                    break;
                v = next;
                continue;
            }
            catch {
                break;
            }
        }
        const o = (0, types_1.obj)(v);
        if (o.type || Array.isArray(v))
            break;
        const keys = Object.keys(o), wrapper = ['content', 'html', 'markdown', 'document', 'doc', 'body', 'text', 'value', 'data'].find(k => o[k] != null);
        if (wrapper && keys.every(k => [wrapper, 'format', 'contentType', 'version', 'schemaVersion', 'encoding'].includes(k))) {
            v = o[wrapper];
            continue;
        }
        break;
    }
    return v;
}
function parseDoc(raw) { const v = decodeContent(raw), o = (0, types_1.obj)(v); if (o.type === 'doc')
    return o; if (Array.isArray(v) && v.length && v.every(n => typeof n?.type === 'string'))
    return { type: 'doc', content: v }; if (['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'table', 'text'].includes(o.type))
    return { type: 'doc', content: [o] }; return null; }
const fieldNames = { title: '名称', name: '名称', description: '简介', content: '正文', caption: '说明', worldId: '世界', definitionId: '设定', calendarId: '历法', graphId: '图谱', workId: '作品', chapterId: '章节', mapId: '地图', eventId: '事件', userId: '用户', ownerId: '所属用户', ownerUserId: '所属用户', createUserId: '创建者', volumeId: '分卷', mediaId: '媒体', folderId: '目录', itemId: '关联条目', fatherId: '父设定集', guildId: '公会', nickname: '昵称', createTime: '创建时间', updateTime: '更新时间', children: '下级条目', nodes: '节点', edges: '关系', relations: '关系', bindings: '关联', months: '月份', days: '日期', weeks: '星期', volumes: '分卷', chapters: '章节', contents: '条目', items: '条目', data: '资料', type: '类型', status: '状态', statistics: '统计', ownerUser: '所属作者', createUser: '创建者', permissions: '权限', tags: '标签', coverUrl: '封面地址', coverType: '封面类型' };
const referenceFields = new Set(['worldId', 'definitionId', 'definitionIds', 'calendarId', 'graphId', 'workId', 'chapterId', 'mapId', 'eventId', 'userId', 'ownerId', 'createUserId', 'mediaId', 'mediaIds', 'folderId', 'folderIds', 'itemId', 'father', 'fatherId', 'fatherSet', 'belong', 'belongIds', 'belongSets', 'guildId', 'galleryImageIds', 'galleryFolderIds']);
function referenceField(key) { return referenceFields.has(key) || /Id(?:s)?$/.test(key) || /(?:^|_)ids?$/i.test(key); }
function hrefEntityId(raw) { try {
    const u = new URL(String(raw ?? ''), 'https://www.matrees.cn');
    for (const k of ['definitionId', 'worldId', 'eventId', 'mapId', 'workId', 'chapterId', 'userId', 'guildId', 'itemId', 'mediaId', 'folderId', 'id']) {
        const v = u.searchParams.get(k);
        if (v)
            return v;
    }
    const m = u.pathname.match(/\/(?:definition|world|event|map|work|chapter|user|guild|illustration|media|folder)\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
}
catch {
    return '';
} }
function entityHtml(value, ctx, fallback) { const key = (0, types_1.id)(value); if (!key)
    return (0, utils_1.esc)(fallback ?? ''); const name = ctx.names?.[key] ?? (fallback != null && !/^\d{5,}$/.test(String(fallback)) ? String(fallback) : ''); if (!name) {
    ctx.warnings?.push('存在无法解析名称的关联 ID；数字 ID 仅保留在原始数据中。');
    return '（名称未解析）';
} const path = ctx.links?.[key]; return path ? `<a href="${(0, utils_1.esc)(ctx.base + '/__matrees/entity?id=' + encodeURIComponent(key))}" data-matrees-id="${(0, utils_1.esc)(key)}">${(0, utils_1.esc)(name)}</a>` : (0, utils_1.esc)(name); }
function simpleMarkdownHtml(markdown) {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n'), out = [];
    let inCode = false, code = [];
    const inline = (s) => (0, utils_1.esc)(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/~~([^~]+)~~/g, '<del>$1</del>').replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
    for (const line of lines) {
        if (/^```/.test(line)) {
            if (inCode) {
                out.push('<pre><code>' + (0, utils_1.esc)(code.join('\n')) + '</code></pre>');
                code = [];
            }
            inCode = !inCode;
            continue;
        }
        if (inCode) {
            code.push(line);
            continue;
        }
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
            continue;
        }
        if (/^>\s?/.test(line)) {
            out.push('<blockquote><p>' + inline(line.replace(/^>\s?/, '')) + '</p></blockquote>');
            continue;
        }
        if (/^[-*+]\s+/.test(line)) {
            out.push('<ul><li>' + inline(line.replace(/^[-*+]\s+/, '')) + '</li></ul>');
            continue;
        }
        if (/^\d+\.\s+/.test(line)) {
            out.push('<ol><li>' + inline(line.replace(/^\d+\.\s+/, '')) + '</li></ol>');
            continue;
        }
        if (line.trim())
            out.push('<p>' + inline(line) + '</p>');
    }
    if (inCode)
        out.push('<pre><code>' + (0, utils_1.esc)(code.join('\n')) + '</code></pre>');
    return out.join('\n');
}
function structuredHtml(raw, ctx, depth = 0) {
    if (depth > 32) {
        ctx.warnings?.push('结构化正文超过 32 层；完整内容保存在原始数据中。');
        return '<p>（内容层级过深，请查看原始数据）</p>';
    }
    const v = decodeContent(raw), d = parseDoc(v);
    if (d)
        return tiptapHtml(d, ctx);
    if (v == null)
        return '';
    if (typeof v === 'string') {
        const t = v.trim();
        return /<\/?[a-z][\s\S]*>/i.test(t) ? t : simpleMarkdownHtml(v);
    }
    if (typeof v === 'boolean')
        return '<p>' + (v ? '是' : '否') + '</p>';
    if (typeof v !== 'object')
        return '<p>' + (0, utils_1.esc)(v) + '</p>';
    if (Array.isArray(v))
        return v.map((x, i) => { const o = (0, types_1.obj)(x), label = o.title ?? o.name ?? o.label; return (typeof x === 'object' ? `<h${Math.min(6, depth + 3)}>${(0, utils_1.esc)(label ?? '条目 ' + (i + 1))}</h${Math.min(6, depth + 3)}>` : '') + structuredHtml(x, ctx, depth + 1); }).join('\n');
    return Object.entries((0, types_1.obj)(v)).filter(([k, x]) => x != null && !/token|authorization|password|secret|cookie/i.test(k)).map(([k, x]) => { const label = fieldNames[k] ?? k; if (referenceField(k)) {
        const values = Array.isArray(x) ? x : [x], refs = values.map(value => entityHtml(value, ctx)).filter(Boolean);
        return '<p><strong>' + (0, utils_1.esc)(label) + '：</strong>' + (refs.join('、') || '（名称未解析）') + '</p>';
    } if (typeof x !== 'object' && typeof x !== 'string')
        return '<p><strong>' + (0, utils_1.esc)(label) + '：</strong>' + (0, utils_1.esc)(typeof x === 'boolean' ? (x ? '是' : '否') : x) + '</p>'; return `<h${Math.min(6, depth + 3)}>${(0, utils_1.esc)(label)}</h${Math.min(6, depth + 3)}>` + structuredHtml(x, ctx, depth + 1); }).join('\n');
}
function tiptapHtml(n, ctx) {
    const a = (0, types_1.obj)(n.attrs), children = (0, types_1.arr)(n.content).map(x => tiptapHtml(x, ctx)).join(''), block = (tag) => `<${tag}${style(a)}>${children}</${tag}>`;
    switch (n.type) {
        case 'doc': return children;
        case 'text': {
            let t = (0, utils_1.esc)(n.text);
            for (const m of (0, types_1.arr)(n.marks)) {
                const ma = (0, types_1.obj)(m.attrs);
                switch (m.type) {
                    case 'bold':
                        t = `<strong>${t}</strong>`;
                        break;
                    case 'italic':
                        t = `<em>${t}</em>`;
                        break;
                    case 'strike':
                        t = `<del>${t}</del>`;
                        break;
                    case 'underline':
                        t = `<u>${t}</u>`;
                        break;
                    case 'code':
                        t = `<code>${t}</code>`;
                        break;
                    case 'subscript':
                        t = `<sub>${t}</sub>`;
                        break;
                    case 'superscript':
                        t = `<sup>${t}</sup>`;
                        break;
                    case 'link': {
                        const ref = hrefEntityId(ma.href);
                        if (ref && ctx.links?.[ref])
                            t = `<a href="${(0, utils_1.esc)(ctx.base + '/__matrees/entity?id=' + encodeURIComponent(ref))}" data-matrees-id="${(0, utils_1.esc)(ref)}">${t}</a>`;
                        else {
                            const u = (0, utils_1.urlSafe)(ma.href, ctx.base);
                            if (u)
                                t = `<a href="${(0, utils_1.esc)(u)}">${t}</a>`;
                        }
                        break;
                    }
                    case 'highlight':
                        t = `<mark${style({ backgroundColor: ma.color })}>${t}</mark>`;
                        break;
                    case 'textStyle':
                        t = `<span${style(ma)}>${t}</span>`;
                        break;
                }
            }
            return t;
        }
        case 'paragraph': return block('p');
        case 'heading': return block('h' + Math.min(6, Math.max(1, Number(a.level) || 1)));
        case 'hardBreak': return '<br>';
        case 'horizontalRule': return '<hr>';
        case 'blockquote': return block('blockquote');
        case 'bulletList': return block('ul');
        case 'orderedList': return `<ol start="${Number(a.start) || 1}">${children}</ol>`;
        case 'listItem': return block('li');
        case 'taskList': return `<ul data-type="taskList">${children}</ul>`;
        case 'taskItem': return `<li data-checked="${a.checked === true}">${children}</li>`;
        case 'codeBlock': return `<pre><code class="language-${(0, utils_1.esc)(a.language ?? '')}">${(0, utils_1.esc)((0, types_1.arr)(n.content).map(x => x.text ?? '').join(''))}</code></pre>`;
        case 'image':
        case 'resizableImage':
        case 'imageBlock': {
            const src = (0, utils_1.urlSafe)(a.src ?? a.url, ctx.base);
            if (!src)
                return '';
            const fileId = (0, types_1.id)(a.fileId ?? a.mediaId ?? a['data-file-id']), width = parseFloat(a.width), height = parseFloat(a.height);
            let image = `<img src="${(0, utils_1.esc)(src)}" alt="${(0, utils_1.esc)(a.alt ?? a.title ?? '')}"${fileId ? ` data-file-id="${(0, utils_1.esc)(fileId)}"` : ''}${width > 0 ? ` width="${width}"` : ''}${height > 0 ? ` height="${height}"` : ''}>`;
            if (a.caption)
                image += '<p>' + (0, utils_1.esc)(a.caption) + '</p>';
            const align = a.textAlign ?? a['data-align'];
            return ['center', 'right'].includes(align) ? `<div style="text-align:${align}">${image}</div>` : image;
        }
        case 'video':
        case 'videoBlock':
        case 'audio': {
            const u = (0, utils_1.urlSafe)(a.src ?? a.url, ctx.base), tag = n.type === 'audio' ? 'audio' : 'video', fileId = (0, types_1.id)(a.fileId ?? a.mediaId ?? a['data-file-id']);
            return u ? `<${tag} src="${(0, utils_1.esc)(u)}"${fileId ? ` data-file-id="${(0, utils_1.esc)(fileId)}"` : ''} controls></${tag}>` : '';
        }
        case 'table': return block('table');
        case 'tableRow': return block('tr');
        case 'tableHeader':
        case 'tableCell': {
            const tag = n.type === 'tableHeader' ? 'th' : 'td';
            return `<${tag} colspan="${Number(a.colspan) || 1}" rowspan="${Number(a.rowspan) || 1}"${style(a)}>${children}</${tag}>`;
        }
        case 'mathematics':
        case 'inlineMath':
        case 'mathInline': return `<span data-math="inline">${(0, utils_1.esc)(a.latex ?? a.formula ?? n.text ?? '')}</span>`;
        case 'blockMath':
        case 'mathBlock': return `<div data-math="block">${(0, utils_1.esc)(a.latex ?? a.formula ?? n.text ?? '')}</div>`;
        case 'shareCode': {
            const code = String(a.code ?? '').replace(/^(?:mt:|\[\[)/i, '').replace(/\]\]$/, '').replace(/[-\s]/g, '').toUpperCase();
            const label = a.label ?? code;
            return /^[DEWOM][23456789ABCDEFGHJKLMNPQRSTVWXYZ]{10,}$/.test(code) ? `<a href="${(0, utils_1.esc)(ctx.base + '/e/' + code)}">${(0, utils_1.esc)(label)}</a>` : (0, utils_1.esc)(label);
        }
        case 'inlink':
        case 'mention':
        case 'definitionMention':
        case 'definitionReference': {
            const ref = (0, types_1.id)(a.itemId ?? a.definitionId ?? a.id ?? hrefEntityId(a.href)), label = ctx.names?.[ref] ?? a.label ?? a.title ?? a.name ?? '引用';
            return ref && ctx.links?.[ref] ? `<a href="${(0, utils_1.esc)(ctx.base + '/__matrees/entity?id=' + encodeURIComponent(ref))}" data-matrees-id="${(0, utils_1.esc)(ref)}">${(0, utils_1.esc)(label)}</a>` : (0, utils_1.esc)(label);
        }
        default:
            ctx.warnings?.push(`未完整识别富文本节点 ${String(n.type)}；原始节点已保存在原始数据中。`);
            return children || structuredHtml(Object.fromEntries(Object.entries(n).filter(([k]) => !['type', 'marks'].includes(k))), ctx, 1);
    }
}
function sanitize(html, base) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of Array.from(doc.body.querySelectorAll('*')).reverse()) {
        const tag = el.tagName.toLowerCase();
        if (['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'link', 'meta'].includes(tag)) {
            el.remove();
            continue;
        }
        if (!allowedTags.has(tag)) {
            el.replaceWith(...Array.from(el.childNodes));
            continue;
        }
        for (const at of Array.from(el.attributes)) {
            const k = at.name.toLowerCase();
            if (k === 'href' || k === 'src' || k === 'poster') {
                const u = (0, utils_1.urlSafe)(at.value, base);
                if (u)
                    el.setAttribute(k, u);
                else
                    el.removeAttribute(k);
            }
            else if (k === 'style') {
                const st = el.style, safe = { textAlign: st.textAlign, color: st.color, backgroundColor: st.backgroundColor }, out = style(safe).match(/style="([^"]*)"/);
                el.removeAttribute('style');
                if (out)
                    el.setAttribute('style', out[1]);
            }
            else if (!['alt', 'title', 'align', 'width', 'height', 'colspan', 'rowspan', 'start', 'class', 'controls', 'data-type', 'data-checked', 'data-math', 'data-matrees-id', 'data-item-id', 'data-item-type', 'data-file-id'].includes(k))
                el.removeAttribute(k);
            else if (k === 'align' && !['left', 'center', 'right', 'justify'].includes(at.value))
                el.removeAttribute(k);
        }
    }
    return doc.body;
}
function contentHtml(raw, ctx) { return structuredHtml(raw, ctx); }
function plainText(raw, base) { return sanitize(contentHtml(raw, { base }), base).textContent?.replace(/\s+/g, ' ').trim() ?? ''; }
function mediaReferences(raw, ctx) { const doc = sanitize(contentHtml(raw, ctx), ctx.base), refs = []; for (const e of Array.from(doc.querySelectorAll('[src],[poster]'))) {
    for (const attr of ['src', 'poster']) {
        const value = e.getAttribute(attr);
        if (value)
            refs.push({ url: value, fileId: e.getAttribute('data-file-id') || undefined });
    }
} const seen = new Set(); return refs.filter(r => { const key = r.fileId + '|' + r.url; if (seen.has(key))
    return false; seen.add(key); return true; }); }
function mediaUrls(raw, ctx) { return mediaReferences(raw, ctx).map(r => r.url); }
function markdownCell(text) { return text.replace(/\|/g, '\\|').replace(/\n+/g, '<br>').trim(); }
function renderChildren(el, ctx, depth = 0) { return Array.from(el.childNodes).map(n => nodeMarkdown(n, ctx, depth)).join(''); }
function aligned(value, align) { return `\n\n> [!matrees-${align}]\n` + value.trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n<!-- matrees-layout-break -->\n\n'; }
function nodeMarkdown(node, ctx, depth = 0) {
    if (node.nodeType === 3)
        return textEscape(node.textContent ?? '');
    if (node.nodeType !== 1)
        return '';
    const e = node, tag = e.tagName.toLowerCase(), children = renderChildren(e, ctx, depth + 1), align = e.getAttribute('align') || e.style.textAlign;
    if (['center'].includes(tag))
        return aligned(children, 'center');
    if (['p', 'div'].includes(tag)) {
        const value = children.trim();
        return align && ['center', 'right', 'justify'].includes(align) ? aligned(value, align) : value ? '\n\n' + value + '\n\n' : '';
    }
    if (/^h[1-6]$/.test(tag)) {
        const value = '#'.repeat(Number(tag[1])) + ' ' + children.trim();
        return align && ['center', 'right', 'justify'].includes(align) ? aligned(value, align) : '\n\n' + value + '\n\n';
    }
    if (tag === 'strong' || tag === 'b')
        return '**' + children + '**';
    if (tag === 'em' || tag === 'i')
        return '*' + children + '*';
    if (tag === 'del' || tag === 's' || tag === 'strike')
        return '~~' + children + '~~';
    if (tag === 'u' || tag === 'sub' || tag === 'sup')
        return `<${tag}>${children}</${tag}>`;
    if (tag === 'mark') {
        const bg = e.style.backgroundColor;
        return bg ? `<span${style({ backgroundColor: bg })}>${children}</span>` : '==' + children + '==';
    }
    if (tag === 'span') {
        const color = e.style.color, bg = e.style.backgroundColor;
        return color || bg ? `<span${style({ color, backgroundColor: bg })}>${children}</span>` : children;
    }
    if (tag === 'code' && e.parentElement?.tagName.toLowerCase() !== 'pre')
        return '`' + (e.textContent ?? '').replace(/`/g, '\\`') + '`';
    if (tag === 'pre') {
        const lang = e.querySelector('code')?.className.replace('language-', '') ?? '';
        return `\n\n\`\`\`${lang}\n${e.textContent ?? ''}\n\`\`\`\n\n`;
    }
    if (tag === 'br')
        return '\n';
    if (tag === 'hr')
        return '\n\n---\n\n';
    if (tag === 'blockquote')
        return '\n\n' + children.trim().split('\n').map(x => '> ' + x).join('\n') + '\n\n';
    if (tag === 'li') {
        const checked = e.getAttribute('data-checked');
        const prefix = checked == null ? '- ' : `- [${checked === 'true' ? 'x' : ' '}] `;
        return prefix + children.trim().replace(/\n/g, '\n  ') + '\n';
    }
    if (tag === 'ul')
        return '\n' + children + '\n';
    if (tag === 'ol') {
        let i = Number(e.getAttribute('start')) || 1;
        const rows = Array.from(e.children).map(c => `${i++}. ${renderChildren(c, ctx, depth + 1).trim().replace(/\n/g, '\n   ')}`).join('\n');
        return '\n' + rows + '\n';
    }
    if (tag === 'a') {
        const ref = e.getAttribute('data-matrees-id') ?? e.getAttribute('data-item-id') ?? hrefEntityId(e.getAttribute('href')), label = (children || ctx.names?.[ref] || '打开').replace(/[\]|]/g, ' ');
        if (ref && ctx.links?.[ref])
            return `[[${ctx.links[ref].replace(/\.md$/, '')}|${label}]]`;
        const href = (0, utils_1.urlSafe)(e.getAttribute('href'), ctx.base);
        return href ? `[${label}](${href.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')})` : label;
    }
    if (['img', 'video', 'audio'].includes(tag)) {
        const src = e.getAttribute('src') ?? e.querySelector('source')?.getAttribute('src') ?? '', local = ctx.assets?.[src], width = Number(e.getAttribute('width')), height = Number(e.getAttribute('height')), size = width > 0 ? '|' + width + (height > 0 ? 'x' + height : '') : '';
        if (local)
            return `\n\n![[${local}${size}]]\n\n`;
        if (tag === 'img')
            return `![${(e.getAttribute('alt') ?? '').replace(/[\[\]|]/g, '') + size}](${src.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
        return `\n\n<${tag} controls src="${(0, utils_1.esc)(src)}"></${tag}>\n\n`;
    }
    if (tag === 'table') {
        const rows = Array.from(e.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr')), complex = !!e.querySelector('[colspan]:not([colspan="1"]),[rowspan]:not([rowspan="1"])');
        if (complex)
            return '\n\n' + e.outerHTML + '\n\n';
        if (!rows.length)
            return '';
        const matrix = rows.map(r => Array.from(r.children).map(c => markdownCell(renderChildren(c, ctx, depth + 1))));
        const cols = Math.max(...matrix.map(r => r.length));
        const line = (r) => '| ' + Array.from({ length: cols }, (_, i) => r[i] ?? '').join(' | ') + ' |';
        const first = line(matrix[0]), sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
        return '\n\n' + [first, sep, ...matrix.slice(1).map(line)].join('\n') + '\n\n';
    }
    if (e.hasAttribute('data-math'))
        return e.dataset.math === 'block' ? `\n\n$$\n${e.textContent ?? ''}\n$$\n\n` : `$${e.textContent ?? ''}$`;
    return children;
}
function toMarkdown(raw, ctx) { const body = sanitize(contentHtml(raw, ctx), ctx.base), text = Array.from(body.childNodes).map(n => nodeMarkdown(n, ctx)).join('').replace(/<!--\s*MATREES:/g, '<!-- REMOTE-MATREES:').replace(/\n{4,}/g, '\n\n\n').trim(); return text; }
function inlineDoc(text) { const out = []; let rest = text; const re = /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\(https:\/\/[^)]+\))/; while (rest) {
    const m = rest.match(re);
    if (!m) {
        if (rest)
            out.push({ type: 'text', text: rest });
        break;
    }
    if (m.index)
        out.push({ type: 'text', text: rest.slice(0, m.index) });
    const token = m[0];
    if (token.startsWith('**'))
        out.push({ type: 'text', text: token.slice(2, -2), marks: [{ type: 'bold' }] });
    else if (token.startsWith('~~'))
        out.push({ type: 'text', text: token.slice(2, -2), marks: [{ type: 'strike' }] });
    else if (token.startsWith('*'))
        out.push({ type: 'text', text: token.slice(1, -1), marks: [{ type: 'italic' }] });
    else if (token.startsWith('`'))
        out.push({ type: 'text', text: token.slice(1, -1), marks: [{ type: 'code' }] });
    else {
        const mm = token.match(/^\[([^\]]+)\]\((https:\/\/[^)]+)\)$/);
        out.push({ type: 'text', text: mm[1], marks: [{ type: 'link', attrs: { href: mm[2] } }] });
    }
    rest = rest.slice((m.index ?? 0) + token.length);
} return out; }
function markdownToDoc(markdown) { const lines = markdown.replace(/\r\n?/g, '\n').split('\n'), content = []; let code = null, lang = ''; for (const line of lines) {
    const fence = line.match(/^```\s*(.*)$/);
    if (fence) {
        if (code) {
            content.push({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: code.join('\n') }] });
            code = null;
            lang = '';
        }
        else {
            code = [];
            lang = fence[1].trim();
        }
        continue;
    }
    if (code) {
        code.push(line);
        continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
        content.push({ type: 'heading', attrs: { level: h[1].length }, content: inlineDoc(h[2]) });
        continue;
    }
    const task = line.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
        content.push({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: task[1].toLowerCase() === 'x' }, content: [{ type: 'paragraph', content: inlineDoc(task[2]) }] }] });
        continue;
    }
    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
        content.push({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: inlineDoc(bullet[1]) }] }] });
        continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
        content.push({ type: 'blockquote', content: [{ type: 'paragraph', content: inlineDoc(quote[1]) }] });
        continue;
    }
    if (line.trim())
        content.push({ type: 'paragraph', content: inlineDoc(line) });
} if (code)
    content.push({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: code.join('\n') }] }); return { type: 'doc', content }; }
function appendLocal(original, markdown) { if (/!\[\[|!\[[^\]]*\]\((?!https:\/\/)/.test(markdown))
    throw Error('上传区域包含本地附件；请先上传附件并改成 HTTPS 地址。'); const doc = parseDoc(original); if (doc)
    return JSON.stringify({ ...doc, content: [...(0, types_1.arr)(doc.content), ...(0, types_1.arr)(markdownToDoc(markdown).content)] }); return contentHtml(original, { base: 'https://www.matrees.cn' }) + '\n' + simpleMarkdownHtml(markdown); }

},
"covers":function(module,exports,__require,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoverCache = void 0;
const scheduler_1 = __require("scheduler");
/** Shared preview cache; credentials never accompany media requests. */
class CoverCache {
    fetch;
    create;
    revoke;
    limit;
    queue = new scheduler_1.RequestScheduler(2, 100);
    pending = new Map();
    ready = new Map();
    disposed = false;
    constructor(fetch, create, revoke, limit = 20 * 1024 * 1024) {
        this.fetch = fetch;
        this.create = create;
        this.revoke = revoke;
        this.limit = limit;
    }
    peek(url) { return this.ready.get(url)?.source; }
    load(url) {
        if (this.disposed)
            return Promise.reject(Error('封面缓存已关闭。'));
        const cached = this.peek(url);
        if (cached)
            return Promise.resolve(cached);
        const current = this.pending.get(url);
        if (current)
            return current;
        const request = this.queue.run(true, async () => {
            const r = await this.fetch(url);
            if (this.disposed)
                throw Error('封面页面已关闭。');
            if (r.status === 403)
                throw Error('HTTP 403：封面媒体服务器拒绝访问。此错误不表示登录 Token 失效。');
            if (r.status < 200 || r.status >= 300)
                throw Error('封面请求失败：HTTP ' + r.status);
            const mime = r.contentType.split(';')[0].trim().toLowerCase();
            if (!/^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/(mp4|webm|quicktime))$/.test(mime))
                throw Error('封面响应不是支持的图片或视频（' + (mime || '未知类型') + '），未将错误页当作封面。');
            if (!r.bytes.byteLength || r.bytes.byteLength > this.limit)
                throw Error('封面预览为空或超过 20 MB；较大视频请同步后从本地查看。');
            while (this.ready.size && (this.ready.size >= 24 || [...this.ready.values()].reduce((n, x) => n + x.bytes, 0) + r.bytes.byteLength > 64 * 1024 * 1024)) {
                const key = this.ready.keys().next().value;
                this.revoke(this.ready.get(key).source);
                this.ready.delete(key);
            }
            const source = this.create(r.bytes, mime);
            this.ready.set(url, { source, bytes: r.bytes.byteLength });
            return source;
        });
        this.pending.set(url, request);
        void request.then(() => this.pending.delete(url), () => this.pending.delete(url));
        return request;
    }
    dispose() { this.disposed = true; this.queue.stop(Error('封面缓存已关闭。')); for (const r of this.ready.values())
        this.revoke(r.source); this.ready.clear(); }
}
exports.CoverCache = CoverCache;

},
"hierarchy":function(module,exports,__require,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.layoutDefinitions = layoutDefinitions;
const types_1 = __require("types");
const utils_1 = __require("utils");
/** Build Obsidian paths from human-readable titles only. Numeric Matrees IDs stay in metadata/raw data. */
function layoutDefinitions(root, definitions, memberships) {
    const by = new Map(definitions.map(d => [(0, types_1.id)(d.definitionId), d]));
    const sets = new Set(definitions.filter(d => (0, types_1.truth)(d.definitionSet)).map(d => (0, types_1.id)(d.definitionId)));
    const out = { paths: {}, folders: {}, parents: {}, links: [], warnings: [] };
    const visiting = new Set();
    const usedFolders = new Map(), usedFiles = new Map();
    function unique(parent, title, folder) {
        const base = (0, utils_1.safePart)(title, 48), bucket = (folder ? usedFolders : usedFiles);
        let rows = bucket.get(parent);
        if (!rows)
            bucket.set(parent, rows = new Map());
        const n = (rows.get(base) ?? 0) + 1;
        rows.set(base, n);
        return n === 1 ? base : `${base} (${n})`;
    }
    function folder(key, depth = 0) {
        if (out.folders[key])
            return out.folders[key];
        const d = by.get(key);
        let parent = (0, types_1.id)(d.fatherId ?? d.father ?? d.fatherSet);
        if (!parent || parent === '0')
            parent = (memberships[key] ?? []).find(p => p !== key && sets.has(p)) ?? '';
        if (visiting.has(key) || depth > 48) {
            out.warnings.push('设定集层级成环或过深：' + String(d.title));
            const base = root + '/设定/_层级异常';
            const result = base + '/' + unique(base, d.title, true);
            out.folders[key] = result;
            return result;
        }
        visiting.add(key);
        const prefix = parent && sets.has(parent) && parent !== key ? folder(parent, depth + 1) : root + '/设定';
        if (parent && parent !== '0' && !sets.has(parent))
            out.warnings.push('父设定集不可读取：' + String(d.title) + ' → ' + String(by.get(parent)?.title ?? '未知设定集'));
        const result = prefix + '/' + unique(prefix, d.title, true);
        out.folders[key] = result;
        out.parents[key] = parent && sets.has(parent) ? [parent] : [];
        visiting.delete(key);
        return result;
    }
    for (const key of [...sets].sort()) {
        const d = by.get(key);
        out.paths[key] = folder(key) + '/00--' + (0, utils_1.safePart)(d.title, 48) + '.md';
    }
    for (const d of definitions.filter(d => !(0, types_1.truth)(d.definitionSet))) {
        const key = (0, types_1.id)(d.definitionId);
        const parents = [...new Set([...(0, types_1.ids)(d.belongIds ?? d.belongSets ?? d.belong), ...(memberships[key] ?? [])])].filter(p => sets.has(p)).sort();
        out.parents[key] = parents;
        const primary = parents[0], dir = primary ? folder(primary) : root + '/设定/未归档', name = unique(dir, d.title, false);
        out.paths[key] = dir + '/' + name + '.md';
        for (const p of parents.slice(1)) {
            const aliasDir = folder(p), alias = unique(aliasDir, String(d.title) + '--关联', false);
            out.links.push({ from: aliasDir + '/' + alias + '.md', target: out.paths[key], title: String(d.title ?? '未命名') });
        }
    }
    return out;
}

},
"main":function(module,exports,__require,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const covers_1 = __require("covers");
const obsidian_1 = require("obsidian");
const network_1 = __require("network");
const api_1 = __require("api");
const types_1 = __require("types");
const utils_1 = __require("utils");
const collector_1 = __require("collector");
const sync_1 = __require("sync");
const regions_1 = __require("regions");
const content_1 = __require("content");
const VIEW = 'matrees-world-library', PROGRESS_VIEW = 'matrees-world-library-progress';
class MatreesPlugin extends obsidian_1.Plugin {
    settings = { ...types_1.DEFAULT_SETTINGS };
    index = { version: 1, accounts: {} };
    mode = 'user';
    api = null;
    busy = false;
    syncProgress = { status: 'idle', worldId: '', message: '尚未开始同步。', phase: '等待同步', notes: 0, conflicts: 0, warnings: 0, log: [] };
    covers;
    errors = [];
    errorsDirty = false;
    errorsRevision = 0;
    flushingErrors = null;
    recorded = new WeakSet();
    apiTransport;
    sessionVersion = 0;
    credentials = {};
    connecting = null;
    connectingApi = null;
    configUnreadable = false;
    saveChain = Promise.resolve();
    status = '请先在设置中填写 Token。';
    async onload() {
        let data;
        try {
            data = await this.loadData();
        }
        catch {
            this.configUnreadable = true;
            this.status = '配置文件无法读取；请先备份并检查插件 data.json，已禁止覆盖保存。';
        }
        this.settings = { ...types_1.DEFAULT_SETTINGS, ...data?.settings };
        this.settings.readConcurrency = (0, utils_1.concurrency)(this.settings.readConcurrency);
        this.settings.requestIntervalMs = Math.max(0, Math.min(2000, Number(this.settings.requestIntervalMs) || 0));
        this.errors = Array.isArray(data?.errors) ? data.errors.filter((e) => typeof e?.message === 'string' && typeof e?.category === 'string') : [];
        if (data?.index?.version === 1)
            this.index = data.index;
        const stored = data?.credentials?.version === 1 ? data.credentials.tokens : {};
        for (const mode of ['user', 'admin']) {
            if (Object.hasOwn(stored ?? {}, mode)) {
                try {
                    this.credentials[mode] = (0, network_1.normalizeToken)(String(stored[mode] ?? ''));
                }
                catch {
                    this.status = '本地 Token 格式无效，请重新填写。';
                }
            }
            else if (!this.configUnreadable) {
                try {
                    const legacy = await this.app.secretStorage?.getSecret(this.secretName(mode));
                    if (legacy)
                        await this.writeCredential(mode, (0, network_1.normalizeToken)(legacy));
                }
                catch {
                    this.status = '旧密钥读取或迁移失败，请重新填写并保存 Token。';
                }
            }
        }
        if (this.token(this.mode))
            this.status = '已从本地读取 Token，请连接验证。';
        this.registerMarkdownPostProcessor(el => { for (const e of el.querySelectorAll('[data-matrees-src]')) {
            const path = e.getAttribute('data-matrees-src') ?? '';
            if (path.includes('..'))
                continue;
            const f = this.app.vault.getAbstractFileByPath(path);
            if (f instanceof obsidian_1.TFile)
                e.setAttribute('src', this.app.vault.getResourcePath(f));
        } });
        this.registerView(VIEW, leaf => new WorldLibrary(leaf, this));
        this.registerView(PROGRESS_VIEW, leaf => new SyncProgressView(leaf, this));
        this.addRibbonIcon('library', 'Matrees World Library', () => void this.openLibrary());
        this.addSettingTab(new MatreesSettings(this.app, this));
        this.addCommand({ id: 'open-world-library', name: '打开世界观卡片库', callback: () => void this.openLibrary() });
        this.addCommand({ id: 'open-sync-progress', name: '查看同步进度', callback: () => void this.openProgress() });
        this.addCommand({ id: 'refresh-world-library', name: '刷新当前入口的世界观列表', callback: () => void this.openLibrary(true) });
        this.addCommand({ id: 'sync-current-world', name: '同步当前页面所属世界观', callback: () => void this.guard(async () => { const r = this.currentNote(); if (!r)
                throw Error('请先打开一个由本插件同步的页面。'); await this.syncWorld(r.wid); }) });
        this.addCommand({ id: 'upload-local-as-proposal', name: '预览本地修改区并创建追加提案', callback: () => void this.guard(() => this.previewUpload()) });
    }
    onunload() { this.resetSession(); this.covers?.dispose(); }
    enqueueSave(fn) { const run = this.saveChain.catch(() => { }).then(async () => { if (this.configUnreadable)
        throw Error('配置文件读取失败，禁止覆盖 data.json。请先备份并修复文件。'); await fn(); }); this.saveChain = run; return run; }
    state(tokens = this.credentials) { return { settings: this.settings, index: this.index, errors: this.errors, credentials: { version: 1, tokens } }; }
    async persist() { await this.enqueueSave(() => this.saveData(this.state())); }
    async writeCredential(mode, token, stillCurrent = () => true) {
        await this.enqueueSave(async () => {
            if (!stillCurrent())
                return;
            const tokens = { ...this.credentials, [mode]: token };
            try {
                await this.saveData(this.state(tokens));
                const disk = await this.loadData();
                if (disk?.credentials?.version !== 1 || disk.credentials.tokens?.[mode] !== token)
                    throw Error('readback');
            }
            catch {
                throw Error('Token 未能完成保存校验。请检查仓库写入权限、磁盘空间和 data.json；未报告保存成功。');
            }
            try {
                const secrets = this.app.secretStorage;
                if (secrets?.setSecret)
                    await secrets.setSecret(this.secretName(mode), token);
            }
            catch { }
            this.credentials = tokens;
        });
    }
    secretName(mode) { return mode === 'admin' ? this.settings.adminSecret : this.settings.userSecret; }
    token(mode) { return this.credentials[mode] ?? ''; }
    tokenStatus(mode) { return this.token(mode) ? '已保存到本地 · 重启后可读取' : '未保存 Token'; }
    resetSession() { this.sessionVersion++; this.api?.close(); this.connectingApi?.close(); this.api = null; this.connecting = null; this.connectingApi = null; }
    invalidateViews() { for (const l of this.app.workspace.getLeavesOfType(VIEW)) {
        if (l.view instanceof WorldLibrary)
            l.view.invalidate();
    } }
    async setToken(mode, token) {
        if (this.busy)
            throw Error('同步期间不能切换账号。');
        const t = (0, network_1.normalizeToken)(token);
        if (!t)
            throw Error('Token 不能为空；如需退出，请使用“清除 Token”。');
        await this.writeCredential(mode, t);
        this.resetSession();
        this.status = 'Token 已保存并回读校验成功，请连接验证。';
        this.invalidateViews();
    }
    async clearToken(mode) { if (this.busy)
        throw Error('同步期间不能清除账号。'); await this.writeCredential(mode, ''); this.resetSession(); this.status = '当前入口的本地 Token 已清除。'; this.invalidateViews(); }
    async setBase(value) { if (this.busy)
        throw Error('操作期间不能修改 API 地址。'); const base = (0, utils_1.baseUrl)(value); if (base === this.settings.baseUrl)
        return; this.settings.baseUrl = base; this.resetSession(); this.apiTransport = undefined; await this.persist(); this.status = 'API 地址已保存，请重新验证连接。'; this.invalidateViews(); }
    async setNetwork(mode) { if (this.busy)
        throw Error('操作期间不能切换请求通道。'); if (!['auto', 'native', 'direct'].includes(mode))
        throw Error('无效请求通道。'); this.settings.networkMode = mode; this.resetSession(); this.apiTransport = undefined; await this.persist(); this.invalidateViews(); }
    makeTransport() { return this.apiTransport ??= (0, network_1.selectTransport)(async (options) => { const r = await (0, obsidian_1.requestUrl)(options); return { status: r.status, text: r.text, headers: r.headers }; }, obsidian_1.Platform?.isDesktopApp ? network_1.desktopRead : undefined, this.settings.networkMode); }
    async setRootFolder(value) { if (this.busy)
        throw Error('请等待同步完成再修改目录。'); this.settings.rootFolder = (0, utils_1.safeRoot)(value); await this.persist(); new obsidian_1.Notice('保存目录已更新；已同步世界继续使用原路径。'); }
    async setReadOptions(count, interval) {
        if (this.busy)
            throw Error('请等待当前同步完成再修改读取配置。');
        if (!Number.isInteger(count) || count < 1 || count > 8 || !Number.isInteger(interval) || interval < 0 || interval > 2000)
            throw Error('并发数应为 1–8，启动间隔应为 0–2000 毫秒。');
        this.settings.readConcurrency = count;
        this.settings.requestIntervalMs = interval;
        this.resetSession();
        await this.persist();
        this.invalidateViews();
    }
    async diagnose() {
        if (this.busy)
            throw Error('请等待当前同步或上传完成后再检测连接。');
        this.busy = true;
        const el = new obsidian_1.Modal(this.app);
        el.titleEl.setText('Matrees 连接检测');
        el.contentEl.createEl('p', { text: '插件版本：' + this.manifest.version + ' · 请求通道：' + this.settings.networkMode });
        el.contentEl.createEl('p', { text: this.tokenStatus(this.mode) });
        el.open();
        try {
            const base = (0, utils_1.baseUrl)(this.settings.baseUrl);
            el.contentEl.createEl('p', { text: 'API 地址：' + base });
            if (this.token(this.mode)) {
                this.resetSession();
                const client = await this.connect();
                el.contentEl.createEl('p', { text: 'Token 登录验证成功：' + String(client.user?.nickname ?? client.user?.userId) });
                const list = await client.worlds();
                el.contentEl.createEl('p', { text: '当前入口世界列表读取成功：' + list.total + ' 个。' });
            }
            else {
                const r = await this.makeTransport()(base + '/mt/user/getUserInfo', 'GET', { Accept: 'application/json' });
                el.contentEl.createEl('p', { text: '无凭证请求：HTTP ' + r.status + '。请先填写并保存当前入口 Token。' });
            }
        }
        catch (error) {
            el.contentEl.createEl('p', { text: (0, network_1.errorDetail)(error, [this.token(this.mode)]) });
            this.reportError(error);
        }
        finally {
            this.busy = false;
        }
    }
    async connect() {
        if (this.api && !this.api.invalid && !this.api.isClosed)
            return this.api;
        if (this.connecting)
            return this.connecting;
        const mode = this.mode, epoch = this.sessionVersion, base = this.settings.baseUrl;
        let expectedToken = this.token(mode);
        const api = new api_1.MatreesApi(base, this.token(mode), mode, this.makeTransport(), async (token) => {
            if (epoch !== this.sessionVersion || base !== this.settings.baseUrl)
                return;
            await this.writeCredential(mode, (0, network_1.normalizeToken)(token), () => epoch === this.sessionVersion && base === this.settings.baseUrl && this.token(mode) === expectedToken);
            expectedToken = (0, network_1.normalizeToken)(token);
        }, { readConcurrency: this.settings.readConcurrency, requestIntervalMs: this.settings.requestIntervalMs });
        api.onError = e => this.recordException(e);
        this.connectingApi = api;
        const run = (async () => { await api.login(); if (mode !== this.mode || epoch !== this.sessionVersion || base !== this.settings.baseUrl) {
            api.close();
            throw Error('账号或连接配置已变化，请重新连接。');
        } this.api = api; this.status = '登录验证成功：' + String(api.user?.nickname ?? api.user?.username ?? '当前用户'); return api; })();
        this.connecting = run;
        try {
            return await run;
        }
        finally {
            if (this.connecting === run) {
                this.connecting = null;
                this.connectingApi = null;
            }
        }
    }
    async changeMode(mode) { if (this.busy)
        throw Error('同步期间不能切换入口。'); if (mode === this.mode)
        return; this.mode = mode; this.resetSession(); this.status = mode === 'admin' ? '管理员入口：验证账号后读取服务端允许的世界观。' : '普通入口：显示自己拥有和参与的世界观。'; this.invalidateViews(); }
    accountKey() { if (!this.api?.user)
        throw Error('尚未连接。'); return this.mode + '-' + (0, types_1.id)(this.api.user.userId); }
    refreshViews() { for (const l of this.app.workspace.getLeavesOfType(VIEW)) {
        const v = l.view;
        if (v instanceof WorldLibrary)
            v.statusEl?.setText(this.status);
    } }
    progress(s, detail) {
        this.status = (0, utils_1.redact)(s);
        if (detail?.issue)
            this.recordIssue(s, detail.issue.category, detail.issue.entityId);
        this.refreshViews();
        if (this.syncProgress.status === 'running') {
            const state = this.syncProgress;
            state.message = this.status;
            if (detail) {
                state.phase = detail.phase;
                state.completed = detail.completed;
                state.total = detail.total;
                if (detail.phase === '保存页面' && detail.completed != null)
                    state.notes = detail.completed;
            }
            state.log.push({ at: new Date().toISOString(), message: this.status });
            if (state.log.length > 200)
                state.log.shift();
            this.refreshProgress();
        }
    }
    refreshProgress() { for (const leaf of this.app.workspace.getLeavesOfType(PROGRESS_VIEW))
        if (leaf.view instanceof SyncProgressView)
            leaf.view.render(); }
    async openProgress() { let leaf = this.app.workspace.getLeavesOfType(PROGRESS_VIEW)[0]; if (!leaf) {
        leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: PROGRESS_VIEW, active: true });
    } await this.app.workspace.revealLeaf(leaf); this.refreshProgress(); }
    async openNote(path) { const f = this.app.vault.getAbstractFileByPath(path); if (f instanceof obsidian_1.TFile)
        await this.app.workspace.getLeaf('tab').openFile(f);
    else
        new obsidian_1.Notice('未找到页面：' + path); }
    recordIssue(message, category = '同步', entityId, diagnostic) {
        const clean = (0, network_1.errorDetail)(message, [this.token('user'), this.token('admin')]);
        const worldId = String(diagnostic?.params?.worldId ?? (this.busy ? this.syncProgress.worldId : '')) || undefined;
        const runId = this.busy ? this.syncProgress.startedAt : undefined;
        if (this.errors.some(e => e.message === clean && e.category === category && e.entityId === entityId && e.worldId === worldId && e.runId === runId))
            return;
        this.errors.push({ at: new Date().toISOString(), category, message: clean, entityId, worldId, runId, diagnostic });
        this.errorsDirty = true;
        this.errorsRevision++;
    }
    recordException(e) {
        if (e && typeof e === 'object') {
            if (this.recorded.has(e))
                return;
            this.recorded.add(e);
        }
        const api = e instanceof api_1.ApiError;
        this.recordIssue((0, network_1.errorDetail)(e, [this.token('user'), this.token('admin')]), api ? '接口请求' : '操作/文件', undefined, api ? e.diagnostic : undefined);
    }
    async flushErrors() {
        if (this.flushingErrors)
            return this.flushingErrors;
        const run = (async () => { while (this.errorsDirty) {
            const revision = this.errorsRevision;
            try {
                await this.persist();
                if (revision === this.errorsRevision)
                    this.errorsDirty = false;
            }
            catch {
                new obsidian_1.Notice('错误记录未能写入配置文件，请先复制错误详情。', 7000);
                break;
            }
        } })();
        this.flushingErrors = run;
        try {
            await run;
        }
        finally {
            if (this.flushingErrors === run)
                this.flushingErrors = null;
        }
    }
    reportError(e) { this.recordException(e); const m = (0, network_1.errorDetail)(e, [this.token('user'), this.token('admin')]); this.progress(m); new obsidian_1.Notice(m, 9000); this.showLastError(); void this.flushErrors(); }
    showLastError() {
        const modal = new obsidian_1.Modal(this.app);
        modal.titleEl.setText('Matrees 全部错误详情');
        const records = structuredClone(this.errors);
        modal.contentEl.createEl('p', { text: `共 ${records.length} 条记录。包含接口、正文缺失、封面下载、格式转换和文件保存问题；记录随配置保留。下方文本包含全部记录。` });
        const list = modal.contentEl.createDiv({ cls: 'matrees-error-list' });
        for (const entry of records.slice().reverse()) {
            const row = list.createDiv({ cls: 'matrees-error-row' });
            row.createEl('strong', { text: new Date(entry.at).toLocaleString() + ' · ' + entry.category });
            row.createEl('p', { text: entry.message });
            if (entry.worldId || entry.entityId)
                row.createEl('small', { text: '世界：' + (entry.worldId ?? '—') + ' · 条目：' + (entry.entityId ?? '—') });
        }
        const text = JSON.stringify({ plugin: 'Matrees World Library', version: this.manifest.version, mode: this.mode, networkMode: this.settings.networkMode, readConcurrency: this.settings.readConcurrency, requestIntervalMs: this.settings.requestIntervalMs, tokenSaved: !!this.token(this.mode), errors: records }, null, 2);
        const box = modal.contentEl.createEl('textarea', { attr: { readonly: '', rows: '12', 'aria-label': '全部错误记录' } });
        box.value = text;
        box.style.width = '100%';
        const copy = modal.contentEl.createEl('button', { text: '复制全部错误' });
        copy.onclick = () => { void (async () => { try {
            await navigator.clipboard.writeText(text);
            new obsidian_1.Notice('已复制全部错误。');
        }
        catch {
            box.focus();
            box.select();
            new obsidian_1.Notice('请复制已选中的文本。');
        } })(); };
        const clear = modal.contentEl.createEl('button', { text: '清空已查看的记录' });
        clear.onclick = () => { const viewed = new Set(records.map(e => JSON.stringify(e))); this.errors = this.errors.filter(e => !viewed.has(JSON.stringify(e))); this.errorsDirty = true; this.errorsRevision++; void this.flushErrors(); modal.close(); };
        modal.open();
    }
    async revealLocal(path) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) {
            new obsidian_1.Notice('本地路径暂不可见：' + path);
            return;
        }
        try {
            let leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
            if (!leaf) {
                leaf = this.app.workspace.getLeftLeaf(false);
                if (leaf)
                    await leaf.setViewState({ type: 'file-explorer', active: true });
            }
            if (leaf) {
                await this.app.workspace.revealLeaf(leaf);
                const explorer = leaf.view;
                if (typeof explorer.revealInFolder === 'function')
                    await explorer.revealInFolder(file);
            }
        }
        catch {
            new obsidian_1.Notice('文件已保存；请启用核心插件“文件列表”，并查找：' + path, 7000);
        }
    }
    async diagnoseWorld(wid) {
        if (this.busy)
            throw Error('请等待当前操作完成后再检测。');
        this.busy = true;
        const modal = new obsidian_1.Modal(this.app);
        modal.titleEl.setText('检测世界观读取');
        modal.contentEl.createEl('p', { text: '插件版本：' + this.manifest.version + '。检测世界详情、概念、根目录及设定列表第一页；不保存或上传正文。' });
        modal.open();
        try {
            const api = await this.connect();
            await api.assertWorld(wid);
            modal.contentEl.createEl('p', { text: '世界归属/参与关系与详情：成功' });
            for (const [label, path, params] of [['世界概念', '/mt/concept/getInfo', {}], ['设定集根目录', '/mt/definition/listRootTree', {}], ['设定列表第一页', '/mt/definition/listDefinitionAll', { page: 1, size: 100 }]]) {
                await api.read(path, params, wid);
                modal.contentEl.createEl('p', { text: label + '：成功' });
            }
            modal.contentEl.createEl('p', { text: '基础读取检测完成。子设定集的读取权限仍以实际同步结果为准。' });
        }
        catch (e) {
            modal.contentEl.createEl('p', { text: (0, utils_1.redact)(e instanceof Error ? e.message : e) });
            throw e;
        }
        finally {
            this.busy = false;
        }
    }
    async guard(fn) { try {
        await fn();
    }
    catch (e) {
        this.reportError(e);
    } }
    async openLibrary(refresh = false) { let leaf = this.app.workspace.getLeavesOfType(VIEW)[0]; if (!leaf) {
        leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: VIEW, active: true });
    } await this.app.workspace.revealLeaf(leaf); if (refresh && leaf.view instanceof WorldLibrary)
        await leaf.view.load(); }
    vaultPort() {
        const v = this.app.vault;
        const ensure = async (path) => { const parts = (0, obsidian_1.normalizePath)(path).split('/'); parts.pop(); let p = ''; for (const part of parts) {
            p = p ? p + '/' + part : part;
            const a = v.getAbstractFileByPath(p);
            if (a && !(a instanceof obsidian_1.TFolder))
                throw Error('目录位置已被文件占用：' + p);
            if (!a)
                try {
                    await v.createFolder(p);
                }
                catch (e) {
                    if (!(v.getAbstractFileByPath(p) instanceof obsidian_1.TFolder))
                        throw e;
                }
        } };
        return { exists: p => !!v.getAbstractFileByPath((0, obsidian_1.normalizePath)(p)), read: async (p) => { const f = v.getAbstractFileByPath((0, obsidian_1.normalizePath)(p)); if (!(f instanceof obsidian_1.TFile))
                throw Error('找不到文件：' + p); return v.read(f); },
            write: async (p, text) => { p = (0, obsidian_1.normalizePath)(p); await ensure(p); const f = v.getAbstractFileByPath(p); if (f instanceof obsidian_1.TFile)
                await v.process(f, () => text);
            else if (f)
                throw Error('文件位置已被目录占用：' + p);
            else
                await v.create(p, text); },
            process: async (p, fn) => { const f = v.getAbstractFileByPath((0, obsidian_1.normalizePath)(p)); if (!(f instanceof obsidian_1.TFile))
                throw Error('文件已移动：' + p); await v.process(f, fn); },
            binary: async (p, b) => { await ensure(p); if (!v.getAbstractFileByPath(p))
                await v.createBinary(p, b); },
            move: async (from, to) => { from = (0, obsidian_1.normalizePath)(from); to = (0, obsidian_1.normalizePath)(to); await ensure(to); const f = v.getAbstractFileByPath(from); if (!(f instanceof obsidian_1.TFile))
                throw Error('找不到待迁移文件：' + from); if (v.getAbstractFileByPath(to))
                throw Error('目标文件已存在：' + to); await v.rename(f, to); }
        };
    }
    async syncWorld(wid) {
        if (this.busy)
            throw Error('已有同步或上传正在进行。');
        this.busy = true;
        this.syncProgress = { status: 'running', worldId: wid, startedAt: new Date().toISOString(), message: '正在连接 Matrees…', phase: '连接', notes: 0, conflicts: 0, warnings: 0, log: [] };
        let runPath = '', root = '', incremental;
        const vault = this.vaultPort();
        try {
            await this.openProgress();
            const api = await this.connect();
            const key = this.accountKey();
            const records = this.index.accounts[key] ??= {};
            const snapshot = await (0, collector_1.collect)(api, wid, this.settings.extras, (s, d) => this.progress(s, d), { readConcurrency: this.settings.readConcurrency, onWorld: async (world) => {
                    root = records[wid]?.root ?? (0, utils_1.safeRoot)(this.settings.rootFolder) + '/' + key + '/' + (0, utils_1.safePart)(world.title, 26) + '--' + (0, utils_1.safePart)(wid, 24);
                    runPath = root + '/_同步报告/任务-' + this.syncProgress.startedAt.replace(/[:.]/g, '-') + '.md';
                    await vault.write(runPath, `# 同步任务\n\n世界：${(0, utils_1.mdText)(world.title)}\n\n保存目录：${root}\n\n状态：正在增量读取并写入本地。\n\n目录和正文会随着云端返回持续出现在左侧文件列表。\n`);
                    records[wid] ??= { root, notes: {}, assets: {} };
                    incremental = new sync_1.IncrementalWriter(world, records[wid], root, this.settings, vault, (s, d) => this.progress(s, d), async (record) => { records[wid] = record; await this.persist(); });
                    records[wid] = incremental.record;
                    await this.persist();
                    await incremental.seedWorld();
                    Object.assign(this.syncProgress, { rootPath: root, overviewPath: root + '/00--世界总览.md', reportPath: runPath });
                    this.progress('已创建同步目录并开始增量写入：' + root, { phase: '增量写入' });
                    await this.revealLocal(root + '/00--世界总览.md');
                }, onConcept: async (concept, issue) => { await incremental?.concept(concept, issue); }, onDefinitionIndex: async (definitions, memberships) => { await incremental?.seedDefinitions(definitions, memberships); }, onDefinition: async (definition, issue, definitions, memberships) => { await incremental?.definition(definition, issue, definitions, memberships); } });
            await incremental?.flush();
            const result = await (0, sync_1.saveSnapshot)(snapshot, records[wid], root, this.settings, vault, async (url, fileId) => this.fetchMedia(url, fileId), (s, d) => this.progress(s, d), async (record) => { records[wid] = record; await this.persist(); });
            records[wid] = result.record;
            for (const warning of result.warnings)
                if (!this.errors.some(e => e.runId === this.syncProgress.startedAt && e.message === (0, network_1.errorDetail)(warning)))
                    this.recordIssue(warning, '同步/格式');
            await this.persist();
            await this.flushErrors();
            const msg = `已保存 ${result.notes} 页，${result.conflicts} 个冲突，${result.warnings.length} 项待处理。`;
            this.progress(msg);
            new obsidian_1.Notice(msg, 8000);
            await vault.write(runPath, `# 同步任务\n\n状态：完成${result.warnings.length ? '（有待处理项）' : ''}\n\n${msg}\n\n${(0, utils_1.wiki)(result.reportPath, '查看本次报告')}\n\n${(0, utils_1.wiki)(root + '/00--世界总览.md', '打开世界总览')}\n`);
            Object.assign(this.syncProgress, { status: 'complete', finishedAt: new Date().toISOString(), phase: result.warnings.length ? '同步完成（有待处理项）' : '同步完成', notes: result.notes, conflicts: result.conflicts, warnings: result.warnings.length, overviewPath: root + '/00--世界总览.md', reportPath: result.reportPath, completed: undefined, total: undefined });
            this.refreshProgress();
            await this.openNote(root + '/00--世界总览.md');
            await this.revealLocal(root + '/00--世界总览.md');
        }
        catch (e) {
            this.recordException(e);
            this.progress((0, network_1.errorDetail)(e, [this.token(this.mode)]));
            this.syncProgress.status = 'error';
            this.syncProgress.finishedAt = new Date().toISOString();
            this.refreshProgress();
            if (runPath)
                try {
                    await vault.write(runPath, `# 同步任务\n\n状态：未完成\n\n${this.syncProgress.message}\n\n保存目录：${root}\n\n已保存的本地文件保持原样。请查看插件的“全部错误详情”后重新同步。\n`);
                }
                catch (writeError) {
                    this.recordException(writeError);
                }
            await this.flushErrors();
            throw e;
        }
        finally {
            this.busy = false;
        }
    }
    async fetchMedia(url, fileId, maxMB = this.settings.maxMediaMB) {
        const origin = (0, utils_1.baseUrl)(this.settings.baseUrl), headers = { Accept: 'image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8', Referer: origin + '/' };
        let resolved = url;
        const infer = () => { try {
            const name = new URL(url).pathname.split('/').pop() ?? '', stem = name.replace(/\.[^.]+$/, '');
            return /^[A-Za-z0-9_-]{12,}$/.test(stem) ? stem : '';
        }
        catch {
            return '';
        } };
        const fid = fileId || infer();
        if (fid && this.api && !this.api.isClosed)
            try {
                resolved = await this.api.fileUrl(fid);
            }
            catch { }
        let length = 0;
        try {
            const h = await (0, network_1.withTimeout)((0, obsidian_1.requestUrl)({ url: resolved, method: 'HEAD', headers, throw: false }), 10000);
            length = Number(Object.entries(h.headers).find(([k]) => k.toLowerCase() === 'content-length')?.[1] ?? 0);
        }
        catch { }
        if (length > maxMB * 1024 * 1024)
            throw Error('媒体超过单文件下载上限');
        let r = await (0, network_1.withTimeout)((0, obsidian_1.requestUrl)({ url: resolved, method: 'GET', headers, throw: false }), 45000);
        if ([401, 403].includes(r.status) && fid && this.api && !this.api.isClosed && resolved === url)
            try {
                resolved = await this.api.fileUrl(fid);
                r = await (0, network_1.withTimeout)((0, obsidian_1.requestUrl)({ url: resolved, method: 'GET', headers, throw: false }), 45000);
            }
            catch { }
        if ([401, 403].includes(r.status))
            r = await (0, network_1.withTimeout)((0, obsidian_1.requestUrl)({ url: resolved, method: 'GET', throw: false }), 45000);
        return { status: r.status, bytes: r.arrayBuffer, contentType: Object.entries(r.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '' };
    }
    localCover(wid, url) {
        if (this.api?.user) {
            const world = this.index.accounts[this.accountKey()]?.[wid], path = world?.assets[url];
            if (path) {
                const f = this.app.vault.getAbstractFileByPath(path);
                if (f instanceof obsidian_1.TFile)
                    return this.app.vault.getResourcePath(f);
            }
        }
        return this.covers?.peek(url);
    }
    async previewCover(url) { return (this.covers ??= new covers_1.CoverCache(u => this.fetchMedia(u, undefined, Math.min(20, this.settings.maxMediaMB)), (bytes, type) => URL.createObjectURL(new Blob([bytes], { type })), source => URL.revokeObjectURL(source))).load(url); }
    currentNote() { const f = this.app.workspace.getActiveFile(); if (!f)
        return null; for (const [account, worlds] of Object.entries(this.index.accounts))
        for (const [wid, w] of Object.entries(worlds))
            for (const [key, n] of Object.entries(w.notes))
                if (n.path === f.path)
                    return { file: f, account, wid, world: w, note: n, key }; return null; }
    async previewUpload() {
        const current = this.currentNote();
        if (!current || !['set', 'definition'].includes(current.note.kind))
            throw Error('请打开一个已同步的设定或设定集正文页。');
        const api = await this.connect();
        if (current.account !== this.accountKey())
            throw Error('此页面属于另一个账号或入口，请切换到对应入口。');
        const w = await api.assertWorld(current.wid);
        if ((0, types_1.ownerId)(w) !== (0, types_1.id)(api.user?.userId))
            throw Error('上传只允许用于当前账号拥有的世界观。');
        const text = await this.app.vault.read(current.file), local = (0, regions_1.localPart)(text);
        if (!local)
            throw Error('本地修改区为空。');
        const d = await api.read('/mt/definition/getInfo/' + current.note.entityId, {}, current.wid);
        if (d.hasProposal)
            throw Error('此设定已有云端提案。请先在 Matrees 处理该提案，以免覆盖正在编辑的内容。');
        if (current.note.remoteHash !== await (0, utils_1.hash)(JSON.stringify(d.content)))
            throw Error('云端正文在上次同步后已变化，请先同步并核对。');
        const payload = { worldId: current.wid, definitionId: current.note.entityId, operateType: 'update', title: d.title, alias: d.alias ?? [], description: d.description ?? '', content: (0, content_1.appendLocal)(d.content, local), definitionSet: d.definitionSet, father: d.father ?? null, belong: d.belong ?? [], showInList: d.showInList, category: d.category, cover: d.cover ?? '', coverUrl: d.coverUrl, coverType: d.coverType };
        new UploadPreview(this.app, this, local, payload, async () => {
            if (this.busy)
                throw Error('另一个操作正在进行。');
            this.busy = true;
            try {
                if (this.api !== api || this.accountKey() !== current.account)
                    throw Error('账号已切换，请重新预览。');
                if (await this.app.vault.read(current.file) !== text)
                    throw Error('本地文件已变化，请重新预览。');
                const fresh = await api.read('/mt/definition/getInfo/' + current.note.entityId, {}, current.wid);
                if (fresh.hasProposal || await (0, utils_1.hash)(JSON.stringify(fresh.content)) !== current.note.remoteHash)
                    throw Error('云端已变化或已有提案，请重新核对。');
                const result = await api.createDefinitionProposal(current.wid, payload);
                const out = await this.writeReceipt(current.world, result, payload.definitionId);
                new obsidian_1.Notice('提案请求已完成，结果已保存。请在 Matrees 提案中心查看；本地修改区保持原样。', 10000);
                this.progress('提案结果：' + out);
            }
            finally {
                this.busy = false;
            }
        }).open();
    }
    async writeReceipt(w, r, definitionId) { const path = w.root + '/_上传记录/' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; const body = { at: new Date().toISOString(), definitionId, result: r }; await this.vaultPort().write(path, JSON.stringify(body, null, 2)); return path; }
}
exports.default = MatreesPlugin;
class WorldLibrary extends obsidian_1.ItemView {
    plugin;
    statusEl = null;
    cards;
    pager;
    page = 1;
    keyword = '';
    seq = 0;
    loading = false;
    rows = [];
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
    }
    getViewType() { return VIEW; }
    getDisplayText() { return 'Matrees World Library'; }
    getIcon() { return 'library'; }
    async onOpen() { this.render(); if (this.plugin.token(this.plugin.mode))
        await this.load(); }
    invalidate() { this.seq++; this.loading = false; this.page = 1; this.keyword = ''; this.render(); }
    async onClose() { this.seq++; }
    render() {
        const el = this.contentEl;
        el.empty();
        el.addClass('matrees-library');
        const head = el.createDiv({ cls: 'matrees-header' });
        head.createDiv({ text: 'MATREES WORLD LIBRARY', cls: 'matrees-eyebrow' });
        head.createEl('h2', { text: 'Matrees World Library' });
        head.createDiv({ text: 'v' + (this.plugin.manifest?.version ?? '1.1.0') + ' · ' + this.plugin.tokenStatus(this.plugin.mode), cls: 'matrees-description' });
        head.createEl('p', { text: '浏览封面、同步设定，在自己的笔记里继续创作。', cls: 'matrees-description' });
        const tabs = head.createDiv({ cls: 'matrees-tabs' });
        for (const [m, label] of [['user', '我的与参与的世界'], ['admin', '管理员入口']]) {
            const b = tabs.createEl('button', { text: label, cls: this.plugin.mode === m ? 'is-active' : '' });
            b.onclick = () => void this.plugin.guard(async () => { await this.plugin.changeMode(m); this.page = 1; this.keyword = ''; this.render(); await this.load(); });
        }
        if (this.plugin.mode === 'user')
            head.createEl('p', { text: '包含我拥有、管理、审核、参与共创，以及已加入公会中审核通过的世界观。', cls: 'matrees-description' });
        if (this.plugin.mode === 'admin')
            head.createDiv({ text: '使用单独配置的管理员 Token。当前前端提供的是可访问世界列表；未公开内容仍由服务端决定是否开放。', cls: 'matrees-admin-note' });
        const bar = el.createDiv({ cls: 'matrees-toolbar' });
        const input = bar.createEl('input', { type: 'search', placeholder: '搜索世界观名称…' });
        input.value = this.keyword;
        input.setAttribute('aria-label', '世界观名称');
        input.onkeydown = e => { if (e.key === 'Enter') {
            this.keyword = input.value;
            this.page = 1;
            void this.load();
        } };
        const b = bar.createEl('button', { text: '搜索 / 刷新' });
        b.onclick = () => { this.keyword = input.value; this.page = 1; void this.load(); };
        const check = bar.createEl('button', { text: '检测连接' });
        check.onclick = () => void this.plugin.guard(() => this.plugin.diagnose());
        const errors = bar.createEl('button', { text: '全部错误详情' });
        errors.onclick = () => this.plugin.showLastError();
        const progress = bar.createEl('button', { text: '同步进度' });
        progress.onclick = () => void this.plugin.openProgress();
        const settings = bar.createEl('button', { text: '配置 Token' });
        settings.onclick = () => new TokenModal(this.app, this.plugin, this.plugin.mode, () => this.load()).open();
        this.statusEl = el.createDiv({ text: this.plugin.status, cls: 'matrees-status', attr: { role: 'status', 'aria-live': 'polite' } });
        this.cards = el.createDiv({ cls: 'matrees-cards' });
        this.pager = el.createDiv({ cls: 'matrees-pager' });
        if (!this.plugin.token(this.plugin.mode))
            this.cards.createDiv({ text: '填写当前入口的 Token 后，点击“搜索 / 刷新”。', cls: 'matrees-empty' });
    }
    async load() {
        if (this.loading)
            return;
        if (this.plugin.busy) {
            new obsidian_1.Notice('请等待当前同步或检测完成后再刷新列表。');
            return;
        }
        this.loading = true;
        const seq = ++this.seq;
        this.cards.empty();
        this.cards.createDiv({ text: '正在读取世界观…', cls: 'matrees-empty' });
        this.pager.empty();
        try {
            const api = await this.plugin.connect();
            const data = await api.worlds(this.page, this.keyword);
            if (seq !== this.seq || api !== this.plugin.api)
                return;
            this.rows = data.rows;
            this.cards.empty();
            this.plugin.refreshViews();
            if (!data.rows.length)
                this.cards.createDiv({ text: '当前账号没有匹配且可读取的世界观。', cls: 'matrees-empty' });
            for (const w of data.rows)
                this.card(w);
            const prev = this.pager.createEl('button', { text: '上一页' });
            prev.disabled = this.page <= 1;
            prev.onclick = () => { this.page--; void this.load(); };
            this.pager.createSpan({ text: `第 ${this.page} / ${Math.max(1, data.pages)} 页 · ${data.total} 个世界观` });
            const next = this.pager.createEl('button', { text: '下一页' });
            next.disabled = this.page >= data.pages;
            next.onclick = () => { this.page++; void this.load(); };
        }
        catch (e) {
            if (seq !== this.seq)
                return;
            this.cards.empty();
            this.cards.createDiv({ text: (0, utils_1.redact)(e instanceof Error ? e.message : e), cls: 'matrees-empty' });
            this.plugin.reportError(e);
        }
        finally {
            if (seq === this.seq)
                this.loading = false;
        }
    }
    card(w) {
        const card = this.cards.createEl('article', { cls: 'matrees-card' }), media = card.createDiv({ cls: 'matrees-cover' }), u = (0, utils_1.coverSource)(w, this.plugin.settings.baseUrl), wid = (0, types_1.id)(w.worldId), epoch = this.seq, api = this.plugin.api;
        const alive = () => epoch === this.seq && api === this.plugin.api;
        const cached = u ? this.plugin.localCover(wid, u) : undefined;
        const showFailure = (error) => {
            if (!alive())
                return;
            const placeholder = media.querySelector('.matrees-cover-placeholder');
            if (placeholder)
                placeholder.setText('封面暂不可用');
            media.querySelector('.matrees-cover-error')?.remove();
            const detail = (0, network_1.errorDetail)(error, [this.plugin.token(this.plugin.mode)]);
            const box = media.createDiv({ cls: 'matrees-cover-error' });
            box.createEl('p', { text: detail });
            const retry = box.createEl('button', { text: '重试封面' });
            retry.onclick = () => void load();
            this.plugin.recordIssue('世界 ' + String(w.title ?? wid) + ' 封面：' + detail + ' · ' + u, '封面预览', wid);
            void this.plugin.flushErrors();
        };
        const show = (source) => { if (!alive())
            return; media.empty(); if ((0, utils_1.video)(w)) {
            const v = media.createEl('video', { attr: { src: source, width: '300', height: '444', preload: 'metadata', playsinline: '', controls: '', 'aria-label': String(w.title) + ' 视频封面' } });
            v.muted = true;
            v.loop = true;
            v.onerror = () => showFailure(Error('视频封面播放失败；可重试通过应用读取，或同步后使用本地视频。'));
            media.createSpan({ text: 'VIDEO', cls: 'matrees-media-badge' });
        }
        else {
            const img = media.createEl('img', { attr: { src: source, width: '300', height: '444', alt: String(w.title) + ' 封面' } });
            img.onerror = () => showFailure(Error('封面文件已读取，但当前设备无法解码此图片。'));
        } };
        const load = async () => { if (!alive())
            return; const local = this.plugin.localCover(wid, u); if (local) {
            show(local);
            return;
        } media.empty(); media.createDiv({ text: '正在读取封面…', cls: 'matrees-cover-placeholder' }); try {
            show(await this.plugin.previewCover(u));
        }
        catch (error) {
            showFailure(error);
        } };
        if (cached)
            show(cached);
        else if (u)
            void load();
        else
            media.createDiv({ text: '暂无封面', cls: 'matrees-cover-placeholder' });
        const body = card.createDiv({ cls: 'matrees-card-body' });
        body.createEl('h3', { text: String(w.title ?? '未命名世界观') });
        if (w.subTitle)
            body.createDiv({ text: String(w.subTitle), cls: 'matrees-subtitle' });
        body.createDiv({ text: (0, types_1.author)(w), cls: 'matrees-author' });
        if (this.plugin.mode === 'user')
            body.createDiv({ text: (0, types_1.worldRelation)(w, (0, types_1.id)(this.plugin.api?.user?.userId)), cls: 'matrees-world-relation' });
        body.createEl('p', { text: (0, content_1.plainText)(w.description, this.plugin.settings.baseUrl) || '暂无简介', cls: 'matrees-card-description' });
        if (w.matreesCoverWarning)
            body.createDiv({ text: String(w.matreesCoverWarning), cls: 'matrees-cover-warning' });
        const tags = body.createDiv({ cls: 'matrees-tags' });
        for (const tag of (Array.isArray(w.tags) ? w.tags : []).slice(0, 5))
            tags.createSpan({ text: String(tag.title ?? tag), cls: 'matrees-tag' });
        const row = body.createDiv({ cls: 'matrees-card-actions' });
        const preview = row.createEl('button', { text: '查看详情' });
        preview.onclick = () => new WorldPreview(this.app, this.plugin, w).open();
        const check = row.createEl('button', { text: '检测读取' });
        check.onclick = () => void this.plugin.guard(() => this.plugin.diagnoseWorld((0, types_1.id)(w.worldId)));
        const sync = row.createEl('button', { text: '同步到本地', cls: 'mod-cta' });
        sync.onclick = () => void this.plugin.guard(() => this.plugin.syncWorld((0, types_1.id)(w.worldId)));
    }
}
class SyncProgressView extends obsidian_1.ItemView {
    plugin;
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
    }
    getViewType() { return PROGRESS_VIEW; }
    getDisplayText() { return 'Matrees 同步进度'; }
    getIcon() { return 'refresh-cw'; }
    async onOpen() { this.render(); }
    render() {
        const e = this.contentEl, s = this.plugin.syncProgress;
        e.empty();
        e.addClass('matrees-progress-page');
        e.createDiv({ text: 'MATREES WORLD LIBRARY', cls: 'matrees-eyebrow' });
        e.createEl('h2', { text: '同步进度' });
        e.createEl('p', { text: s.worldId ? '世界 ID：' + s.worldId : '从世界观卡片点击“同步到本地”即可开始。', cls: 'matrees-description' });
        if (s.rootPath)
            e.createEl('p', { text: '本地目录：' + s.rootPath, cls: 'matrees-local-path' });
        const panel = e.createDiv({ cls: 'matrees-progress-panel' });
        panel.createEl('h3', { text: s.phase });
        panel.createDiv({ text: s.message, attr: { role: 'status', 'aria-live': 'polite' }, cls: 'matrees-progress-message' });
        if (s.status === 'running') {
            const meter = panel.createEl('progress', { attr: { 'aria-label': s.phase + '阶段进度' } });
            if (s.total != null && s.total > 0) {
                meter.max = s.total;
                meter.value = s.completed ?? 0;
                panel.createEl('p', { text: `本阶段 ${s.completed ?? 0} / ${s.total}（目录发现期间总数可能增加）` });
            }
            else
                panel.createEl('p', { text: '正在处理，待目录读取完成后才能确定数量。' });
        }
        if (s.startedAt) {
            const end = s.finishedAt ?? new Date().toISOString(), seconds = Math.max(0, Math.floor((Date.parse(end) - Date.parse(s.startedAt)) / 1000));
            panel.createEl('p', { text: '开始：' + new Date(s.startedAt).toLocaleString() + ' · 已用时 ' + Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒' });
        }
        if (s.status === 'complete')
            panel.createEl('p', { text: `保存 ${s.notes} 页 · 冲突 ${s.conflicts} · 待处理 ${s.warnings}` });
        if (s.status === 'error')
            panel.createEl('p', { text: '同步已停止。已保存页面的本地修改区保留；修复后可以重新同步。', cls: 'matrees-cover-warning' });
        const actions = e.createDiv({ cls: 'matrees-toolbar' });
        const library = actions.createEl('button', { text: '返回世界观卡片库' });
        library.onclick = () => void this.plugin.openLibrary();
        for (const [label, path] of [['打开世界总览', s.overviewPath], ['查看同步报告', s.reportPath]])
            if (path) {
                const button = actions.createEl('button', { text: label });
                button.onclick = () => void this.plugin.openNote(path);
            }
        if (s.rootPath) {
            const reveal = actions.createEl('button', { text: '在左侧定位目录' });
            reveal.onclick = () => void this.plugin.revealLocal(s.rootPath);
        }
        if (this.plugin.errors.length) {
            const details = actions.createEl('button', { text: '请求错误详情' });
            details.onclick = () => this.plugin.showLastError();
        }
        e.createEl('h3', { text: '最近处理记录' });
        const log = e.createEl('ol', { cls: 'matrees-progress-log' });
        for (const row of s.log.slice().reverse())
            log.createEl('li', { text: new Date(row.at).toLocaleTimeString() + ' · ' + row.message });
    }
}
class TokenModal extends obsidian_1.Modal {
    plugin;
    mode;
    done;
    constructor(app, plugin, mode, done) {
        super(app);
        this.plugin = plugin;
        this.mode = mode;
        this.done = done;
    }
    onOpen() {
        this.titleEl.setText(this.mode === 'admin' ? '管理员 Token' : '用户 Token');
        this.contentEl.createEl('p', { text: 'Token 将以明文保存到本仓库的插件 data.json，重启后自动读取。请勿分享含 Token 的 data.json。调试包附有此文件，分发前请移除。' });
        const status = this.contentEl.createEl('p', { text: this.plugin.tokenStatus(this.mode) });
        let value = this.plugin.token(this.mode);
        new obsidian_1.Setting(this.contentEl).setName('Token').addText(t => { t.inputEl.type = 'password'; t.inputEl.autocomplete = 'off'; t.setValue(value); t.setPlaceholder('粘贴 Token').onChange(v => value = v); });
        new obsidian_1.Setting(this.contentEl).addButton(b => b.setButtonText('保存并验证登录').setCta().onClick(async () => {
            b.setDisabled(true);
            let saved = false;
            try {
                await this.plugin.setToken(this.mode, value);
                saved = true;
                status.setText('已保存并校验，正在验证登录…');
                await this.plugin.changeMode(this.mode);
                await this.plugin.connect();
                status.setText('Token 已保存，登录验证成功。');
                await this.done();
                this.close();
            }
            catch (e) {
                status.setText((saved ? 'Token 已保存；连接验证失败：' : '保存失败：') + (0, network_1.errorDetail)(e, [value, this.plugin.token(this.mode)]));
                this.plugin.reportError(e);
            }
            finally {
                b.setDisabled(false);
            }
        })).addButton(b => b.setButtonText('验证已保存的 Token').onClick(async () => { b.setDisabled(true); try {
            await this.plugin.changeMode(this.mode);
            this.plugin.resetSession();
            await this.plugin.connect();
            status.setText('已保存的 Token 登录验证成功。');
            await this.done();
            this.close();
        }
        catch (e) {
            status.setText((0, network_1.errorDetail)(e, [this.plugin.token(this.mode)]));
            this.plugin.reportError(e);
        }
        finally {
            b.setDisabled(false);
        } }));
        new obsidian_1.Setting(this.contentEl).addButton(b => b.setButtonText('清除 Token').onClick(async () => { b.setDisabled(true); try {
            await this.plugin.clearToken(this.mode);
            status.setText('Token 已清除。');
        }
        catch (e) {
            status.setText((0, network_1.errorDetail)(e));
        }
        finally {
            b.setDisabled(false);
        } }));
    }
    onClose() { this.contentEl.empty(); }
}
class WorldPreview extends obsidian_1.Modal {
    plugin;
    world;
    constructor(app, plugin, world) {
        super(app);
        this.plugin = plugin;
        this.world = world;
    }
    onOpen() { this.titleEl.setText(String(this.world.title)); const e = this.contentEl; e.createEl('p', { text: '作者：' + (0, types_1.author)(this.world) }); e.createEl('p', { text: (0, content_1.plainText)(this.world.description, this.plugin.settings.baseUrl) }); const stats = this.world.statistics ?? {}; e.createEl('p', { text: `设定：${stats.definitionCount ?? '—'} · 事件：${stats.eventCount ?? '—'} · 总字数：${stats.totalWordCount ?? '—'}` }); e.createEl('p', { text: '同步进度页完成后可打开世界总览，可继续查看世界概念、设定集正文、下挂设定与插画。' }); new obsidian_1.Setting(e).addButton(b => b.setButtonText('同步全部资料').setCta().onClick(() => { this.close(); void this.plugin.guard(() => this.plugin.syncWorld((0, types_1.id)(this.world.worldId))); })); }
    onClose() { this.contentEl.empty(); }
}
class UploadPreview extends obsidian_1.Modal {
    plugin;
    local;
    payload;
    submit;
    component = new obsidian_1.Component();
    constructor(app, plugin, local, payload, submit) {
        super(app);
        this.plugin = plugin;
        this.local = local;
        this.payload = payload;
        this.submit = submit;
    }
    onOpen() {
        this.titleEl.setText('预览追加到云端的内容');
        this.modalEl.addClass('matrees-upload-modal');
        const e = this.contentEl;
        e.createEl('p', { text: `目标：${this.payload.title} · 世界 ${this.payload.worldId}` });
        e.createEl('p', { text: '将本地修改区追加到已同步的云端正文，创建一份更新提案。此命令不会点击提交审核，也不会清空本地修改区。' });
        const preview = e.createDiv({ cls: 'matrees-upload-preview' });
        this.component.load();
        void obsidian_1.MarkdownRenderer.render(this.app, this.local, preview, '', this.component);
        const details = e.createEl('details');
        details.createEl('summary', { text: '查看实际请求 JSON' });
        details.createEl('pre').createEl('code', { text: JSON.stringify(this.payload, null, 2) });
        new obsidian_1.Setting(e).addButton(b => b.setButtonText('取消').onClick(() => this.close())).addButton(b => b.setButtonText('创建云端提案').setCta().onClick(async () => { b.setDisabled(true); try {
            await this.submit();
            this.close();
        }
        catch (err) {
            this.plugin.reportError(err);
            this.close();
        } }));
    }
    onClose() { this.component.unload(); this.contentEl.empty(); }
}
class MatreesSettings extends obsidian_1.PluginSettingTab {
    plugin;
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const e = this.containerEl;
        e.empty();
        new obsidian_1.Setting(e).setName('账号与入口').setHeading();
        for (const mode of ['user', 'admin'])
            new obsidian_1.Setting(e).setName(mode === 'user' ? '用户 Token' : '管理员 Token').setDesc(mode === 'user' ? '普通入口读取账号拥有和参与的世界观。' : '管理员 Token 与用户 Token 分开保存。').addButton(b => b.setButtonText('填写 / 更换').onClick(() => new TokenModal(this.app, this.plugin, mode, async () => { this.display(); this.plugin.refreshViews(); }).open()));
        new obsidian_1.Setting(e).setName('Token 保存位置').setDesc('本仓库插件 data.json（明文）；重启后自动读取。不要分享该文件。');
        new obsidian_1.Setting(e).setName('请求通道').setDesc('自动：桌面读取优先直连 HTTPS，连接失败才尝试 Obsidian；移动端使用 Obsidian。HTTP 拒绝不会自动换通道。').addDropdown(d => d.addOptions({ auto: '自动', native: 'Obsidian 原生（使用应用网络环境）', direct: '桌面 HTTPS 直连（不继承应用代理）' }).setValue(this.plugin.settings.networkMode).onChange(v => void this.plugin.guard(() => this.plugin.setNetwork(v))));
        let apiAddress = this.plugin.settings.baseUrl;
        new obsidian_1.Setting(e).setName('API 地址').setDesc('默认使用 Matrees 官方 HTTPS 域名；输入完成后点击应用。').addText(t => t.setValue(apiAddress).onChange(value => apiAddress = value)).addButton(b => b.setButtonText('应用地址').onClick(() => void this.plugin.guard(() => this.plugin.setBase(apiAddress))));
        let count = this.plugin.settings.readConcurrency, interval = this.plugin.settings.requestIntervalMs;
        new obsidian_1.Setting(e).setName('读取并发数').setDesc('1–8，默认 3；并行读取不同设定集、设定详情、事件和章节。每个列表的分页按顺序读取，上传保持独占。').addDropdown(d => d.addOptions(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i + 1), String(i + 1)]))).setValue(String(count)).onChange(v => count = Number(v)));
        new obsidian_1.Setting(e).setName('请求启动间隔（毫秒）').setDesc('默认 150，范围 0–2000；收到 429 时降低并发或增加间隔。修改后点击应用。').addText(t => t.setValue(String(interval)).onChange(v => interval = Number(v))).addButton(b => b.setButtonText('应用读取配置').onClick(() => void this.plugin.guard(() => this.plugin.setReadOptions(count, interval))));
        new obsidian_1.Setting(e).setName('本地同步').setHeading();
        let rootFolder = this.plugin.settings.rootFolder;
        new obsidian_1.Setting(e).setName('保存目录').setDesc('仓库内相对路径；输入完成后应用。已同步世界的目录保持稳定，进度页显示实际路径。').addText(t => t.setValue(rootFolder).onChange(value => rootFolder = value)).addButton(b => b.setButtonText('应用目录').onClick(() => void this.plugin.guard(() => this.plugin.setRootFolder(rootFolder))));
        new obsidian_1.Setting(e).setName('下载图片和视频').setDesc('世界封面保存到世界目录下的“封面”，插画与正文媒体保存到“插画集/附件”。').addToggle(t => t.setValue(this.plugin.settings.downloadMedia).onChange(async (v) => { if (this.plugin.busy)
            return; await this.plugin.guard(async () => { this.plugin.settings.downloadMedia = v; await this.plugin.persist(); }); }));
        new obsidian_1.Setting(e).setName('单个媒体上限（MB）').setDesc('超过上限的媒体保留在线引用，并记入同步报告。').addText(t => t.setValue(String(this.plugin.settings.maxMediaMB)).onChange(async (v) => { const n = Number(v); if (this.plugin.busy || !Number.isFinite(n) || n < 1 || n > 2048)
            return; await this.plugin.guard(async () => { this.plugin.settings.maxMediaMB = n; await this.plugin.persist(); }); }));
        new obsidian_1.Setting(e).setName('附带世界扩展资料').setDesc('读取历法、事件、关系图谱、地图与作品章节。接口拒绝的项目列入报告。').addToggle(t => t.setValue(this.plugin.settings.extras).onChange(async (v) => { if (this.plugin.busy)
            return; await this.plugin.guard(async () => { this.plugin.settings.extras = v; await this.plugin.persist(); }); }));
        new obsidian_1.Setting(e).setName('本地修改保护').setDesc('只替换云端标记之间的内容；本地修改区及其外部内容逐字保留。标记损坏或云端区被手改时，保留原页并保存冲突候选。');
    }
}

},
"network":function(module,exports,__require,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.desktopRead = void 0;
exports.normalizeToken = normalizeToken;
exports.errorDetail = errorDetail;
exports.networkHint = networkHint;
exports.requestOptions = requestOptions;
exports.withTimeout = withTimeout;
exports.createTransport = createTransport;
exports.selectTransport = selectTransport;
function normalizeToken(value) {
    let token = value.trim();
    for (let i = 0; i < 3; i++) {
        if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
            token = token.slice(1, -1).trim();
        token = token.replace(/^(?:Authorization\s*[:：]\s*)/i, '').replace(/^Bearer\s+/i, '').trim();
    }
    token = token.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '');
    if (token && /[^\x21-\x7e]/.test(token))
        throw Error('Token 包含无效字符，请只粘贴 Token 本身。');
    return token;
}
function errorDetail(error, secrets = []) {
    const e = error;
    let s = typeof error === 'string' ? error : [e?.name, e?.code, e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean).join(' · ') || '底层网络组件未提供错误详情';
    for (const secret of secrets.filter(Boolean))
        s = s.split(secret).join('[凭证已隐藏]');
    return s.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[Token 已隐藏]').replace(/mtk_[A-Za-z0-9_-]+/g, '[密钥已隐藏]').replace(/(Authorization|flush-token)\s*[:=]\s*[^\s,;}]+/gi, '$1: [已隐藏]').replace(/https?:\/\/[^\s)]+/g, u => { try {
        const x = new URL(u);
        return x.origin + x.pathname;
    }
    catch {
        return '[地址已隐藏]';
    } }).slice(0, 600);
}
function networkHint(detail) {
    if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i.test(detail))
        return '域名解析失败，请检查 DNS 或代理。';
    if (/CERT|SSL|TLS|certificate/i.test(detail))
        return 'HTTPS 证书校验失败，请检查系统时间、证书或 HTTPS 代理。';
    if (/TIMEOUT|TIMEDOUT|timed out/i.test(detail))
        return '连接超时，请检查当前网络或代理。';
    if (/ECONNREFUSED|ERR_PROXY|ERR_TUNNEL/i.test(detail))
        return '连接被拒绝或代理不可用，请检查代理设置。';
    if (/header|character|ByteString/i.test(detail))
        return '请求头格式错误，请重新粘贴 Token。';
    return '未完成请求，请检查 Obsidian 的网络权限、代理和连接。';
}
function requestOptions(url, method, headers, body) {
    const read = method === 'GET' || method === 'HEAD';
    const clean = { ...headers };
    for (const key of Object.keys(clean))
        if ((read && key.toLowerCase() === 'content-type') || clean[key] == null)
            delete clean[key];
    const options = { url, method, headers: clean, throw: false };
    if (!read && body !== undefined)
        options.body = body;
    return options;
}
function statusOf(error) {
    const e = error;
    const n = Number(e?.status ?? e?.statusCode ?? e?.response?.status);
    return n >= 400 && n <= 599 ? n : 0;
}
function withTimeout(request, timeoutMs) {
    return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('ETIMEDOUT：请求超时；如为上传，请先核对云端结果，勿直接重复提交。')), timeoutMs); request.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); }); });
}
function createTransport(native, fallback) {
    return async (url, method, headers, body) => {
        const options = requestOptions(url, method, headers, body);
        try {
            return await withTimeout(native(options), 45000);
        }
        catch (first) {
            const code = statusOf(first);
            if (code)
                return { status: code, headers: {}, text: JSON.stringify({ code, msg: 'HTTP 请求被拒绝：' + errorDetail(first, Object.values(headers)) }) };
            const secrets = Object.entries(headers).filter(([k]) => /authorization|flush-token/i.test(k)).map(([, v]) => v);
            const detail = errorDetail(first, secrets);
            // Only retry idempotent reads; never retry certificate errors or a request with an HTTP response.
            if (fallback && (method === 'GET' || method === 'HEAD') && !/CERT|SSL|TLS|certificate/i.test(detail)) {
                try {
                    return await fallback(url, method, options.headers ?? {});
                }
                catch (second) {
                    throw Error('Obsidian 请求：' + detail + '；兼容请求：' + errorDetail(second, secrets));
                }
            }
            throw Error(detail);
        }
    };
}
function selectTransport(native, direct, mode = 'auto') {
    const nativeOnly = createTransport(native);
    if (mode === 'native')
        return nativeOnly;
    if (mode === 'direct' && !direct)
        return async () => { throw Error('此设备没有桌面 HTTPS 通道，请在设置中选择“自动”或“Obsidian 原生”。'); };
    if (!direct)
        return nativeOnly;
    const desktop = direct;
    const read = mode === 'direct' ? desktop : createTransport(o => desktop(o.url, o.method ?? 'GET', o.headers ?? {}), nativeOnly);
    return (url, method, headers, body) => method === 'GET' || method === 'HEAD' ? read(url, method, headers, body) : nativeOnly(url, method, headers, body);
}
// Loaded only on desktop, after the native transport fails. Uses normal CA validation.
const desktopRead = async (url, method, headers) => {
    if (method !== 'GET' && method !== 'HEAD')
        throw Error('兼容通道仅支持只读请求。');
    const https = require('node:https');
    const BufferCtor = require('node:buffer').Buffer;
    const original = new URL(url);
    if (original.protocol !== 'https:')
        throw Error('只允许 HTTPS。');
    function get(target, depth) {
        return new Promise((resolve, reject) => {
            const req = https.request(target, { method, headers: { ...headers, 'Accept-Encoding': 'identity' }, timeout: 30000 }, res => {
                const status = res.statusCode ?? 0;
                if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
                    res.resume();
                    const next = new URL(res.headers.location, target);
                    if (next.origin !== original.origin || next.protocol !== 'https:' || next.username || next.password || depth >= 3) {
                        reject(Error('兼容通道拒绝跨站或循环重定向。'));
                        return;
                    }
                    get(next, depth + 1).then(resolve, reject);
                    return;
                }
                const chunks = [];
                let size = 0;
                res.on('data', (chunk) => { size += chunk.length; if (size > 64 * 1024 * 1024) {
                    req.destroy(Error('响应超过 64 MB。'));
                    return;
                } chunks.push(chunk); });
                res.on('error', reject);
                res.on('end', () => resolve({ status, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')])), text: BufferCtor.concat(chunks).toString('utf8') }));
            });
            const deadline = setTimeout(() => req.destroy(Error('ETIMEDOUT：HTTPS 请求超过 45 秒')), 45000);
            req.on('close', () => clearTimeout(deadline));
            req.on('timeout', () => req.destroy(Error('ETIMEDOUT：兼容连接超时')));
            req.on('error', reject);
            req.end();
        });
    }
    return get(original, 0);
};
exports.desktopRead = desktopRead;

},
"regions":function(module,exports,__require,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCAL_END = exports.LOCAL_BEGIN = exports.CLOUD_END = exports.CLOUD_BEGIN = void 0;
exports.cloudPart = cloudPart;
exports.localPart = localPart;
exports.replaceCloud = replaceCloud;
exports.newNote = newNote;
exports.CLOUD_BEGIN = '<!-- MATREES:CLOUD:BEGIN -->';
exports.CLOUD_END = '<!-- MATREES:CLOUD:END -->';
exports.LOCAL_BEGIN = '<!-- MATREES:LOCAL:BEGIN -->';
exports.LOCAL_END = '<!-- MATREES:LOCAL:END -->';
function region(s, a, b) {
    const start = s.indexOf(a), end = s.indexOf(b);
    if (start < 0 || end < start || s.indexOf(a, start + a.length) >= 0 || s.indexOf(b, end + b.length) >= 0)
        throw Error('同步标记缺失、重复或顺序错误，已保留原文件。');
    return [start + a.length, end];
}
function cloudPart(s) { const [a, b] = region(s, exports.CLOUD_BEGIN, exports.CLOUD_END); return s.slice(a, b); }
function localPart(s) { const [a, b] = region(s, exports.LOCAL_BEGIN, exports.LOCAL_END); return s.slice(a, b).replace(/<!--[\s\S]*?-->/g, '').trim(); }
function replaceCloud(s, cloud) {
    const [a, b] = region(s, exports.CLOUD_BEGIN, exports.CLOUD_END);
    const [la, lb] = region(s, exports.LOCAL_BEGIN, exports.LOCAL_END);
    if (la < b || lb < la)
        throw Error('本地修改区与云端区域重叠，已保留原文件。');
    return s.slice(0, a) + '\n' + cloud.trim() + '\n' + s.slice(b);
}
function newNote(cloud, meta) {
    const yaml = Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
    return `---\n${yaml}\n---\n\n${exports.CLOUD_BEGIN}\n${cloud.trim()}\n${exports.CLOUD_END}\n\n## 本地修改\n\n${exports.LOCAL_BEGIN}\n\n<!-- 在这里写本地补充。云端同步会逐字保留此区域及其后方的内容。 -->\n\n${exports.LOCAL_END}\n`;
}

},
"scheduler":function(module,exports,__require,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestScheduler = void 0;
/** FIFO queue: bounded parallel reads, exclusive writes, and a shared start interval. */
class RequestScheduler {
    limit;
    gapMs;
    waiting = [];
    active = 0;
    writer = false;
    nextStart = 0;
    timer;
    stopped;
    constructor(limit = 1, gapMs = 0) {
        this.limit = limit;
        this.gapMs = gapMs;
        this.limit = Math.max(1, Math.min(8, Math.floor(limit) || 1));
        this.gapMs = Math.max(0, Math.min(2000, gapMs || 0));
    }
    run(read, fn) { if (this.stopped)
        return Promise.reject(this.stopped); return new Promise((resolve, reject) => { this.waiting.push({ read, run: fn, resolve, reject }); this.pump(); }); }
    stop(reason) { this.stopped = reason; clearTimeout(this.timer); this.timer = undefined; for (const job of this.waiting.splice(0))
        job.reject(reason); }
    pump() {
        if (this.stopped || this.timer || this.writer)
            return;
        while (this.waiting.length && this.active < this.limit) {
            const job = this.waiting[0];
            if (!job.read && this.active)
                return;
            const delay = this.nextStart - Date.now();
            if (delay > 0) {
                this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, delay);
                return;
            }
            this.waiting.shift();
            this.active++;
            this.writer = !job.read;
            this.nextStart = Date.now() + this.gapMs;
            Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { this.active--; if (!job.read)
                this.writer = false; this.pump(); });
            if (this.writer)
                return;
        }
    }
}
exports.RequestScheduler = RequestScheduler;

},
"sync":function(module,exports,__require,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IncrementalWriter = void 0;
exports.collectEntityNames = collectEntityNames;
exports.saveSnapshot = saveSnapshot;
const types_1 = __require("types");
const utils_1 = __require("utils");
const hierarchy_1 = __require("hierarchy");
const content_1 = __require("content");
const regions_1 = __require("regions");
const identityKeys = ['definitionId', 'eventId', 'mapId', 'workId', 'chapterId', 'mediaId', 'folderId', 'userId', 'guildId', 'calendarId', 'graphId', 'conceptId', 'volumeId', 'worldId'];
function displayName(o) { return String(o.title ?? o.name ?? o.label ?? o.nickname ?? o.username ?? o.originName ?? o.fileName ?? '').trim(); }
function collectEntityNames(...values) {
    const names = {}, seen = new Set();
    function walk(v, depth = 0) { if (depth > 20 || v == null)
        return; if (Array.isArray(v)) {
        for (const x of v)
            walk(x, depth + 1);
        return;
    } if (typeof v !== 'object')
        return; if (seen.has(v))
        return; seen.add(v); const o = (0, types_1.obj)(v), name = displayName(o); if (name) {
        for (const key of identityKeys) {
            const value = (0, types_1.id)(o[key]);
            if (value) {
                names[value] ??= name;
                break;
            }
        }
    } for (const x of Object.values(o))
        walk(x, depth + 1); }
    for (const value of values)
        walk(value);
    return names;
}
function namedPaths(root, rows, key, folder) {
    const out = {}, used = new Map();
    for (const row of rows) {
        const entityId = (0, types_1.id)(row[key]);
        if (!entityId)
            continue;
        const base = (0, utils_1.safePart)(row.title ?? row.name ?? row.label ?? '未命名', 48), n = (used.get(base) ?? 0) + 1;
        used.set(base, n);
        out[entityId] = root + '/' + folder + '/' + (n === 1 ? base : `${base} (${n})`) + '.md';
    }
    return out;
}
function legacyIdPath(path) { return /--\d+(?=\.|\/|$)/.test(path); }
class IncrementalWriter {
    world;
    settings;
    vault;
    progress;
    checkpoint;
    record;
    tail = Promise.resolve();
    wid;
    root;
    constructor(world, old, root, settings, vault, progress, checkpoint) {
        this.world = world;
        this.settings = settings;
        this.vault = vault;
        this.progress = progress;
        this.checkpoint = checkpoint;
        this.record = old ? structuredClone(old) : { root, notes: {}, assets: {} };
        this.root = this.record.root;
        this.wid = (0, types_1.id)(world.worldId);
    }
    run(fn) { const task = this.tail.catch(() => { }).then(fn); this.tail = task; return task; }
    async persist() { await this.checkpoint?.(this.record); }
    cover(o, world = false) { const u = (0, utils_1.coverSource)(o, this.settings.baseUrl); if (!u)
        return ''; const dimensions = world ? ' width="300" height="444"' : ''; return (0, utils_1.video)(o) ? `<video controls${dimensions} src="${(0, utils_1.esc)(u)}"></video>` : world ? `<img src="${(0, utils_1.esc)(u)}" alt="世界观封面"${dimensions}>` : `![封面](${u.replace(/[() ]/g, c => encodeURIComponent(c))})`; }
    async upsert(key, path, title, kind, entityId, cloud, rawPath, remoteHash) {
        const rec = this.record.notes[key];
        let target = rec?.path ?? path;
        if (rec && target !== path && legacyIdPath(target) && this.vault.move && this.vault.exists(target) && !this.vault.exists(path)) {
            await this.vault.move(target, path);
            target = path;
            rec.path = path;
            this.progress('已移除文件名中的旧数字 ID：' + title, { phase: '增量更新' });
        }
        const incomingHash = await (0, utils_1.hash)('\n' + cloud.trim() + '\n');
        if (this.vault.exists(target)) {
            if (!rec) {
                this.progress('发现未登记的本地文件，流式阶段不覆盖：' + target, { phase: '增量写入' });
                return;
            }
            const existing = await this.vault.read(target);
            let observed = 'invalid';
            try {
                observed = await (0, utils_1.hash)((0, regions_1.cloudPart)(existing));
            }
            catch { }
            if (observed !== rec.cloudHash) {
                this.progress('本地页已修改，流式阶段暂不覆盖：' + title, { phase: '增量写入' });
                return;
            }
            if (incomingHash !== rec.cloudHash)
                await this.vault.process(target, current => (0, regions_1.replaceCloud)(current, cloud));
        }
        else
            await this.vault.write(target, (0, regions_1.newNote)(cloud, { matrees_world_id: this.wid, matrees_entity_id: entityId, matrees_kind: kind, cssclasses: ['matrees-note'] }));
        this.record.notes[key] = { path: target, cloudHash: incomingHash, kind, entityId, title, rawPath, remoteHash };
        await this.persist();
        if (target !== path && !this.vault.exists(path))
            await this.vault.write(path, (0, regions_1.newNote)(`# ${(0, utils_1.mdText)(title)}\n\n${(0, utils_1.wiki)(target, '打开正文与本地修改区')}`, { matrees_kind: 'redirect', matrees_world_id: this.wid }));
    }
    async seedWorld() { return this.run(async () => { const path = this.root + '/00--世界总览.md'; const cloud = `# ${(0, utils_1.mdText)(this.world.title)}\n\n${this.cover(this.world, true)}\n\n${(0, utils_1.mdText)(this.world.subTitle ?? '')}\n\n作者：${(0, utils_1.mdText)((0, types_1.author)(this.world))}\n\n${(0, content_1.toMarkdown)(this.world.description, { base: this.settings.baseUrl, assets: this.record.assets, names: collectEntityNames(this.world), warnings: [] })}\n\n> [!info] 正在增量同步\n> 目录和正文会在拉取过程中持续更新。`; await this.upsert('world', path, String(this.world.title), 'world', this.wid, cloud); }); }
    async concept(concept, issue) { return this.run(async () => { const rawPath = this.root + (issue ? '/_原始数据/未取得正文/世界概念.json' : '/_原始数据/世界概念.json'); await this.vault.write(rawPath, JSON.stringify((0, utils_1.stripSecrets)(concept), null, 2) + '\n'); const cloud = `# 世界概念\n\n${issue ? '> [!warning] 本次未取得正文\n> ' + (0, utils_1.mdText)(issue) : (0, content_1.toMarkdown)(concept.content, { base: this.settings.baseUrl, assets: this.record.assets, links: { [this.wid]: this.root + '/00--世界总览.md' }, names: collectEntityNames(this.world, concept), warnings: [] }) || '（云端正文为空）'}`; await this.upsert('concept', this.root + '/世界概念.md', '世界概念', 'concept', (0, types_1.id)(concept.conceptId) || this.wid, cloud, rawPath, issue ? undefined : await (0, utils_1.hash)(JSON.stringify(concept.content ?? ''))); }); }
    async seedDefinitions(definitions, memberships) { return this.run(async () => { const layout = (0, hierarchy_1.layoutDefinitions)(this.root, definitions, memberships); for (const d of definitions) {
        const did = (0, types_1.id)(d.definitionId);
        if (!did)
            continue;
        const path = layout.paths[did], rec = this.record.notes['definition:' + did];
        if (!path)
            continue;
        if (rec && rec.path !== path && legacyIdPath(rec.path) && this.vault.move && this.vault.exists(rec.path) && !this.vault.exists(path)) {
            await this.vault.move(rec.path, path);
            rec.path = path;
            this.progress('已移除文件名中的旧数字 ID：' + String(d.title), { phase: '增量更新' });
            await this.persist();
        }
        if (rec)
            continue;
        const parents = (layout.parents[did] ?? []).map(p => (0, utils_1.wiki)(this.record.notes['definition:' + p]?.path ?? layout.paths[p], definitions.find(x => (0, types_1.id)(x.definitionId) === p)?.title));
        let cloud = `# ${(0, utils_1.mdText)(d.title)}\n\n${this.cover(d)}\n\n作者：${(0, utils_1.mdText)((0, types_1.author)(d))}\n\n${d.description ? (0, content_1.toMarkdown)(d.description, { base: this.settings.baseUrl, assets: this.record.assets, links: layout.paths, names: collectEntityNames(this.world, definitions), warnings: [] }) + '\n\n' : ''}${parents.length ? '所属设定集：' + parents.join(' · ') + '\n\n' : ''}> [!info] 正在读取正文\n> 此页已先创建，正文取得后会立即补全。`;
        await this.upsert('definition:' + did, path, String(d.title), (0, types_1.truth)(d.definitionSet) ? 'set' : 'definition', did, cloud);
        this.progress('已建立设定目录：' + String(d.title), { phase: '增量写入', entity: did });
    } }); }
    async definition(d, issue, definitions, memberships) { return this.run(async () => { const did = (0, types_1.id)(d.definitionId); if (!did)
        return; const layout = (0, hierarchy_1.layoutDefinitions)(this.root, definitions, memberships), links = { ...layout.paths }; for (const [key, n] of Object.entries(this.record.notes))
        if (key.startsWith('definition:'))
            links[key.slice(11)] = n.path; const ctx = { base: this.settings.baseUrl, assets: this.record.assets, links, names: collectEntityNames(this.world, definitions), warnings: [] }; const path = layout.paths[did] ?? this.record.notes['definition:' + did]?.path; if (!path)
        return; const rawPath = this.root + (issue ? '/_原始数据/未取得正文/' : '/_原始数据/设定/') + did + '.json'; await this.vault.write(rawPath, JSON.stringify((0, utils_1.stripSecrets)(d), null, 2) + '\n'); const parents = (layout.parents[did] ?? []).map(p => (0, utils_1.wiki)(links[p], definitions.find(x => (0, types_1.id)(x.definitionId) === p)?.title)); let cloud = `# ${(0, utils_1.mdText)(d.title)}\n\n${this.cover(d)}\n\n作者：${(0, utils_1.mdText)((0, types_1.author)(d))}\n\n${d.description ? (0, content_1.toMarkdown)(d.description, ctx) + '\n\n' : ''}${parents.length ? '所属设定集：' + parents.join(' · ') + '\n\n' : ''}`; if ((0, types_1.truth)(d.definitionSet))
        cloud += '> 本页为设定集自身正文。下挂条目将在目录读取完成后补齐。\n\n'; cloud += issue ? `> [!warning] 本次未取得正文\n> ${(0, utils_1.mdText)(issue)}。这不表示云端内容为空；下次取得正文后会自动补全。\n` : (0, content_1.toMarkdown)(d.content, ctx) || '（云端正文为空）'; await this.upsert('definition:' + did, path, String(d.title), (0, types_1.truth)(d.definitionSet) ? 'set' : 'definition', did, cloud, rawPath, issue ? undefined : await (0, utils_1.hash)(JSON.stringify(d.content))); this.progress('已增量写入：' + String(d.title), { phase: '增量写入', entity: did }); }); }
    async flush() { await this.tail; }
}
exports.IncrementalWriter = IncrementalWriter;
async function saveSnapshot(s, old, root, settings, vault, download, progress, checkpoint) {
    const record = old ? structuredClone(old) : { root, notes: {}, assets: {} };
    root = record.root;
    const wid = (0, types_1.id)(s.world.worldId), warnings = [...s.warnings], layout = (0, hierarchy_1.layoutDefinitions)(root, s.definitions, s.memberships);
    warnings.push(...layout.warnings);
    const names = collectEntityNames(s), eventPaths = namedPaths(root, s.events, 'eventId', '事件'), mapPaths = namedPaths(root, s.maps, 'mapId', '地图');
    const workDirs = {}, workPaths = {}, workUsed = new Map();
    for (const w of s.works) {
        const workId = (0, types_1.id)(w.workId);
        if (!workId)
            continue;
        const base = (0, utils_1.safePart)(w.title ?? w.name ?? '未命名作品', 48), n = (workUsed.get(base) ?? 0) + 1;
        workUsed.set(base, n);
        const dir = root + '/作品章节/' + (n === 1 ? base : `${base} (${n})`);
        workDirs[workId] = dir;
        workPaths[workId] = dir + '/00--作品信息.md';
    }
    const chapterPaths = {}, chapterUsed = new Map();
    for (const c of s.chapters) {
        const chapterId = (0, types_1.id)(c.chapterId);
        if (!chapterId)
            continue;
        const dir = workDirs[(0, types_1.id)(c.workId)] ?? root + '/作品章节/未归档';
        let used = chapterUsed.get(dir);
        if (!used)
            chapterUsed.set(dir, used = new Map());
        const base = (0, utils_1.safePart)(c.title ?? c.name ?? '未命名章节', 48), n = (used.get(base) ?? 0) + 1;
        used.set(base, n);
        chapterPaths[chapterId] = dir + '/' + (n === 1 ? base : `${base} (${n})`) + '.md';
    }
    const links = { ...layout.paths, ...eventPaths, ...mapPaths, ...workPaths, ...chapterPaths, [wid]: root + '/00--世界总览.md' };
    const ctx = { base: settings.baseUrl, assets: record.assets, links, names, warnings };
    let notes = 0, conflicts = 0;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Every raw object lives outside plugin settings. No token or user profile is serialized.
    async function raw(path, value) { await vault.write(path, JSON.stringify((0, utils_1.stripSecrets)(value), null, 2) + '\n'); }
    async function persist() { await checkpoint?.(record); }
    async function note(key, path, title, kind, entityId, cloud, rawPath, remoteHash) {
        const rec = record.notes[key];
        const oldPath = rec?.path ?? path;
        let target = oldPath;
        if (rec && oldPath !== path && legacyIdPath(oldPath) && vault.move && vault.exists(oldPath) && !vault.exists(path)) {
            await vault.move(oldPath, path);
            target = path;
            rec.path = path;
            warnings.push(`已迁移旧命名：${title}；文件名中的数字 ID 已移除。`);
        }
        else if (rec && oldPath !== path) {
            warnings.push(`云端目录变化：${title}；保留正文原路径，并在新位置建立导航。`);
        }
        const incomingHash = await (0, utils_1.hash)('\n' + cloud.trim() + '\n');
        if (vault.exists(target)) {
            let existing = await vault.read(target), observed;
            try {
                observed = await (0, utils_1.hash)((0, regions_1.cloudPart)(existing));
            }
            catch {
                observed = 'invalid';
            }
            if (!rec || observed !== rec.cloudHash) {
                conflicts++;
                const cp = root + '/_同步冲突/' + stamp + '/' + (0, utils_1.safePart)(key, 90) + '.md';
                await vault.write(cp, (0, regions_1.newNote)(cloud, { matrees_world_id: wid, matrees_entity_id: entityId, matrees_kind: kind, conflict_original: target }));
                warnings.push(`保留本地原文件：${target}；新版位于 ${cp}`);
                return;
            }
            if (incomingHash === rec.cloudHash) {
                record.notes[key] = { path: target, cloudHash: incomingHash, kind, entityId, title, rawPath, remoteHash };
                await persist();
                progress(`未变化，跳过写入：${title}`, { phase: '增量更新' });
                if (target !== path && !vault.exists(path))
                    await vault.write(path, (0, regions_1.newNote)(`# ${(0, utils_1.mdText)(title)}\n\n${(0, utils_1.wiki)(target, '打开正文与本地修改区')}`, { matrees_kind: 'redirect', matrees_world_id: wid }));
                return;
            }
            const expected = existing;
            try {
                await vault.process(target, current => { if (current !== expected)
                    throw Error('文件在同步期间被编辑。'); return (0, regions_1.replaceCloud)(current, cloud); });
            }
            catch (e) {
                conflicts++;
                const cp = root + '/_同步冲突/' + stamp + '/' + (0, utils_1.safePart)(key, 90) + '.md';
                await vault.write(cp, (0, regions_1.newNote)(cloud, { conflict_original: target }));
                warnings.push(`${title} 同步时发生编辑，已保存云端候选：${cp}`);
                return;
            }
        }
        else
            await vault.write(target, (0, regions_1.newNote)(cloud, { matrees_world_id: wid, matrees_entity_id: entityId, matrees_kind: kind, cssclasses: ['matrees-note'] }));
        progress(`已保存第 ${notes + 1} 页：${title}`, { phase: '保存页面', completed: notes + 1 });
        record.notes[key] = { path: target, cloudHash: incomingHash, kind, entityId, title, rawPath, remoteHash };
        notes++;
        await persist();
        if (target !== path && !vault.exists(path))
            await vault.write(path, (0, regions_1.newNote)(`# ${(0, utils_1.mdText)(title)}\n\n${(0, utils_1.wiki)(target, '打开正文与本地修改区')}`, { matrees_kind: 'redirect', matrees_world_id: wid }));
    }
    const resources = new Map();
    function addUrl(v, fileId) { const u = (0, utils_1.urlSafe)(v, settings.baseUrl); if (u && !resources.has(u))
        resources.set(u, (0, types_1.id)(fileId) || undefined); }
    for (const o of [s.world, s.concept, ...s.definitions, ...s.events, ...s.maps, ...s.chapters]) {
        addUrl((0, utils_1.coverSource)(o, settings.baseUrl), o.matreesCoverFileId ?? o.coverFileId ?? o.coverId);
        for (const ref of (0, content_1.mediaReferences)(o.content, ctx))
            addUrl(ref.url, ref.fileId);
        for (const ref of (0, content_1.mediaReferences)(o.description, ctx))
            addUrl(ref.url, ref.fileId);
        addUrl(o.mapUrl ?? o.imageUrl, o.fileId);
    }
    for (const m of s.illustrations) {
        addUrl(m.mediaUrl ?? m.url, m.fileId);
        for (const ref of (0, content_1.mediaReferences)(m.caption, ctx))
            addUrl(ref.url, ref.fileId);
    }
    for (const v of [...Object.values(s.extra), ...s.works])
        for (const ref of (0, content_1.mediaReferences)(v, ctx))
            addUrl(ref.url, ref.fileId);
    const worldCover = (0, utils_1.coverSource)(s.world, settings.baseUrl);
    let mediaDone = 0;
    progress('准备下载媒体…', { phase: '下载媒体', completed: 0, total: resources.size });
    for (const [u, fileId] of resources) {
        progress(`处理媒体 ${++mediaDone}/${resources.size}…`, { phase: '下载媒体', completed: mediaDone - 1, total: resources.size });
        if (record.assets[u] && vault.exists(record.assets[u]))
            continue;
        if (!settings.downloadMedia)
            continue;
        try {
            const r = await download(u, fileId);
            if (r.status === 403)
                throw Error('HTTP 403：媒体服务器拒绝下载；如果正文提供 fileId，下次会重新换取签名地址。');
            if (r.status < 200 || r.status >= 300)
                throw Error('HTTP ' + r.status);
            if (r.bytes.byteLength > settings.maxMediaMB * 1024 * 1024)
                throw Error(`超过 ${settings.maxMediaMB} MB 限制`);
            const mime = r.contentType.split(';')[0].trim().toLowerCase();
            if (!/^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/(mp4|webm|quicktime)|audio\/)/.test(mime))
                throw Error('媒体类型未通过校验：' + mime);
            const exts = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'm4a' };
            const ext = exts[mime] ?? 'bin', key = (await (0, utils_1.hash)(u)).slice(0, 24);
            const p = root + (u === worldCover ? '/封面/' : '/插画集/附件/') + key + '.' + ext;
            await vault.binary(p, r.bytes);
            record.assets[u] = p;
            await persist();
        }
        catch (e) {
            let label = u;
            try {
                const x = new URL(u);
                label = x.origin + x.pathname;
            }
            catch { }
            const message = '媒体未离线保存：' + label + '；' + (0, utils_1.redact)(e instanceof Error ? e.message : e);
            warnings.push(message);
            progress(message, { phase: '下载媒体', completed: mediaDone, total: resources.size, issue: { category: '封面/媒体' } });
        }
    }
    progress(`媒体处理完成：${mediaDone}/${resources.size}`, { phase: '下载媒体', completed: mediaDone, total: resources.size });
    progress('保存接口快照…', { phase: '保存原始资料' });
    const snapshotPath = root + '/_原始数据/snapshot.json';
    await raw(snapshotPath, s);
    const unavailable = s.unavailable ?? {};
    for (const [key, reason] of Object.entries(unavailable)) {
        const message = `设定 ${names[key] ?? '（名称未解析）'} 正文未取得：${reason}；已有本地正文保持不变。`;
        if (!warnings.some(w => w.includes(key) && w.includes(reason)))
            warnings.push(message);
    }
    const rawPaths = new Map();
    for (const d of s.definitions) {
        const p = root + (unavailable[(0, types_1.id)(d.definitionId)] ? '/_原始数据/未取得正文/' : '/_原始数据/设定/') + (0, types_1.id)(d.definitionId) + '.json';
        rawPaths.set((0, types_1.id)(d.definitionId), p);
        await raw(p, d);
    }
    function cover(o, world = false) {
        const u = (0, utils_1.coverSource)(o, settings.baseUrl);
        if (!u)
            return '';
        const p = record.assets[u], dimensions = world ? ' width="300" height="444"' : '';
        if ((0, utils_1.video)(o)) {
            const source = p ? `data-matrees-src="${(0, utils_1.esc)(p)}"` : `src="${(0, utils_1.esc)(u)}"`;
            return `<video controls${dimensions} ${source}></video>`;
        }
        if (p)
            return `![[${p}${world ? '|300x444' : ''}]]`;
        return world ? `<img src="${(0, utils_1.esc)(u)}" alt="世界观封面"${dimensions}>` : `![封面](${u.replace(/[() ]/g, c => encodeURIComponent(c))})`;
    }
    const sorted = [...s.definitions].sort((a, b) => Number((0, types_1.truth)(b.isPinned)) - Number((0, types_1.truth)(a.isPinned)) || Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0) || String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh-CN'));
    function gallery(d) {
        const ref = s.galleries[(0, types_1.id)(d.definitionId)] ?? {};
        const mids = new Set([...(0, types_1.arr)(ref.media).map(m => (0, types_1.id)(m.mediaId)), ...(Array.isArray(d.galleryImageIds) ? d.galleryImageIds.map(types_1.id) : [])]);
        const fids = new Set([...(0, types_1.arr)(ref.folders).map(f => (0, types_1.id)(f.folderId)), ...(Array.isArray(d.galleryFolderIds) ? d.galleryFolderIds.map(types_1.id) : [])]);
        const rows = s.illustrations.filter(m => mids.has((0, types_1.id)(m.mediaId)) || fids.has((0, types_1.id)(m.folderId)) || (0, types_1.arr)(m.usages).some(u => u.itemType === 'definition' && (0, types_1.id)(u.itemId) === (0, types_1.id)(d.definitionId)));
        return rows.length ? '\n\n## 关联插画\n\n' + rows.map(m => `${cover(m)}\n\n${(0, utils_1.mdText)(m.title ?? m.originName ?? '')}`).join('\n\n') : '';
    }
    for (const d of sorted) {
        const did = (0, types_1.id)(d.definitionId), kind = (0, types_1.truth)(d.definitionSet) ? 'set' : 'definition';
        // Resolve links to any stable canonical paths from earlier synchronizations.
        const previous = record.notes['definition:' + did]?.path;
        const canonical = previous && !legacyIdPath(previous) ? previous : layout.paths[did];
        ctx.links[did] = canonical;
    }
    for (const d of sorted) {
        const did = (0, types_1.id)(d.definitionId), issue = unavailable[did], previous = record.notes['definition:' + did];
        if (issue && previous && vault.exists(previous.path)) {
            progress('保留已有正文与本地修改：' + String(d.title), { phase: '保存页面' });
            continue;
        }
        progress('保存设定：' + String(d.title));
        const parents = (layout.parents[did] ?? []).map(p => (0, utils_1.wiki)(ctx.links[p], s.definitions.find(x => (0, types_1.id)(x.definitionId) === p)?.title));
        let cloud = `# ${(0, utils_1.mdText)(d.title)}\n\n${cover(d)}\n\n作者：${(0, utils_1.mdText)((0, types_1.author)(d))}\n\n${d.description ? (0, content_1.toMarkdown)(d.description, ctx) + '\n\n' : ''}${parents.length ? '所属设定集：' + parents.join(' · ') + '\n\n' : ''}`;
        if ((0, types_1.truth)(d.definitionSet))
            cloud += '> 本页为设定集自身正文。下挂条目列在正文之后。\n\n';
        cloud += issue ? `> [!warning] 本次未取得正文\n> ${(0, utils_1.mdText)(issue)}。这不表示云端内容为空；下次取得正文后会自动补全。\n\n` : (0, content_1.toMarkdown)(d.content, ctx) || '（云端正文为空）';
        cloud += gallery(d);
        if ((0, types_1.truth)(d.definitionSet)) {
            const children = sorted.filter(x => (0, types_1.id)(x.definitionId) !== did && (layout.parents[(0, types_1.id)(x.definitionId)] ?? []).includes(did));
            cloud += '\n\n## 下挂设定\n\n' + (children.map(x => `- ${(0, types_1.truth)(x.isPinned) ? '📌 ' : ''}${(0, utils_1.wiki)(ctx.links[(0, types_1.id)(x.definitionId)], x.title)}${(0, types_1.truth)(x.definitionSet) ? ' · 设定集' : ''}`).join('\n') || '暂无下挂设定。');
        }
        await note('definition:' + did, layout.paths[did], String(d.title), (0, types_1.truth)(d.definitionSet) ? 'set' : 'definition', did, cloud, rawPaths.get(did), issue ? undefined : await (0, utils_1.hash)(JSON.stringify(d.content)));
    }
    for (const link of layout.links) {
        const target = ctx.links[s.definitions.find(d => layout.paths[(0, types_1.id)(d.definitionId)] === link.target)?.definitionId] ?? link.target;
        await note('link:' + link.from, link.from, link.title, 'link', link.target, `# ${(0, utils_1.mdText)(link.title)}\n\n此设定挂载于多个设定集。\n\n${(0, utils_1.wiki)(target, '打开唯一正文与本地修改区')}`);
    }
    const conceptRaw = root + (s.conceptIssue ? '/_原始数据/未取得正文/世界概念.json' : '/_原始数据/世界概念.json');
    await raw(conceptRaw, s.concept);
    if (s.conceptIssue)
        warnings.push(s.conceptIssue);
    if (!(s.conceptIssue && record.notes.concept && vault.exists(record.notes.concept.path)))
        await note('concept', root + '/世界概念.md', '世界概念', 'concept', (0, types_1.id)(s.concept.conceptId) || wid, `# 世界概念\n\n${s.conceptIssue ? '> [!warning] 本次未取得正文\n> ' + (0, utils_1.mdText)(s.conceptIssue) : (0, content_1.toMarkdown)(s.concept.content, ctx) || '（云端正文为空）'}`, conceptRaw, s.conceptIssue ? undefined : await (0, utils_1.hash)(JSON.stringify(s.concept.content ?? '')));
    // Illustration folders retain their original tree; binary files are deduplicated by source URL.
    const folderPaths = new Map(), folderNames = new Map();
    function buildFolders(rows, parent) { let used = folderNames.get(parent); if (!used)
        folderNames.set(parent, used = new Map()); for (const f of rows) {
        const base = (0, utils_1.safePart)(f.title ?? f.name ?? '未命名目录', 48), n = (used.get(base) ?? 0) + 1;
        used.set(base, n);
        const p = parent + '/' + (n === 1 ? base : `${base} (${n})`);
        folderPaths.set((0, types_1.id)(f.folderId), p);
        buildFolders((0, types_1.arr)(f.children), p);
    } }
    buildFolders(s.illustrationTree, root + '/插画集');
    const grouped = new Map();
    grouped.set(root + '/插画集', []);
    for (const p of folderPaths.values())
        grouped.set(p, []);
    for (const m of s.illustrations) {
        const p = folderPaths.get((0, types_1.id)(m.folderId)) ?? root + '/插画集';
        if (!grouped.has(p))
            grouped.set(p, []);
        grouped.get(p).push(m);
    }
    for (const [p, rows] of grouped) {
        const children = [...folderPaths.entries()].filter(([, fp]) => fp.slice(0, fp.lastIndexOf('/')) === p);
        let c = '# 插画集\n\n' + children.map(([, fp]) => '- ' + (0, utils_1.wiki)(fp + '/00--插画目录.md', fp.split('/').at(-1)?.split('--')[0])).join('\n');
        for (const m of rows)
            c += `\n\n## ${(0, utils_1.mdText)(m.title ?? m.originName ?? m.mediaId)}\n\n${cover(m)}\n\n${(0, content_1.toMarkdown)(m.caption, ctx)}\n\n${(0, types_1.arr)(m.usages).map(u => ctx.links[(0, types_1.id)(u.itemId)] ? (0, utils_1.wiki)(ctx.links[(0, types_1.id)(u.itemId)], u.title) : (0, utils_1.mdText)(u.title ?? u.itemId)).join(' · ')}`;
        await note('gallery:' + p, p + '/00--插画目录.md', '插画目录', 'gallery', wid, c);
    }
    for (const [kind, rows, key, paths] of [['event', s.events, 'eventId', eventPaths], ['map', s.maps, 'mapId', mapPaths], ['chapter', s.chapters, 'chapterId', chapterPaths]]) {
        for (const d of rows) {
            const entityId = (0, types_1.id)(d[key]), title = String(d.title ?? d.name ?? names[entityId] ?? '未命名');
            const p = paths[entityId];
            if (!p)
                continue;
            const rp = root + '/_原始数据/' + kind + '/' + entityId + '.json';
            await raw(rp, d);
            await note(kind + ':' + entityId, p, title, kind, entityId, `# ${(0, utils_1.mdText)(title)}\n\n${cover(d)}\n\n${(0, content_1.toMarkdown)(d.content ?? d.description, ctx)}\n\n## 详细资料\n\n${(0, content_1.toMarkdown)(Object.fromEntries(Object.entries(d).filter(([k]) => !['content', 'description', 'title', 'name'].includes(k))), ctx)}\n\n${(0, utils_1.wiki)(rp, '原始接口数据')}`, rp);
        }
    }
    const dataLinks = [];
    const labels = { calendars: '历法', relations: '关系图谱' };
    for (const [k, v] of Object.entries(s.extra))
        if (v !== null) {
            const title = labels[k] ?? (k.startsWith('chapters-') ? '章节目录 ' + k.slice(9) : k), rp = root + '/_原始数据/' + (0, utils_1.safePart)(k, 80) + '.json', p = root + '/扩展资料/' + (0, utils_1.safePart)(title, 80) + '.md';
            await raw(rp, v);
            await note('extra:' + k, p, title, 'extra', k, `# ${(0, utils_1.mdText)(title)}\n\n${(0, content_1.toMarkdown)(v, ctx) || '暂无资料。'}\n\n${(0, utils_1.wiki)(rp, '原始接口数据')}`, rp);
            dataLinks.push('- ' + (0, utils_1.wiki)(record.notes['extra:' + k]?.path ?? p, title));
        }
    for (const w of s.works) {
        const workId = (0, types_1.id)(w.workId), title = String(w.title ?? w.name ?? names[workId] ?? '未命名作品'), p = workPaths[workId] ?? root + '/作品章节/未归档/00--作品信息.md';
        await note('work:' + workId, p, title, 'work', workId, `# ${(0, utils_1.mdText)(title)}\n\n${(0, content_1.toMarkdown)(w, ctx)}\n\n## 正文章节\n\n` + s.chapters.filter(c => (0, types_1.id)(c.workId) === workId).map(c => '- ' + (0, utils_1.wiki)(record.notes['chapter:' + (0, types_1.id)(c.chapterId)]?.path ?? '', c.title ?? c.chapterId)).join('\n'));
        dataLinks.push('- ' + (0, utils_1.wiki)(p, title));
    }
    const infoPath = root + '/世界详细资料.md';
    await note('world-info', infoPath, '世界详细资料', 'world-info', wid, '# 世界详细资料\n\n' + (0, content_1.toMarkdown)(s.world, ctx));
    dataLinks.unshift('- ' + (0, utils_1.wiki)(infoPath, '世界详细资料'));
    const summary = `# ${(0, utils_1.mdText)(s.world.title)}\n\n${cover(s.world, true)}\n\n${(0, utils_1.mdText)(s.world.subTitle ?? '')}\n\n作者：${(0, utils_1.mdText)((0, types_1.author)(s.world))}\n\n${(0, content_1.toMarkdown)(s.world.description, ctx)}\n\n## 世界资料\n\n- ${(0, utils_1.wiki)(root + '/世界概念.md', '世界概念')}\n- ${(0, utils_1.wiki)(root + '/插画集/00--插画目录.md', '插画集')}\n- ${(0, utils_1.wiki)(snapshotPath, '完整接口快照')}\n\n## 设定目录\n\n${sorted.filter(d => !(layout.parents[(0, types_1.id)(d.definitionId)] ?? []).length).map(d => '- ' + (0, utils_1.wiki)(ctx.links[(0, types_1.id)(d.definitionId)], d.title)).join('\n')}\n\n## 其他信息\n\n${dataLinks.join('\n')}`;
    await note('world', root + '/00--世界总览.md', String(s.world.title), 'world', wid, summary, snapshotPath);
    const report = `# 同步报告\n\n时间：${s.fetchedAt}\n\n设定与设定集：${s.definitions.length}\n\n正文未取得：${Object.keys(unavailable).length}${s.conceptIssue ? '；世界概念正文也未取得' : ''}（保留旧页或创建占位页）\n\n插画：${s.illustrations.length}\n\n本次写入页面：${notes}\n\n冲突：${conflicts}\n\n${warnings.length ? '## 待处理项\n\n' + [...new Set(warnings)].map(x => '- ' + x).join('\n') : '所有已配置读取步骤完成。'}\n\n云端消失的旧页面保留，不自动删除。本次接口快照保存于 _原始数据。\n`;
    await vault.write(root + '/_同步报告/' + stamp + '.md', report);
    record.lastSync = s.fetchedAt;
    await persist();
    return { record, warnings: [...new Set(warnings)], notes, conflicts, reportPath: root + '/_同步报告/' + stamp + '.md' };
}

},
"types":function(module,exports,__require,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.truth = exports.id = exports.arr = exports.obj = exports.DEFAULT_SETTINGS = void 0;
exports.ids = ids;
exports.ownerId = ownerId;
exports.author = author;
exports.worldRelation = worldRelation;
exports.DEFAULT_SETTINGS = {
    networkMode: 'auto', baseUrl: 'https://www.matrees.cn', rootFolder: 'Matrees', userSecret: 'matrees-user-token', adminSecret: 'matrees-admin-token',
    readConcurrency: 3, requestIntervalMs: 150, downloadMedia: true, maxMediaMB: 200, extras: true
};
const obj = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
exports.obj = obj;
const arr = (v) => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [];
exports.arr = arr;
const id = (v) => v == null ? '' : typeof v === 'object' ? (0, exports.id)((0, exports.obj)(v).definitionId ?? (0, exports.obj)(v).tagId ?? (0, exports.obj)(v).id ?? (0, exports.obj)(v).value ?? (0, exports.obj)(v).key) : String(v);
exports.id = id;
const truth = (v) => v === true || v === 1 || v === '1' || v === 'true';
exports.truth = truth;
function ids(v) { return [...new Set((Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : v ? [v] : []).map(exports.id).filter(x => x && x !== '0'))]; }
function ownerId(w) { return (0, exports.id)(w.ownerUser?.userId ?? w.ownerId ?? w.ownerUserId ?? w.createUser?.userId ?? w.createUserId); }
function author(w) { const u = w.ownerUser ?? w.createUser ?? {}; return String(u.nickname ?? u.username ?? '未知作者'); }
function worldRelation(w, userId) {
    if (ownerId(w) === userId)
        return '我拥有';
    const labels = { manager: '管理员', auditor: '审核者', co_creator: '共创者', coCreator: '共创者', proposer: '参与者', guild_leader: '公会会长', guild_vice_leader: '公会副会长' };
    const roles = [...new Set((Array.isArray(w.permissions) ? w.permissions : []).map((p) => labels[p]).filter(Boolean))];
    const guilds = (0, exports.arr)(w.matreesGuilds).map(g => String(g.title));
    return (roles.length ? '我参与 · ' + roles.join(' / ') : '我参与') + (guilds.length ? ' · 公会：' + [...new Set(guilds)].join(' / ') : '');
}

},
"utils":function(module,exports,__require,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wiki = exports.mdText = exports.esc = void 0;
exports.safePart = safePart;
exports.safeRoot = safeRoot;
exports.urlSafe = urlSafe;
exports.baseUrl = baseUrl;
exports.video = video;
exports.hash = hash;
exports.redact = redact;
exports.stripSecrets = stripSecrets;
exports.pool = pool;
exports.settledPool = settledPool;
exports.concurrency = concurrency;
exports.coverSource = coverSource;
function safePart(s, limit = 36) {
    let t = String(s ?? '未命名').normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|#\[\]^]/g, '_').replace(/[. ]+$/g, '').trim();
    t = Array.from(t).slice(0, limit).join('');
    if (!t || t === '.' || t === '..')
        t = '未命名';
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(t))
        t = '_' + t;
    return t;
}
function safeRoot(s) {
    const p = s.replace(/\\/g, '/');
    if (!p || p.startsWith('/') || p.split('/').some(x => !x || x === '.' || x === '..' || x.startsWith('.') || /[:*?"<>|\x00-\x1f]/.test(x)))
        throw Error('保存目录必须是仓库内的普通相对目录，例如 Matrees。');
    return p.replace(/\/+$/, '');
}
function urlSafe(s, base) {
    try {
        if (!String(s ?? '').trim())
            return '';
        const u = new URL(String(s), base);
        return u.protocol === 'https:' && !u.username && !u.password ? u.href : '';
    }
    catch {
        return '';
    }
}
function baseUrl(s) { const u = new URL(s); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/')
    throw Error('API 地址必须为 HTTPS 根域名。'); return u.origin; }
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
exports.esc = esc;
const mdText = (s) => String(s ?? '').replace(/[\\`*_[\]<>|]/g, '\\$&').replace(/[\r\n]/g, ' ');
exports.mdText = mdText;
const wiki = (path, title) => `[[${path.replace(/\.md$/, '')}${title ? '|' + String(title).replace(/[\]|\r\n]/g, ' ') : ''}]]`;
exports.wiki = wiki;
function video(o) { return /video/i.test(String(o.coverType ?? o.mediaType ?? '')) || /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(String(o.coverUrl ?? o.mediaUrl ?? '')); }
async function hash(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join(''); }
function redact(s) { return String(s ?? '未知错误').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[Token 已隐藏]').replace(/mtk_[A-Za-z0-9_-]+/g, '[密钥已隐藏]'); }
function stripSecrets(v) {
    if (Array.isArray(v))
        return v.map(stripSecrets);
    if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).filter(([k]) => !/^(token|flushToken|authorization|password|phone|email|phoneRegionCode|energyBalance|matterBalance)$/i.test(k)).map(([k, x]) => [k, stripSecrets(x)]));
    return v;
}
async function pool(items, fn, n = 1) {
    const out = new Array(items.length);
    let next = 0, failed = false, reason;
    await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(n) || 1), items.length) }, async () => { while (!failed) {
        const i = next++;
        if (i >= items.length)
            break;
        try {
            out[i] = await fn(items[i]);
        }
        catch (e) {
            if (!failed) {
                failed = true;
                reason = e;
            }
        }
    } }));
    if (failed)
        throw reason;
    return out;
}
async function settledPool(items, fn, n = 1) {
    const values = new Array(items.length), errors = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(n) || 1), items.length) }, async () => { for (;;) {
        const i = next++;
        if (i >= items.length)
            break;
        try {
            values[i] = await fn(items[i], i);
        }
        catch (error) {
            errors.push({ index: i, item: items[i], error });
        }
    } }));
    return { values, errors };
}
function concurrency(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(1, Math.min(8, Math.floor(n))) : 3; }
/** API cover IDs are not URLs. Only use URL fields or explicitly URL-shaped cover values. */
function coverSource(o, base) {
    const cover = typeof o.cover === 'object' ? o.cover?.url ?? o.cover?.src : o.cover;
    for (const value of [o.coverUrl, o.cover_url, o.mediaUrl, cover])
        if (typeof value === 'string' && /^(https:\/\/|\/)/.test(value)) {
            const u = urlSafe(value, base);
            if (u)
                return u;
        }
    return '';
}

}};
const __cache=Object.create(null);
function __require(id){if(__cache[id])return __cache[id].exports;const fn=__modules[id];if(!fn)throw new Error('Unknown internal module: '+id);const module={exports:{}};__cache[id]=module;fn(module,module.exports,__require,require);return module.exports;}
const entry=__require('main');module.exports=entry&&entry.default?entry.default:entry;
})();
