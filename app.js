/* ============================================================
   KOTOBA·AI — 前端交互逻辑
   状态管理 / API 交互 / 屏幕切换 / 进度保存
   ============================================================ */

// --- 全局状态 ---
const AppState = {
    config: { api_key: "", level: "N3", model: "deepseek-flash", provider: "deepseek", providers: [] },
    questions: [],          // 全部题目
    currentIndex: 0,        // 当前题目索引
    records: [],            // 答题记录
    notes: "",              // 原始笔记（只承载用户手输内容；复习/答疑联动不写这里，见 sessionNotes）
    sessionNotes: "",       // Beta 6.0：本次会话摘要（复习点/答疑联动），只随答题流转，回主页不回填、不污染笔记框
    vocabulary: "",         // 今日单词（原始文本）
    vocabUsed: [],          // AI 出题中用到的今日单词
    totalAnswered: 0,       // 已答题数（含加练/换题）
    baseTotal: 0,           // 原始题目总数（进度条分母）
    historyDate: null,      // 查看历史详情时的日期
    questionType: "translation",  // M4: 题型 "translation" | "fill_blank" | "mixed"
    fillblankSelected: null,      // M4: 填空选择题选中的选项索引
    fillblankLocked: false,       // M8.x: 答案揭晓后锁定选项，禁止再改选
    selectedGrammarPoints: [],     // M5.x: 教材语法点多选 [{point, explanation}]
    immediateSaved: new Set(),      // 复习点立即更新集合（弹窗去重）
    learnedMap: null,               // 会话内 learned_content 键缓存（一次性拉取，复习点识别用）
    reviewBatchSize: 12,            // Beta 5.5：每批最多复习知识点数
    selectedReviewPoints: [],       // Beta 5.5：当前批选中的知识点
    remainingReviewPoints: [],      // Beta 5.5：批量复习 session 中未复习的到期知识点
    reviewInBatchMode: false,       // Beta 5.5：是否处于批量复习 session
    isBankPractice: false,
};

// --- 工具函数 ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function show(el) { el.style.display = ""; }
function hide(el) { el.style.display = "none"; }
function maskKey(key) {
    if (!key) return "未设置";
    return key.slice(0, 5) + "••••" + key.slice(-4);
}
function escapeHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// --- 界面缩放（Ctrl + / - / 0，和浏览器一致）---
function initZoom() {
    const root = document.documentElement;
    let scale = parseFloat(localStorage.getItem("kotoba-ui-scale") || "1");
    // 限制范围
    scale = Math.max(0.5, Math.min(2.5, scale));
    root.style.setProperty("--ui-scale", scale);
    localStorage.setItem("kotoba-ui-scale", scale);

    document.addEventListener("keydown", (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        // 输入框内不拦截
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;

        let target = null;
        if (e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd") {
            // Ctrl+= 放大（按 shift 出的 + 也识别）
            target = Math.min(2.5, scale + 0.1);
        } else if (e.key === "-" || e.code === "Minus" || e.code === "NumpadSubtract") {
            // Ctrl+- 缩小
            target = Math.max(0.5, scale - 0.1);
        } else if (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0") {
            // Ctrl+0 重置
            target = 1;
        }

        if (target !== null) {
            e.preventDefault();
            scale = Math.round(target * 10) / 10; // 一位小数精度
            root.style.setProperty("--ui-scale", scale);
            localStorage.setItem("kotoba-ui-scale", scale);
        }
    });
}
initZoom();

// --- API 封装（M2 原生桥：有桥走桥、无桥走 fetch）---
let _bridgeReadyPromise = null;   // 桥就绪判定缓存（true=走桥，false=浏览器 fetch）

function _bridgeAvailable() {
    return !!(window.pywebview && window.pywebview.api
        && typeof window.pywebview.api.fetch_api === "function");
}

// M0 实测：file:// 下 window.pywebview.api 于 DOMContentLoaded 后 ~60ms 才就绪。
// 首次调用（boot 的 loadConfig）须先等桥就绪——轮询 ~20ms、上限 ~1s；就绪走桥，
// 超时视为无桥（浏览器 dev 模式）。判定结果缓存，避免每次调用都等。
function _waitBridge(timeout = 1000) {
    if (_bridgeAvailable()) return Promise.resolve(true);
    if (!_bridgeReadyPromise) {
        _bridgeReadyPromise = new Promise((resolve) => {
            const start = Date.now();
            const timer = setInterval(() => {
                if (_bridgeAvailable()) { clearInterval(timer); resolve(true); }
                else if (Date.now() - start > timeout) { clearInterval(timer); resolve(false); }
            }, 20);
        });
    }
    return _bridgeReadyPromise;
}
_waitBridge(); // 预启动：桥注入晚于 DOMContentLoaded，提前轮询等它就绪

// 前端错误上报（Beta 7.0 修缮 #3）：JS 异常 / Promise 拒绝 / api() 5xx 汇入后端日志
// 同一条时间线。自守卫：上报本身失败绝不二次上报、绝不打断主流程。
let _reportingFrontendError = false;
async function reportFrontendError(message, stack = "", source = "") {
    if (_reportingFrontendError) return;
    _reportingFrontendError = true;
    try {
        const body = JSON.stringify({ message: String(message || ""), stack, source });
        if (window.pywebview && window.pywebview.api && window.pywebview.api.fetch_api) {
            await window.pywebview.api.fetch_api("POST", "/api/log/frontend", body);
        } else if (location.protocol !== "file:") {
            await fetch("/api/log/frontend", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
            });
        }
    } catch (e) {
        /* 上报失败静默（后端不可达时也无能为力） */
    } finally {
        _reportingFrontendError = false;
    }
}
window.addEventListener("error", (ev) => {
    reportFrontendError(ev.message, ev.error && ev.error.stack || "", ev.filename ? `${ev.filename}:${ev.lineno}` : "window.onerror");
});
window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    reportFrontendError(r && r.message || String(r), r && r.stack || "", "unhandledrejection");
});

async function api(url, options = {}) {
    // 桥模式：同进程分发。file:// 下无 HTTP 服务器，桥未就绪时报「桥不可用」，绝不回退 fetch
    if (await _waitBridge()) {
        let r;
        try {
            r = await window.pywebview.api.fetch_api(
                (options.method || "GET").toUpperCase(), url, options.body || null);
        } catch (e) {
            // 桥协议异常（对象/方法缺失、Python 侧抛异常）→ 报桥不可用
            reportFrontendError(`桥异常 ${url}: ${e && e.message || e}`, e && e.stack || "", "api.bridge");
            throw new Error("本地服务桥不可用，请重启应用");
        }
        if (!r || !r.ok) {
            // 服务器返回的明确错误直接抛出；5xx 说明后端路由内部出错，留痕日志
            if (r && r.status >= 500) {
                reportFrontendError(`后端 5xx ${url} (HTTP ${r.status})`, "", "api.5xx");
            }
            throw new Error((r && r.data && (r.data.error || r.data.message))
                || `请求失败 (HTTP ${r ? r.status : "未知"})`);
        }
        if (r.file) {
            throw new Error("该接口返回文件下载，请改用下载功能");
        }
        return r.data;
    }
    // file:// 模式无 HTTP 服务器：桥未就绪直接报「桥不可用」，不得回退 fetch
    if (location.protocol === "file:") {
        throw new Error("本地服务桥不可用，请重启应用");
    }
    // 浏览器 dev 模式（http://）：无桥走 fetch（原逻辑）
    try {
        const res = await fetch(url, {
            headers: { "Content-Type": "application/json" },
            ...options,
        });
        const data = await res.json();
        if (!res.ok) {
            // 优先显示服务器返回的错误信息
            throw new Error(data.error || `请求失败 (HTTP ${res.status})`);
        }
        return data;
    } catch (err) {
        // 服务器返回的明确错误直接抛出；网络不通才报「连不上本地服务」
        if (err.message && !err.message.includes("Failed to fetch")) {
            throw err;
        }
        throw new Error("无法连接本地服务，请确认 KOTOBA·AI 服务已启动（python app.py）后刷新页面");
    }
}

// 桥上传：FormData → {__upload__} 信封（base64 过桥）；浏览器模式走原生 FormData
async function apiUpload(url, file, form = {}) {
    if (await _waitBridge()) {
        const b64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
            reader.onerror = () => reject(new Error("读取文件失败"));
            reader.readAsDataURL(file);
        });
        const body = {
            __upload__: {
                field: "file",
                filename: file.name || "upload.bin",
                mime: file.type || "application/octet-stream",
                bytes_b64: b64,
                form: form,
            },
        };
        let r;
        try {
            r = await window.pywebview.api.fetch_api("POST", url, body);
        } catch (e) {
            throw new Error("本地服务桥不可用，请重启应用");
        }
        if (!r || !r.ok) {
            throw new Error((r && r.data && (r.data.error || r.data.warning))
                || `上传失败 (HTTP ${r ? r.status : "未知"})`);
        }
        return r.data;
    }
    const fd = new FormData();
    fd.append("file", file);
    for (const k of Object.keys(form)) fd.append(k, form[k]);
    const res = await fetch(url, { method: "POST", body: fd });
    return await res.json().catch(() => ({}));
}

// 附件下载（DP-4）：桥模式弹原生保存对话框落盘（save_bytes），浏览器模式 window.open
async function downloadFile(url) {
    if (await _waitBridge()) {
        let r;
        try {
            r = await window.pywebview.api.fetch_api("GET", url);
        } catch (e) {
            throw new Error("本地服务桥不可用，请重启应用");
        }
        if (r && r.file) {
            const sr = await window.pywebview.api.save_bytes(r.file.bytes_b64, r.file.filename);
            if (sr && sr.success) return sr;
            if (sr && sr.cancelled) return sr;
            throw new Error((sr && sr.error) || "保存失败");
        }
        throw new Error((r && r.data && r.data.error) || "下载失败");
    }
    window.open(url, "_blank");
    return { ok: true };
}

// 附件文本读取（桥模式解码 base64，浏览器模式 fetch text）——历史详情 Markdown 预览用
async function apiFileText(url) {
    if (await _waitBridge()) {
        let r;
        try {
            r = await window.pywebview.api.fetch_api("GET", url);
        } catch (e) {
            throw new Error("本地服务桥不可用，请重启应用");
        }
        if (r && r.file) {
            const bin = atob(r.file.bytes_b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new TextDecoder("utf-8").decode(bytes);
        }
        throw new Error((r && r.data && r.data.error) || "加载失败");
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error("加载失败");
    return await res.text();
}

// ============================================================
// 批改真流式（PRD §3.7）：dev SSE + 桥 events 双通道，失败回退非流式
// ============================================================
let _gradeToken = 0;            // 新流启动递增；旧流事件凭 token 丢弃
let gradeStreamCleanup = null;  // 取消当前活跃流的函数（桥 cancel / dev abort）
let _streamState = null;        // 流式态（打字机定时器渲染用）
let _revealQueue = [];          // 打字机队列：段落级事件 → 逐字显示（DeepSeek 观感）
let _revealTimer = null;

// 逐字揭示：每 tick 推进一个字符，打满后提交进 _streamState
function _clearReveal() {
    if (_revealTimer) { clearInterval(_revealTimer); _revealTimer = null; }
    _revealQueue = [];
}
function _enqueueReveal(item) {
    item._i = 0;
    _revealQueue.push(item);
    if (!_revealTimer) _revealTimer = setInterval(_revealTick, 24);
}
function _revealTick() {
    if (!_revealQueue.length) { clearInterval(_revealTimer); _revealTimer = null; return; }
    const head = _revealQueue[0];
    // 按完整码点推进，避免 emoji（代理对）闪半个字符
    head._i += head.text.codePointAt(head._i) > 0xFFFF ? 2 : 1;
    if (head._i >= head._len) {
        _commitRevealed(head);
        _revealQueue.shift();
        if (!_revealQueue.length) { clearInterval(_revealTimer); _revealTimer = null; }
    }
    _renderStreamState();
}
function _commitRevealed(head) {
    const st = _streamState;
    if (!st) return;
    if (head.kind === "correct") st.correct.push(head.text);
    else if (head.kind === "grammar_check") st.grammarCheck.push(head.text);
    else if (head.kind === "error") st.errors.push(head.error);
    else if (head.kind === "suggest") st.suggestions = head.text;
    else if (head.kind === "extra") st.extra = head.text;
    else if (head.kind === "encourage") st.encouragement = head.text;
}
function _composeErrorText(e) {
    const lv = (e.level || "").replace(/[⚠️❌]/gu, "").trim();
    return `${lv ? lv + "：" : "错误："}${e.error || ""}\n正确：${e.correction || ""}\n解释：${e.explanation || ""}`;
}

// 主动取消当前流式批改（换题/加难/切页兜底）
function cancelGradeStream() {
    if (gradeStreamCleanup) {
        try { gradeStreamCleanup(); } catch (e) {}
        gradeStreamCleanup = null;
    }
    _clearReveal();
}

// dev SSE：fetch + ReadableStream 手写行解析（EventSource 只支持 GET）
// 返回取消函数（AbortController.abort）；超时 20s 兜底 → onError
function apiStream(url, body, onChunk, onDone, onError) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    (async () => {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
                signal: ac.signal,
            });
            if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let sep;
                while ((sep = buf.indexOf("\n\n")) >= 0) {
                    const frame = buf.slice(0, sep);
                    buf = buf.slice(sep + 2);
                    let data = "";
                    frame.split("\n").forEach(line => {
                        if (line.startsWith("data:")) data = (data ? data + "\n" : "") + line.slice(5).trim();
                    });
                    if (!data) continue;
                    let payload;
                    try { payload = JSON.parse(data); } catch { continue; }
                    if (payload.kind === "done") { if (payload.truncated) throw new Error("流式截断"); onDone(payload.full); return; }
                    if (payload.kind === "error") throw new Error("流式失败");
                    onChunk(payload);
                }
            }
            throw new Error("流式未完成");
        } catch (err) {
            onError(err);
        } finally {
            clearTimeout(timer);
        }
    })();
    return () => { try { ac.abort(); } catch (e) {} };
}

// 桥流式：JsApi.grade_answer_stream 发起 + window.events.grade_chunk 订阅
// 返回取消函数；启动失败（无事件/桥异常/ok=false）返回 null → 调用方回退非流式
// req_id 由调用方传入（= 当次流的 _gradeToken），后端按 req_id 回显事件 → 天然过滤旧流
function bridgeGradeStream(question, user_answer, level, essay_question, req_id, onChunk, onDone, onError) {
    if (typeof window.events === "undefined" || typeof window.events.grade_chunk !== "object"
        || typeof window.events.grade_chunk.addEventListener !== "function") return null;
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try { if (window.events.grade_chunk.removeEventListener) window.events.grade_chunk.removeEventListener(handler); } catch (e) {}
        try { window.pywebview.api.cancel_grade_stream(req_id); } catch (e) {}
    };
    const handler = (payload) => {
        if (!payload || payload.req_id !== req_id) return; // 丢弃旧流
        if (payload.kind === "done") {
            cleanup();
            if (payload.truncated) onError(new Error("流式截断"));
            else onDone(payload.full);
        } else if (payload.kind === "error") {
            cleanup();
            onError(new Error("流式失败"));
        } else {
            onChunk(payload);
        }
    };
    let r;
    try { r = window.pywebview.api.grade_answer_stream(question, user_answer, level, req_id, essay_question); }
    catch (e) { return null; }
    if (!r || !r.ok) return null;
    window.events.grade_chunk.addEventListener(handler);
    return cleanup;
}

// 批改完成收尾（流式 done / 非流式回退共用）：记录 + 渲染 + 错题 + 进度 + 复习调度
async function finalizeGradeFeedback(q, userAnswer, fb, btnSubmit, isEssay) {
    _clearReveal();  // done 收敛：停止打字机，交给 renderFeedback/renderEssayFeedback 整块渲染
    let recordQ = q;
    if (isEssay) {
        recordQ = {
            grammar_point: "综合作文",
            scene: AppState.essayQuestion.scene,
            chinese: AppState.essayQuestion.chinese,
            reference_answer: AppState.essayQuestion.reference_answer,
            is_extra: false,
            extra_level: null,
            difficulty: 4,
        };
    }
    AppState.records.push({
        question: recordQ,
        user_answer: userAnswer,
        feedback: fb,
        timestamp: new Date().toISOString(),
        ...(isEssay ? { is_essay: true } : {}),
    });
    AppState.totalAnswered++;

    if (isEssay) renderEssayFeedback(fb);
    else renderFeedback(fb);

    // 自动收录错题（与翻译/填空同标准：score<5 或核心错误标记）
    const collectQ = isEssay ? { ...recordQ, is_essay: true } : q;
    if (fb.score < 5 || (fb.error_parts && fb.error_parts.some(e => (e.level || "").includes("❌")))) {
        await collectWrongAnswer(collectQ, userAnswer, fb);
    }

    await saveProgress();

    // 作文不参与艾宾浩斯复习调度
    if (!isEssay) await saveImmediateReviewProgress(q, fb);

    if (btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = isEssay ? "提交作文" : "提交"; }
}

// 非流式回退：现有 grade 路径（自带 JSON 校验重试 + ```json 围栏提取），质量不降
async function fallbackGrade(q, userAnswer, btnSubmit, isEssay) {
    try {
        const url = isEssay ? "/api/grade_essay" : "/api/grade_answer";
        const body = isEssay
            ? { essay_question: AppState.essayQuestion, user_answer: userAnswer, level: AppState.config.level }
            : { question: q, user_answer: userAnswer, level: AppState.config.level, action: "grade" };
        const result = await api(url, { method: "POST", body: JSON.stringify(body) });
        if (!result.success || !result.feedback) throw new Error("批改失败，请重试");
        await finalizeGradeFeedback(q, userAnswer, result.feedback, btnSubmit, isEssay);
    } catch (err) {
        showToast(`批改失败：${err.message}`, "error");
        if (btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = isEssay ? "提交作文" : "提交"; }
    }
}

// 统一批改入口（翻译/作文共用；fill_blank 确定性判分不走流式）
async function submitGrade(q, userAnswer, isEssay) {
    const btnSubmit = $(isEssay ? "#btn-essay-submit" : "#btn-submit");
    if (btnSubmit) { btnSubmit.disabled = true; btnSubmit.textContent = "批改中..."; }

    // 取消旧流、重置增量状态（新流 token 使旧流事件全部失效）
    cancelGradeStream();
    const token = ++_gradeToken;
    const state = { score: "", grammar_used: null, correct: [], grammarCheck: [], errors: [], suggestions: "", extra: "", encouragement: "" };
    _streamState = state;

    // 流式态：骨架 + 动作区置空（防 done 前误点「下一题」）
    const area = $("#feedback-area");
    show(area);
    $("#feedback-card").innerHTML = `<div class="feedback-score"><div class="score-number score-low">…</div><div class="score-label">/ 10 分</div></div>`;
    $("#feedback-actions").innerHTML = "";

    const guardOnChunk = (p) => { if (token === _gradeToken) renderFeedbackStreamChunk(state, p); };
    const guardOnDone = (full) => { if (token === _gradeToken) finalizeGradeFeedback(q, userAnswer, full, btnSubmit, isEssay); };
    const guardOnError = () => { if (token === _gradeToken) fallbackGrade(q, userAnswer, btnSubmit, isEssay); };

    if (await _waitBridge()) {
        // 桥模式：特性缺失（无 grade_chunk 事件）→ 直接回退非流式
        if (!window.events || typeof window.events.grade_chunk !== "object") {
            return fallbackGrade(q, userAnswer, btnSubmit, isEssay);
        }
        const cleanup = bridgeGradeStream(q, userAnswer, AppState.config.level,
            isEssay ? AppState.essayQuestion : null, String(token), guardOnChunk, guardOnDone, guardOnError);
        if (!cleanup) return fallbackGrade(q, userAnswer, btnSubmit, isEssay);
        gradeStreamCleanup = cleanup;
        return;
    }
    // file:// 无桥 → 回退非流式（生产环境桥应可用，兜底保底）
    if (location.protocol === "file:") return fallbackGrade(q, userAnswer, btnSubmit, isEssay);
    // dev 浏览器：SSE
    const body = JSON.stringify(isEssay
        ? { essay_question: AppState.essayQuestion, user_answer: userAnswer, level: AppState.config.level, action: "grade" }
        : { question: q, user_answer: userAnswer, level: AppState.config.level, action: "grade" });
    gradeStreamCleanup = apiStream("/api/grade_answer/stream", body, guardOnChunk, guardOnDone, guardOnError);
}

// 增量渲染状态机：段落级事件先入打字机队列逐字显示（DeepSeek 观感），done 由 renderFeedback 整块收敛
function renderFeedbackStreamChunk(state, payload) {
    if (payload.kind === "score") state.score += payload.text;
    else if (payload.kind === "grammar_used") state.grammar_used = payload.text === "true";
    else if (payload.kind === "correct") _enqueueReveal({ kind: "correct", text: payload.text, _len: (payload.text || "").length });
    else if (payload.kind === "grammar_check") _enqueueReveal({ kind: "grammar_check", text: payload.text || "", _len: (payload.text || "").length });
    else if (payload.kind === "error") {
        const comp = _composeErrorText(payload);
        _enqueueReveal({ kind: "error", text: comp, error: payload, _len: comp.length });
    }
    else if (payload.kind === "suggest") _enqueueReveal({ kind: "suggest", text: payload.text || "", _len: (payload.text || "").length });
    else if (payload.kind === "extra") _enqueueReveal({ kind: "extra", text: payload.text || "", _len: (payload.text || "").length });
    else if (payload.kind === "encourage") _enqueueReveal({ kind: "encourage", text: payload.text || "", _len: (payload.text || "").length });
    else return;
    _renderStreamState();
}

// 渲染提交态 + 打字机当前段落的已揭示部分（打满后提交进 state 并从队列移除）
function _renderStreamState() {
    const state = _streamState;
    if (!state) return;

    const scoreNum = state.score || "…";
    const score = parseFloat(state.score) || 0;
    let scoreClass = "score-low";
    if (score >= 8) scoreClass = "score-high";
    else if (score >= 5) scoreClass = "score-mid";

    let html = `<div class="feedback-score">
        <div class="score-number ${scoreClass}">${scoreNum}</div>
        <div class="score-label">/ 10 分</div>
    </div>`;

    // 打字机当前段落已揭示部分（未打满前作为区块末尾展示）
    const typing = _revealQueue.length ? _revealQueue[0] : null;
    const tpart = typing ? typing.text.slice(0, typing._i) : null;

    // 作文：语法点运用（流式期逐字展示，done 后整块收敛）
    const gc = state.grammarCheck.slice();
    if (typing && typing.kind === "grammar_check" && tpart) gc.push(tpart);
    if (gc.length > 0) {
        html += `<div class="feedback-section"><div class="feedback-section-title">你运用到的语法点</div>`;
        gc.forEach(n => { html += `<div class="feedback-item good">${n}</div>`; });
        html += `</div>`;
    }

    // 偏题提示（grammar_point_used=false → 分数上限 5）
    if (state.grammar_used === false) {
        html += `<div class="feedback-item tip" style="text-align:center;color:var(--color-warning);margin-bottom:var(--space-sm)">
            本次回答偏题/未用上目标语法点，分数上限为 5 分
        </div>`;
    }

    const correct = state.correct.slice();
    if (typing && typing.kind === "correct" && tpart) correct.push(tpart);
    if (correct.length > 0) {
        html += `<div class="feedback-section"><div class="feedback-section-title feedback-correct">正确的地方</div>`;
        correct.forEach(p => { html += `<div class="feedback-item good">${p}</div>`; });
        html += `</div>`;
    }

    const errs = state.errors.slice();
    if (typing && typing.kind === "error" && tpart) errs.push({ _typing: tpart });
    if (errs.length > 0) {
        html += `<div class="feedback-section"><div class="feedback-section-title feedback-error">需要注意的地方</div>`;
        errs.forEach(e => {
            if (e._typing !== undefined) {
                // 打字中的错误条目：组合文本逐字展示（打满后收敛为结构化块）
                html += `<div class="feedback-item bad">${e._typing.split("\n").join("<br>")}</div>`;
            } else {
                const isWarning = (e.level || "").includes("⚠");
                const cls = isWarning ? "bad warning" : "bad";
                const lv = (e.level || "").replace(/[⚠️❌]/gu, "").trim();
                html += `<div class="feedback-item ${cls}">
                    <strong>${lv ? lv + "：" : "错误："}</strong>${e.error || ""}<br>
                    <strong>正确：</strong>${e.correction || ""}<br>
                    <strong>解释：</strong>${e.explanation || ""}
                </div>`;
            }
        });
        html += `</div>`;
    }

    let suggest = state.suggestions || "";
    if (typing && typing.kind === "suggest") suggest = tpart || "";
    if (suggest) {
        html += `<div class="feedback-section"><div class="feedback-section-title feedback-suggestion">更自然的说法</div>
            <div class="feedback-item tip">${suggest}</div></div>`;
    }

    let extra = state.extra || "";
    if (typing && typing.kind === "extra") extra = tpart || "";
    if (extra) {
        html += `<div class="feedback-section"><div class="feedback-section-title" style="color: var(--color-warning);">超纲内容拓展</div>
            <div class="feedback-item extra">${extra}</div></div>`;
    }

    let enc = state.encouragement || "";
    if (typing && typing.kind === "encourage") enc = tpart || "";
    if (enc) {
        html += `<div class="feedback-section" style="text-align: center; margin-top: var(--space-md);">
            <div class="encouragement-text">${enc}</div></div>`;
    }

    $("#feedback-card").innerHTML = html;
    $("#feedback-actions").innerHTML = "";  // 流式态动作区保持空，done 后重建
    const card = $("#feedback-card");
    if (card) card.scrollTop = card.scrollHeight;
}

// --- 屏幕管理 ---
function showScreen(name) {
    $$(".screen").forEach(s => hide(s));
    const screen = $(`#screen-${name}`);
    if (screen) show(screen);
    // 切页后回到顶部（各页面共用 document 滚动位置，不置顶会导致残留旧位置）
    window.scrollTo(0, 0);
}

function showLoading(text = "加载中...") {
    $("#loading-text").textContent = text;
    show($("#screen-loading"));
}

function hideLoading() {
    hide($("#screen-loading"));
}

// --- 简单 Markdown → HTML ---
function renderMarkdown(md) {
    if (!md) return "";
    let html = md
        // 标题
        .replace(/^### (.+)$/gm, "<h3>$1</h3>")
        .replace(/^## (.+)$/gm, "<h2>$1</h2>")
        .replace(/^# (.+)$/gm, "<h1>$1</h1>")
        // 粗体
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        // 代码块
        .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
        // 行内代码
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        // 水平线
        .replace(/^---$/gm, "<hr>")
        // 无序列表
        .replace(/^- (.+)$/gm, "<li>$1</li>")
        // 有序列表
        .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
        // 引用
        .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
        // 段落（连续非空行）
        .replace(/\n\n/g, "</p><p>")
        // 换行
        .replace(/\n/g, "<br>");

    html = "<p>" + html + "</p>";
    // 包裹连续的 li
    html = html.replace(/(<li>.*?<\/li>)+/g, "<ul>$&</ul>");
    // 清理空标签
    html = html.replace(/<p><\/p>/g, "");
    html = html.replace(/<p>(<h[123]>)<\/p>/g, "$1");
    html = html.replace(/(<\/h[123]>)<\/p>/g, "$1");
    html = html.replace(/<p>(<ul>)<\/p>/g, "$1");
    html = html.replace(/(<\/ul>)<\/p>/g, "$1");

    return html;
}

// --- 字符计数 ---
function updateCharCount() {
    const text = $("#notes-input").value;
    // Beta 6.0：笔记上限收紧至 5000 字（后端 MAX_NOTES_LENGTH 同步），建议一次一课
    $("#char-count").textContent = `${text.length} 字 · 最多 5000 字，建议一次粘贴一课的笔记`;
}

// --- M4.5 P3：自由笔记语法点 >12 事后提示（出题返回后展示，不拦截、零额外调用） ---
function showNotesFocusHint(count) {
    const el = $("#notes-focus-hint");
    if (!el) return;
    el.textContent = `笔记语法点较多（${count} 个），本次已聚焦最核心的 ${MAX_FOCUS_TAGS} 个，其余下次练习覆盖`;
    el.style.display = "";
}

function clearNotesFocusHint() {
    const el = $("#notes-focus-hint");
    if (el) { el.style.display = "none"; el.textContent = ""; }
}

function updateVocabCharCount() {
    const text = $("#vocab-input").value;
    // Beta 6.0：词源文本上限收紧至 2000 字（后端 MAX_VOCAB_LENGTH 同步）；更大量请走「从词书选词」
    $("#vocab-char-count").textContent = `已输入 ${text.split('\n').filter(l => l.trim()).length} 个单词 · 最多 2000 字，大量词汇请用「从词书选词」`;
}

// --- 配置管理 ---
async function loadConfig() {
    try {
        const data = await api("/api/config");
        AppState.config = data;
        return data;
    } catch {
        return null;
    }
}

async function saveConfig(config) {
    await api("/api/config", {
        method: "POST",
        body: JSON.stringify(config),
    });
    AppState.config = { ...AppState.config, ...config };
}

// ============================================================
// 屏幕 -1：使用指南
// ============================================================
async function initGuideScreen() {
    // 首页始终是启动默认页（Beta 6.0）；是否已有 Key 由「开始使用」按钮按需分流
    await loadConfig();
    showScreen("guide");
    setDockActive("guide");

    // 开始使用 → 如果已有 Key 直接进练习，否则进入设置页
    $("#btn-guide-start").onclick = async () => {
        const data = await loadConfig();
        if (data && data.has_api_key) {
            initMainScreen();
        } else {
            initSetupScreen();
        }
    };
}

// ============================================================
// 屏幕 1：API Key 设置
// ============================================================
async function initSetupScreen() {
    const data = await loadConfig();
    if (data && data.has_api_key) {
        // 已有 API Key，跳过设置页
        initMainScreen();
        return;
    }

    showScreen("setup");
    setDockActive("settings");
    $("#api-key-input").value = "";
    $("#setup-error").style.display = "none";

    $("#btn-save-key").onclick = async () => {
        const key = $("#api-key-input").value.trim();
        if (!key) {
            showError("setup-error", "请输入 API Key");
            return;
        }
        const btn = $("#btn-save-key");
        btn.disabled = true;
        btn.textContent = "验证中...";
        try {
            // 多模型支持：默认验证并保存到 DeepSeek
            const v = await api("/api/validate_key", {
                method: "POST",
                body: JSON.stringify({ provider: "deepseek", api_key: key }),
            });
            if (!v.valid) {
                showError("setup-error", v.error || "API Key 验证失败");
                return;
            }
            await saveConfig({ api_key: key });
            initMainScreen();
        } catch (err) {
            showError("setup-error", err.message || "保存失败，请检查网络连接");
        } finally {
            btn.disabled = false;
            btn.textContent = "保存并进入";
        }
    };

    $("#btn-skip-setup").onclick = () => {
        initMainScreen();
    };

    // 回车提交
    $("#api-key-input").onkeydown = (e) => {
        if (e.key === "Enter") $("#btn-save-key").click();
    };
}

function showError(id, msg) {
    const el = $(`#${id}`);
    // 内联错误统一带「导出日志反馈」引导（Beta 7.0 修缮 #3）：报错时可一键导出日志
    el.innerHTML = "";
    const txt = document.createElement("span");
    txt.textContent = msg;
    el.appendChild(txt);
    const logLink = document.createElement("a");
    logLink.href = "javascript:void(0)";
    logLink.textContent = "导出日志反馈";
    logLink.style.cssText = "margin-left:8px;text-decoration:underline;font-weight:600;cursor:pointer";
    logLink.onclick = () => downloadFile("/api/logs/export").then(() => showToast("日志已导出，欢迎反馈给开发者")).catch((e) => showToast(e.message || "日志导出失败", "error"));
    el.appendChild(logLink);
    show(el);
}

// ============================================================
// 屏幕 2：主页（级别选择 + 笔记输入）
// ============================================================
async function initMainScreen() {
    hideLoading();

    // 检查是否有未完成进度
    try {
        const progress = await api("/api/progress");
        if (progress.has_progress && progress.data) {
            showResumeModal(progress.data);
            return;
        }
    } catch {
        // 忽略错误，继续正常流程
    }

    showMainScreen();
}

function showMainScreen() {
    showScreen("main");
    setDockActive("main");

    // 加载教材列表
    loadTextbookOptions();

    // 检查今日复习
    loadReviewStatus();

    // 加载顶部打卡 chip
    loadCheckinMini();

    // 设置默认级别
    const level = AppState.config.level || "N3";
    _manualLevel = level;
    $$(".level-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.level === level);
    });

    // 恢复笔记内容
    if (AppState.notes) {
        $("#notes-input").value = AppState.notes;
        updateCharCount();
    }

    // 恢复单词内容
    if (AppState.vocabulary) {
        $("#vocab-input").value = AppState.vocabulary;
        updateVocabCharCount();
    }

    // 级别选择
    $$(".level-btn").forEach(btn => {
        btn.onclick = () => {
            $$(".level-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            AppState.config.level = btn.dataset.level;
            _manualLevel = btn.dataset.level;   // B3：记录用户手动选择，chips 全取消时回退
        };
    });
    // 目标级别卡片：自由模式才显示（选知识点时自动设为所选级别并隐藏）
    updateTargetLevelCard();

    // 题型选择（M4）
    const qtype = AppState.questionType || "translation";
    $$(".qtype-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.qtype === qtype);
        btn.onclick = () => {
            $$(".qtype-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            AppState.questionType = btn.dataset.qtype;
        };
    });

    // 字数统计（笔记编辑同时清除 >12 聚焦提示——M4.5 清除时机之一）
    $("#notes-input").oninput = () => { clearNotesFocusHint(); updateCharCount(); };
    $("#vocab-input").oninput = updateVocabCharCount;

    // 出题词源三态（Beta 5.0）
    const srcSelect = $("#vocab-source-select");
    if (srcSelect) srcSelect.onchange = onVocabSourceChange;
    const pickBtn = $("#btn-vocab-pick");
    if (pickBtn) pickBtn.onclick = openVocabPickModal;
    onVocabSourceChange();

    // 开始训练
    $("#btn-start").onclick = startTraining;
}

// ============================================================
// 统一出题函数（Beta 6.0 §3.1 契约表）
// 练习页手输 / 选知识点 / 答疑→去练习 三个入口共用同一段收集与请求逻辑；
// 各入口只负责把自身状态归一到参数上。契约由代码结构保证而非纪律。
// 失败时抛出错误，由入口自行决定提示方式（练习页 showError / 答疑 alert）。
// ============================================================
async function beginPractice({ notes = "", focusTags = [], vocabText = "", practiceWords = [], sessionNotes = "", request = null }) {
    const startBtn = $("#btn-start");
    if (startBtn) startBtn.disabled = true;   // B7：生成期间禁用开始按钮，防双击双请求
    showLoading("正在生成题目...");
    hide($("#main-error"));
    loadLearnedMap();  // 预热复习点识别缓存（PRD §2.6）

    try {
        // request（Beta 7.0 M3）：精读「练这些」走 /api/reading/practice 专用端点，
        // 自带完整请求体；练习页入口不传 request，仍走统一出题端点
        const result = await api(request ? request.url : "/api/generate_questions", {
            method: "POST",
            body: JSON.stringify(request ? request.body : {
                notes,
                level: AppState.config.level,
                vocabulary: vocabText,
                practice_words: practiceWords,   // 值拷贝快照语义（B5）：选词后删除词书，本次会话仍用已选旧词
                question_type: AppState.questionType,
                focus_tags: focusTags,
                mix_review: !!(AppState.config && AppState.config.practice_mix_review),
            }),
        });

        if (!result.success || !result.data) {
            throw new Error("出题失败，请重试");
        }

        const questions = result.data.questions || [];
        if (questions.length === 0) {
            throw new Error(notes ? "未能从笔记中提取到语法点，请检查笔记内容" : "未能生成题目，请重试");
        }

        // M4.5 P3：自由笔记 >12 点事后提示（出题返回才知道点数，不做事前预检）
        const _found = result.data.grammar_points_found;
        if (Array.isArray(_found) && _found.length > MAX_FOCUS_TAGS) {
            showNotesFocusHint(_found.length);
            showToast(`笔记语法点较多（${_found.length} 个），本次已聚焦最核心的 ${MAX_FOCUS_TAGS} 个`, "info");  // 首页小字在答题页看不到，toast 当场提醒
        } else {
            clearNotesFocusHint();
        }

        // notes 只承载用户手输内容——联动入口传空即不污染（B1）
        AppState.notes = notes;
        AppState.sessionNotes = sessionNotes;
        AppState.vocabulary = vocabText;
        AppState.questions = questions;
        AppState.vocabUsed = result.data.vocab_used || [];
        AppState.currentIndex = 0;
        AppState.records = [];
        AppState.totalAnswered = 0;
        AppState.baseTotal = questions.length;
        AppState.isBankPractice = !!result.data.source;

        // 保存初始进度
        await saveProgress();
        initQuizScreen();
    } finally {
        hideLoading();
        if (startBtn) startBtn.disabled = false;  // 失败时恢复按钮，留在原页可重试
    }
}

async function startTraining() {
    if (AppState.questionType === "bank") {
        clearNotesFocusHint();
        try {
            await beginPractice({
                notes: "",
                sessionNotes: "用户题库练习",
                request: { url: "/api/question_bank/generate", body: { count: 10 } },
            });
        } catch (err) {
            showError("main-error", err.message);
        }
        return;
    }
    const notes = $("#notes-input").value.trim();
    const focusTags = (AppState.selectedGrammarPoints || []).map(g => g.point);
    if (!notes && focusTags.length === 0) {
        showError("main-error", "请先粘贴语法笔记，或选择语法点范围");
        return;
    }
    clearNotesFocusHint();   // M4.5：重新出题时清除上一轮 >12 聚焦提示

    // 出题词源三态：off=不启用 / input=输入单词 / book=从词书选词（仅本次会话生效）
    const vocabSource = $("#vocab-source-select").value;
    let vocabText = "";
    let practiceWords = [];
    if (vocabSource === "input") {
        vocabText = $("#vocab-input").value.trim();
    } else if (vocabSource === "book") {
        // B5：practiceVocabWords 是选词确认时的值拷贝快照；之后删除词书，
        // 本次会话仍按快照出题（合理行为，不做联动失效）
        practiceWords = practiceVocabWords || [];
    }

    try {
        await beginPractice({ notes, focusTags, vocabText, practiceWords, sessionNotes: "" });
    } catch (err) {
        showError("main-error", err.message);
    }
}

// ============================================================
// 屏幕 3：答题界面
// ============================================================
function initQuizScreen() {
    showScreen("quiz");
    $("#feedback-area").style.display = "none";
    AppState.essayQuestion = null;  // 清空残留作文题，防止答疑/新练习误走作文判分
    renderCurrentQuestion();
}

function getCurrentQuestion() {
    // 如果 currentIndex 超出原始题目范围，说明当前是加练/换题的新题
    if (AppState.currentIndex < AppState.questions.length) {
        return AppState.questions[AppState.currentIndex];
    }
    // 从 records 中获取最后一道题的 question（加练/换题场景）
    if (AppState.records.length > 0) {
        return AppState.records[AppState.records.length - 1].question;
    }
    return null;
}

function renderCurrentQuestion() {
    const q = getCurrentQuestion();
    if (!q) return;

    // 步骤圆点
    const steps = $("#quiz-steps");
    if (steps && AppState.baseTotal > 0) {
        let dots = "";
        for (let i = 0; i < AppState.baseTotal; i++) {
            let cls = "quiz-step-dot";
            if (i < AppState.currentIndex) cls += " done";
            if (i === AppState.currentIndex) cls += " current";
            dots += `<span class="${cls}"></span>`;
        }
        steps.innerHTML = dots;
    }

    // 累计得分
    const totalScore = AppState.records.reduce((sum, r) => {
        return sum + (r.feedback?.score || 0);
    }, 0);
    const avgScore = AppState.records.length > 0
        ? (totalScore / AppState.records.length).toFixed(1)
        : "--";
    $("#progress-score").textContent = AppState.records.length > 0
        ? `均分 ${avgScore} | 已答 ${AppState.records.length}`
        : "";

    // 超纲标签
    if (q.is_extra) {
        show($("#badge-extra"));
        $("#badge-extra").textContent = `拓展（${q.extra_level || "超纲"}）`;
    } else {
        hide($("#badge-extra"));
    }

    // 难度标签
    if (q.difficulty >= 2) {
        show($("#badge-difficulty"));
        const flames = '<i data-lucide="flame" style="width:12px;height:12px;vertical-align:-1px;margin-right:1px"></i>'.repeat(Math.min(q.difficulty, 3));
        $("#badge-difficulty").innerHTML = `${flames} Lv${q.difficulty}`;
        refreshIcons();
    } else {
        hide($("#badge-difficulty"));
    }

    // 语法点
    $("#grammar-tag").textContent = q.grammar_point || "";

    // --- 题型分支（M4）---
    if (q.question_type === "fill_blank") {
        renderFillBlankQuestion(q);
        return;
    }

    // 复位为普通输入模式（防止作文/填空模式残留到普通练习题，M7 bug 修复）
    show($("#answer-area-normal"));
    hide($("#answer-area-essay"));
    hide($("#answer-area-fillblank"));

    // 场景
    $("#quiz-scene").textContent = q.scene || "";

    // 隐藏作文专属的表达方式
    hide($("#quiz-format"));

    // 中文
    $("#quiz-chinese").textContent = q.chinese || "";

    // 词汇提示
    if (q.hints && q.hints.length > 0) {
        show($("#quiz-hints"));
        $("#hints-content").innerHTML = q.hints
            .map(h => `<span class="hint-item">${h}</span>`)
            .join("");
        $("#hints-content").style.display = "none";
    } else {
        hide($("#quiz-hints"));
    }

    // 清空输入
    $("#answer-input").value = "";
    $("#answer-input").focus();

    // 关闭反馈面板
    const fbPanel = $("#feedback-area"); if (fbPanel) fbPanel.style.display = "none";

    // 提示收起
    $("#hints-toggle").onclick = () => {
        const content = $("#hints-content");
        const toggle = $("#hints-toggle");
        if (content.style.display === "none") {
            show(content);
            toggle.classList.add("open");
        } else {
            hide(content);
            toggle.classList.remove("open");
        }
    };

    // 给新渲染的卡片加发光
    if (typeof initBorderGlowCards === 'function') {
        setTimeout(initBorderGlowCards, 100);
    }
}

// --- 填空选择题渲染（M4）---
function renderFillBlankQuestion(q) {
    // 显示 stem 含高亮空白的句子
    $("#quiz-chinese").innerHTML = (q.stem || "").replace(
        /([＿_]+)/g,
        '<span class="fillblank-blank">$1</span>'
    );
    $("#quiz-scene").textContent = q.scene || "";

    // 隐藏翻译题输入区，显示选择题区
    hide($("#answer-area-normal"));
    hide($("#answer-area-essay"));
    show($("#answer-area-fillblank"));

    // 渲染 4 个选项按钮
    const options = q.options || [];
    const letters = ["A", "B", "C", "D"];
    AppState.fillblankSelected = null;
    AppState.fillblankLocked = false;                       // 新题解锁（重答/换题后允许重新作答）
    $("#fillblank-options").classList.remove("locked");
    $("#fillblank-options").innerHTML = options.map((opt, i) => `
        <div class="fillblank-option" data-index="${i}">
            <span class="fillblank-option-letter">${letters[i]}</span>
            <span class="fillblank-option-text">${escapeHtml(opt)}</span>
        </div>
    `).join("");

    // 选项点击处理
    const submitBtn = $("#btn-fillblank-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "请选择答案";
    $$("#fillblank-options .fillblank-option").forEach(el => {
        el.onclick = () => {
            if (AppState.fillblankLocked) return;           // 答案已揭晓 → 禁止再改选
            $$("#fillblank-options .fillblank-option").forEach(e => e.classList.remove("selected"));
            el.classList.add("selected");
            AppState.fillblankSelected = parseInt(el.dataset.index);
            submitBtn.disabled = false;
            submitBtn.textContent = "确认选择";
        };
    });

    // 提交按钮
    submitBtn.onclick = submitFillBlankAnswer;

    // 隐藏反馈
    const fbPanel = $("#feedback-area"); if (fbPanel) fbPanel.style.display = "none";
    hide($("#badge-extra"));
    hide($("#badge-difficulty"));

    // 提示处理
    if (q.hints && q.hints.length > 0) {
        show($("#quiz-hints"));
        $("#hints-content").innerHTML = q.hints.map(h => `<span class="hint-item">${h}</span>`).join("");
        hide($("#hints-content"));
    } else {
        hide($("#quiz-hints"));
    }
    $("#hints-toggle").onclick = () => {
        const content = $("#hints-content");
        const toggle = $("#hints-toggle");
        if (content.style.display === "none") {
            show(content);
            toggle.classList.add("open");
        } else {
            hide(content);
            toggle.classList.remove("open");
        }
    };
}

// --- 填空选择题提交（M4）---
async function submitFillBlankAnswer() {
    if (AppState.fillblankSelected === null) return;
    const q = getCurrentQuestion();
    if (!q) return;

    const btn = $("#btn-fillblank-submit");
    btn.disabled = true;
    btn.textContent = "批改中...";

    try {
        const result = await api("/api/grade_answer", {
            method: "POST",
            body: JSON.stringify({
                question: q,
                user_answer: String(AppState.fillblankSelected),
                level: AppState.config.level,
                action: "grade",
            }),
        });
        if (!result.success || !result.feedback) throw new Error("批改失败，请重试");

        // 答案已揭晓：锁定选项，禁止再改选（M8.x bug 修复）
        AppState.fillblankLocked = true;
        $("#fillblank-options").classList.add("locked");
        btn.disabled = true;
        btn.textContent = "已作答 ✓";

        AppState.records.push({
            question: q,
            user_answer: String(AppState.fillblankSelected),
            feedback: result.feedback,
            timestamp: new Date().toISOString(),
        });
        AppState.totalAnswered++;

        // 高亮正确/错误选项
        const fb = result.feedback;
        const correctIdx = fb.correct_option;
        const selectedIdx = fb.selected_option;
        $$("#fillblank-options .fillblank-option").forEach(el => {
            const idx = parseInt(el.dataset.index);
            if (idx === correctIdx) el.classList.add("fillblank-correct");
            if (idx === selectedIdx && idx !== correctIdx) el.classList.add("fillblank-wrong");
        });

        renderFeedback(result.feedback, { fillBlank: true, q, selectedIdx: String(AppState.fillblankSelected) });

        // 自动收录错题
        if (fb.score < 5 || (fb.error_parts && fb.error_parts.some(e => (e.level || "").includes("❌")))) {
            await collectWrongAnswer(q, String(AppState.fillblankSelected), fb);
        }

        await saveProgress();

        // 答过复习点 → 立即更新艾宾浩斯调度（PRD §2.6）
        await saveImmediateReviewProgress(q, fb);
    } catch (err) {
        showToast(`批改失败：${err.message}`, "error");
        btn.disabled = false;
        btn.textContent = "确认选择";
    }
}

// --- 选择题 AI 讲解（M8.x）---
async function explainFillBlankAnswer(q, selectedIdx) {
    const btn = $("#btn-fillblank-explain");
    if (btn) { btn.disabled = true; btn.textContent = "讲解中..."; }
    try {
        const result = await api("/api/grade_answer/explain", {
            method: "POST",
            body: JSON.stringify({ question: q, user_answer: selectedIdx, level: AppState.config.level }),
        });
        if (!result.success) throw new Error(result.error || "讲解失败，请重试");
        const card = $("#feedback-card");
        if (!card) return;
        const old = $("#fillblank-explain-box");
        if (old) old.remove();
        const div = document.createElement("div");
        div.id = "fillblank-explain-box";
        div.innerHTML = buildFillBlankExplainHtml(result.explanation || {});
        card.appendChild(div);
        div.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
        showToast(`讲解失败：${err.message}`, "error");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "AI 讲解本题"; }
    }
}

function buildFillBlankExplainHtml(exp) {
    const correct = exp.correct_explanation || "";
    const wrong = exp.wrong_explanation || "";
    const distractors = exp.distractors || [];
    let html = `<div class="feedback-section" style="margin-top: var(--space-sm); border-top: 1px dashed var(--border-light); padding-top: var(--space-md);">
        <div class="feedback-section-title" style="color: var(--color-primary);">AI 讲解本题</div>`;
    if (correct) html += `<div class="feedback-item good"><strong>为什么选它：</strong>${correct}</div>`;
    if (wrong) html += `<div class="feedback-item bad"><strong>为什么不是你选的：</strong>${wrong}</div>`;
    if (distractors.length) {
        html += `<div class="feedback-section-title" style="margin-top: var(--space-sm);">其他选项</div>`;
        distractors.forEach(d => {
            const label = d.label || "";
            html += `<div class="feedback-item tip"><strong>${escapeHtml(label)}.</strong> ${d.reason || ""}</div>`;
        });
    }
    html += `</div>`;
    return html;
}

// 提交答案（流式优先；流式失败/超时回退非流式，质量不降）
async function submitAnswer() {
    const userAnswer = $("#answer-input").value.trim();
    if (!userAnswer) return;

    const q = getCurrentQuestion();
    if (!q) return;

    await submitGrade(q, userAnswer, false);
}

function renderFeedback(fb, opts = {}) {
    const area = $("#feedback-area");
    show(area);

    const isFillBlank = !!opts.fillBlank;

    // 得分颜色（选择题没有"分"的概念：只显示对错，不显示分数）
    const score = fb.score || 0;
    let scoreClass = "score-low";
    if (score >= 8) scoreClass = "score-high";
    else if (score >= 5) scoreClass = "score-mid";

    let html;
    if (isFillBlank) {
        const ok = !!fb.is_correct;
        html = `
            <div class="feedback-score">
                <div class="score-number ${ok ? "score-high" : "score-low"}">${ok ? "✓" : "✗"}</div>
                <div class="score-label">${ok ? "回答正确" : "回答错误"}</div>
            </div>
        `;
    } else {
        html = `
            <div class="feedback-score">
                <div class="score-number ${scoreClass}">${score.toFixed(1)}</div>
                <div class="score-label">/ 10 分</div>
            </div>
        `;
    }

    // 功能6：grammar_point_used=false → 偏题提示（分数已被上限压到 5）
    if (fb.grammar_point_used === false) {
        html += `<div class="feedback-item tip" style="text-align:center;color:var(--color-warning);margin-bottom:var(--space-sm)">
            本次回答偏题/未用上目标语法点，分数上限为 5 分
        </div>`;
    }

    // 正确部分
    if (fb.correct_parts && fb.correct_parts.length > 0) {
        html += `<div class="feedback-section">
            <div class="feedback-section-title feedback-correct">正确的地方</div>`;
        fb.correct_parts.forEach(p => {
            html += `<div class="feedback-item good">${p}</div>`;
        });
        html += `</div>`;
    }

    // 错误部分（区分小问题与核心错误）
    if (fb.error_parts && fb.error_parts.length > 0) {
        html += `<div class="feedback-section">
            <div class="feedback-section-title feedback-error">需要注意的地方</div>`;
        fb.error_parts.forEach(e => {
            const level = e.level || "❌";
            const isWarning = level.includes("⚠");
            const cls = isWarning ? "bad warning" : "bad";
            const lv = level.replace(/[⚠️❌]/gu, "").trim();
            html += `<div class="feedback-item ${cls}">
                <strong>${lv ? lv + "：" : "错误："}</strong>${e.error || ""}<br>
                <strong>正确：</strong>${e.correction || ""}<br>
                <strong>解释：</strong>${e.explanation || ""}
            </div>`;
        });
        html += `</div>`;
    }

    // 修改建议
    if (fb.suggestions) {
        html += `<div class="feedback-section">
            <div class="feedback-section-title feedback-suggestion">更自然的说法</div>
            <div class="feedback-item tip">${fb.suggestions}</div>
        </div>`;
    }

    // 超纲说明
    if (fb.extra_notes) {
        html += `<div class="feedback-section">
            <div class="feedback-section-title" style="color: var(--color-warning);">超纲内容拓展</div>
            <div class="feedback-item extra">${fb.extra_notes}</div>
        </div>`;
    }

    // 鼓励收尾
    if (fb.encouragement) {
        html += `<div class="feedback-section" style="text-align: center; margin-top: var(--space-md);">
            <div class="encouragement-text">${fb.encouragement}</div>
        </div>`;
    }

    $("#feedback-card").innerHTML = html;

    // 操作按钮（选择题：无 emoji、AI 讲解在下一题之前、下一题与其他按钮同款式）
    const isGood = score >= 8;
    let actionHtml = "";
    if (isFillBlank) {
        if (fb.is_correct) {
            actionHtml = `
                <button class="btn btn-primary" id="btn-harder">加大难度</button>
                <button class="btn btn-secondary" id="btn-retry-same">修改重答</button>
                <button class="btn btn-secondary" id="btn-next">下一题</button>
            `;
        } else {
            actionHtml = `
                <button class="btn btn-primary" id="btn-retry" style="background: var(--color-warning); color: white;">换道同类题再练</button>
                <button class="btn btn-secondary" id="btn-retry-same">修改重答</button>
                <button class="btn btn-secondary" id="btn-fillblank-explain">AI 讲解本题</button>
                <button class="btn btn-secondary" id="btn-next">下一题</button>
            `;
        }
    } else if (isGood) {
        actionHtml = `
            <button class="btn btn-primary" id="btn-harder">加大难度</button>
            <button class="btn btn-secondary" id="btn-retry-same">修改重答</button>
            <button class="btn btn-text" id="btn-next">下一题</button>
        `;
    } else {
        actionHtml = `
            <button class="btn btn-primary" id="btn-retry" style="background: var(--color-warning); color: white;">换道同类题再练</button>
            <button class="btn btn-secondary" id="btn-retry-same">修改重答</button>
            <button class="btn btn-text" id="btn-skip">跳过</button>
        `;
    }
    $("#feedback-actions").innerHTML = actionHtml;

    // 绑定事件
    if (isFillBlank) {
        if (fb.is_correct) {
            $("#btn-harder").onclick = () => handleAction("harder");
            $("#btn-retry-same").onclick = () => retrySameQuestion();
            $("#btn-next").onclick = () => moveToNext();
        } else {
            $("#btn-retry").onclick = () => handleAction("retry");
            $("#btn-retry-same").onclick = () => retrySameQuestion();
            $("#btn-fillblank-explain").onclick = () => explainFillBlankAnswer(opts.q, opts.selectedIdx);
            $("#btn-next").onclick = () => moveToNext();
        }
    } else if (isGood) {
        $("#btn-harder").onclick = () => handleAction("harder");
        $("#btn-retry-same").onclick = () => retrySameQuestion();
        $("#btn-next").onclick = () => moveToNext();
    } else {
        $("#btn-retry").onclick = () => handleAction("retry");
        $("#btn-retry-same").onclick = () => retrySameQuestion();
        $("#btn-skip").onclick = () => moveToNext();
    }

    // 显示反馈
    area.style.display = "";
    area.style.animation = "none";
    area.offsetHeight; // reflow
    area.style.animation = "feedbackReveal 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)";
    refreshIcons();
}

async function handleAction(action) {
    cancelGradeStream();  // 换题/加难 → 取消可能活跃的流式批改
    const btnPrimary = $("#feedback-actions").querySelector(".btn-primary");
    btnPrimary.disabled = true;
    btnPrimary.textContent = action === "harder" ? "生成中..." : "换题中...";

    const q = getCurrentQuestion();
    const isFillBlank = q && q.question_type === "fill_blank";  // 选择题按钮不带 emoji

    try {
        const result = await api("/api/grade_answer", {
            method: "POST",
            body: JSON.stringify({
                question: q,
                user_answer: "",  // 不需要再批改
                level: AppState.config.level,
                action: action,
            }),
        });

        if (!result.success) {
            throw new Error("操作失败");
        }

        if (result.new_question) {
            // 把新题插入当前位置之后，并前进到新题
            AppState.questions.splice(AppState.currentIndex + 1, 0, result.new_question);
            AppState.currentIndex++;
            AppState.baseTotal++;

            const fb = $("#feedback-area"); if (fb) fb.style.display = "none";
            renderCurrentQuestion();
        }
    } catch (err) {
        showToast(`操作失败：${err.message}`, "error");
    } finally {
        btnPrimary.disabled = false;
        if (isFillBlank) {
            btnPrimary.textContent = action === "harder" ? "加大难度" : "换道同类题再练";
        } else {
            btnPrimary.textContent = action === "harder" ? "加大难度" : "换道同类题再练";
        }
    }
}

function retrySameQuestion() {
    const fb = $("#feedback-area"); if (fb) fb.style.display = "none";
    $("#answer-input").value = "";
    $("#answer-input").focus();

    // 填空题重答：解锁选项，清掉对错高亮，恢复可作答状态
    const options = $("#fillblank-options");
    if (options) {
        AppState.fillblankSelected = null;
        AppState.fillblankLocked = false;
        options.classList.remove("locked");
        $$(".fillblank-option").forEach(el =>
            el.classList.remove("selected", "fillblank-correct", "fillblank-wrong")
        );
        const submitBtn = $("#btn-fillblank-submit");
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = "请选择答案";
        }
    }
    const explainBox = $("#fillblank-explain-box");
    if (explainBox) explainBox.remove();
}

function moveToNext() {
    cancelGradeStream();  // 进入下一题 取消可能活跃的流式批改
    AppState.currentIndex++;

    const fb = $("#feedback-area"); if (fb) fb.style.display = "none";

    // 重置答题区（M4：所有题型回到默认状态）
    show($("#answer-area-normal"));
    hide($("#answer-area-essay"));
    hide($("#answer-area-fillblank"));
    $("#answer-input").value = "";
    AppState.fillblankSelected = null;

    const baseCompleted = AppState.currentIndex >= AppState.baseTotal;
    const allCompleted = AppState.currentIndex >= AppState.questions.length;

    if (baseCompleted || allCompleted) {
        if (AppState.isBankPractice) {
            generateSummary();
            return;
        }
        showEssayPromptModal();  // 进入作文前先询问，可跳过（需求5）
    } else {
        renderCurrentQuestion();
    }
}

// 进入作文题前询问（可跳过）：答完全部题目后先弹窗，用户选「挑战作文」或「直接看总结」
function showEssayPromptModal() {
    const modal = $("#modal-essay-skip");
    if (!modal) { startEssay(); return; }  // 兜底：弹窗缺失时直接进作文
    show(modal);
    refreshIcons();
    const goBtn = $("#btn-essay-go");
    if (goBtn) goBtn.onclick = () => { hide(modal); startEssay(); };
    const skipBtn = $("#btn-essay-skip");
    if (skipBtn) skipBtn.onclick = () => { hide(modal); generateSummary(); };
}

// --- 进度保存 ---
async function saveProgress() {
    try {
        await api("/api/progress", {
            method: "POST",
            body: JSON.stringify({
                notes: AppState.notes,
                session_notes: AppState.sessionNotes || "",
                vocabulary: AppState.vocabulary,
                vocab_used: AppState.vocabUsed,
                level: AppState.config.level,
                questions: AppState.questions,
                current_index: AppState.currentIndex,
                records: AppState.records,
                total_answered: AppState.totalAnswered,
                base_total: AppState.baseTotal,
            }),
        });
    } catch {
        // 静默失败，不影响主流程
    }
}

// --- 恢复进度弹窗 ---
function showResumeModal(progress) {
    showScreen("main"); // 先显示主页作为背景
    show($("#modal-resume"));

    const qCount = progress.questions?.length || 0;
    const answered = progress.records?.length || 0;
    const level = progress.level || "N4";
    $("#resume-info").textContent = `上次在 ${level} 级别练习中完成了 ${answered}/${qCount} 题，是否继续？`;

    $("#btn-resume-yes").onclick = async () => {
        hide($("#modal-resume"));
        AppState.notes = progress.notes || "";
        AppState.sessionNotes = progress.session_notes || "";
        AppState.vocabulary = progress.vocabulary || "";
        AppState.vocabUsed = progress.vocab_used || [];
        AppState.questions = progress.questions || [];
        AppState.currentIndex = progress.current_index || 0;
        AppState.records = progress.records || [];
        AppState.totalAnswered = progress.total_answered || 0;
        AppState.baseTotal = progress.base_total || AppState.questions.length;
        AppState.config.level = progress.level || AppState.config.level;
        // Beta 6.0（B8）：批量复习的会话状态不持久化。跨重启恢复到复习会话时
        //（sessionNotes 带「复习：」前缀）降级为普通浏览——隐藏「继续复习下一批」，
        // 不尝试恢复 reviewInBatchMode，避免按钮行为异常。
        if ((AppState.sessionNotes || "").startsWith("复习：")) {
            AppState.reviewInBatchMode = false;
            AppState.remainingReviewPoints = [];
            AppState.selectedReviewPoints = [];
        }
        initQuizScreen();
    };

    $("#btn-resume-no").onclick = async () => {
        hide($("#modal-resume"));
        // 清除进度
        try { await api("/api/progress", { method: "DELETE" }); } catch {}
        AppState.records = [];
        AppState.questions = [];
        AppState.currentIndex = 0;
        showMainScreen();
    };
}

// ============================================================
// 屏幕 4：总结
// ============================================================
// ============================================================
// 终极挑战：综合短文翻译
// ============================================================
async function startEssay() {
    showLoading("正在生成终极挑战作文题...");

    // 收集所有涉及的语法点
    const grammarPoints = [];
    const seen = new Set();
    for (const r of AppState.records) {
        const gp = r.question?.grammar_point;
        if (gp && !seen.has(gp)) {
            seen.add(gp);
            grammarPoints.push(gp);
        }
    }
    // 也从未答到的题目中收集
    for (const q of AppState.questions) {
        const gp = q.grammar_point;
        if (gp && !seen.has(gp)) {
            seen.add(gp);
            grammarPoints.push(gp);
        }
    }

    try {
        const result = await api("/api/generate_essay", {
            method: "POST",
            body: JSON.stringify({
                grammar_points: grammarPoints,
                level: AppState.config.level,
                notes: AppState.notes,
            }),
        });

        if (!result.success || !result.data) {
            throw new Error("作文题生成失败");
        }

        AppState.essayQuestion = result.data;
        hideLoading();
        renderEssayQuestion(result.data);
    } catch (err) {
        hideLoading();
        // 如果作文题生成失败，直接跳到总结
        showToast(`作文题生成失败，跳过：${err.message}`, "error");
        generateSummary();
    }
}

function renderEssayQuestion(essay) {
    showScreen("quiz");

    // 切换为作文模式
    const steps = $("#quiz-steps");
    if (steps) steps.innerHTML = '<span class="quiz-step-dot current" style="width:14px;height:14px;box-shadow:0 0 0 4px rgba(240,0,0,0.18)"></span>';
    $("#progress-score").textContent = `覆盖 ${essay.grammar_points_covered?.length || 0} 个语法点`;

    hide($("#badge-extra"));
    hide($("#badge-difficulty"));
    $("#grammar-tag").textContent = "综合作文";

    // 场景
    $("#quiz-scene").textContent = essay.scene || "";

    // 表达方式（作文独有）
    if (essay.format) {
        show($("#quiz-format"));
        $("#quiz-format").textContent = essay.format;
    } else {
        hide($("#quiz-format"));
    }

    // 要写的内容（纯内容，不含框架）
    $("#quiz-chinese").textContent = essay.chinese || "";

    // 词汇提示
    if (essay.hints && essay.hints.length > 0) {
        show($("#quiz-hints"));
        $("#hints-content").innerHTML = essay.hints
            .map(h => `<span class="hint-item">${h}</span>`)
            .join("");
        $("#hints-content").style.display = "none";
    } else {
        hide($("#quiz-hints"));
    }

    // 切换输入区域：隐藏单行，显示多行
    hide($("#answer-area-normal"));
    show($("#answer-area-essay"));
    $("#essay-input").value = "";
    $("#essay-input").focus();

    // 关闭反馈面板
    const fbPanel = $("#feedback-area"); if (fbPanel) fbPanel.style.display = "none";

    // 提交按钮事件
    $("#btn-essay-submit").onclick = submitEssay;
}

async function submitEssay() {
    const userAnswer = $("#essay-input").value.trim();
    if (!userAnswer) return;

    await submitGrade(null, userAnswer, true);
}

function renderEssayFeedback(fb) {
    const area = $("#feedback-area");
    show(area);

    const score = fb.score || 0;
    let scoreClass = score >= 8 ? "score-high" : (score >= 5 ? "score-mid" : "score-low");

    let html = `
        <div class="feedback-score">
            <div class="score-number ${scoreClass}">${score.toFixed(1)}</div>
            <div class="score-label">/ 10 分（准确性 5 + 流畅度 3 + 丰富度 2）</div>        </div>
    `;

    // 用到的语法点（仅展示，不作为评分依据）
    if (fb.grammar_check && fb.grammar_check.length > 0) {
        html += `<div class="feedback-section">
            <div class="feedback-section-title">你运用到的语法点</div>`;
        fb.grammar_check.forEach(gc => {
            html += `<div class="feedback-item ${gc.correct ? 'good' : 'bad warning'}">
                <strong>${gc.grammar}</strong>：${gc.note}
            </div>`;
        });
        html += `</div>`;
    }

    // 正确部分
    if (fb.correct_parts && fb.correct_parts.length > 0) {
        html += `<div class="feedback-section">
            <div class="feedback-section-title feedback-correct">做得好的地方</div>`;
        fb.correct_parts.forEach(p => {
            html += `<div class="feedback-item good">${p}</div>`;
        });
        html += `</div>`;
    }

    // 建议
    if (fb.suggestions) {
        html += `<div class="feedback-section">
            <div class="feedback-section-title feedback-suggestion">整体评价</div>
            <div class="feedback-item tip">${fb.suggestions}</div>
        </div>`;
    }

    // 鼓励
    if (fb.encouragement) {
        html += `<div class="feedback-section" style="text-align: center;">
            <div class="encouragement-text">${fb.encouragement}</div>
        </div>`;
    }

    $("#feedback-card").innerHTML = html;

    // 按钮：进入总结
    $("#feedback-actions").innerHTML = `
        <button class="btn btn-primary btn-full" id="btn-goto-summary">查看总结报告</button>
    `;
    $("#btn-goto-summary").onclick = generateSummary;

    area.style.display = "";
    area.style.animation = "none"; area.offsetHeight;
    area.style.animation = "feedbackReveal 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)";
    refreshIcons();
}

// ============================================================
// 屏幕 4：总结
// ============================================================
async function generateSummary() {
    showLoading("正在生成专属复习笔记...");

    // 清除进度（已完成）
    try { await api("/api/progress", { method: "DELETE" }); } catch {}

    try {
        const result = await api("/api/generate_summary", {
            method: "POST",
            body: JSON.stringify({
                // Beta 6.0（2.1）：复习/答疑联动会话的摘要在 sessionNotes；总结优先带上它
                notes: AppState.sessionNotes || AppState.notes,
                level: AppState.config.level,
                records: AppState.records,
                vocab_used: AppState.vocabUsed,
            }),
        });

        if (!result.success) {
            throw new Error("总结生成失败");
        }

        hideLoading();
        showSummaryScreen(result);

        // 弹出确认：是否保存到知识库
        showSaveLearnedModal();

    } catch (err) {
        hideLoading();
        showToast(`生成总结失败：${err.message}`, "error");
    }
}

// --- 复习点识别与立即更新（PRD §2.6）---
// 语法点归一化：去空白、去 〜、全角→半角
function normalizeGP(s) {
    return String(s || "")
        .replace(/[\s　]/g, "")
        .replace(/〜/g, "")
        .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/＋/g, "+")
        .replace(/，/g, ",")
        .replace(/／/g, "/")
        .replace(/＆/g, "&");
}

// 拆分复合 grammar_point（A+B / A、B），返回组件数组
function splitGrammarPoint(gp) {
    return String(gp || "")
        .split(/[+＋、，,&&/]/)
        .map(s => s.trim())
        .filter(Boolean);
}

// 识别本题覆盖了哪些已入库复习点（主来源 review_points_covered，回退拆复合串）
function matchReviewPoints(q, learnedMap) {
    if (!learnedMap || !q) return [];
    const hit = new Set();
    // 主来源：出题时模型已标注
    (q.review_points_covered || []).forEach(p => {
        const norm = normalizeGP(p);
        if (learnedMap.has(norm)) hit.add(learnedMap.get(norm));
    });
    // 回退：对 grammar_point 拆复合串，与既有键做归一化相等 / 子串双向包含
    if (hit.size === 0) {
        splitGrammarPoint(q.grammar_point).forEach(part => {
            const norm = normalizeGP(part);
            if (!norm) return;
            let best = null;
            learnedMap.forEach((name, key) => {
                if (key === norm) { best = name; return; }
            });
            if (!best) {
                learnedMap.forEach((name, key) => {
                    if ((key.includes(norm) || norm.includes(key)) && !best) best = name;
                });
            }
            if (best) hit.add(best);
        });
    }
    return [...hit];
}

// 练习会话开始时缓存 learned_content 键（一次拉取，会话内复用）
async function loadLearnedMap() {
    if (AppState.learnedMap) return AppState.learnedMap;
    try {
        const res = await api("/api/learned_content", { method: "GET" });
        const items = (res && res.items) || [];
        AppState.learnedMap = new Map(items.map(i => [normalizeGP(i.grammar_point), i.grammar_point]));
    } catch {
        AppState.learnedMap = new Map();  // 拉取失败退化为空，不影响正常流程
    }
    return AppState.learnedMap;
}

// 批改完成后：识别覆盖的复习点 → 立即更新 SM-2（作文路径不参与单点调度）
async function saveImmediateReviewProgress(q, fb) {
    if (!q || q.is_essay || !fb) return;
    const learnedMap = await loadLearnedMap();
    const covered = matchReviewPoints(q, learnedMap);
    if (covered.length === 0) return;
    try {
        await api("/api/learned_content", {
            method: "POST",
            body: JSON.stringify({
                items: covered.map(name => ({
                    grammar_point: name,
                    score: fb.score || 0,
                    level: AppState.config.level,
                })),
            }),
        });
        covered.forEach(name => AppState.immediateSaved.add(name));
    } catch {
        // 离线等失败场景：不记入 immediateSaved，弹窗兜底补写一次
    }
}

function showSaveLearnedModal() {
    show($("#modal-save-learned"));

    $("#btn-save-yes").onclick = async () => {
        hide($("#modal-save-learned"));
        showLoading("正在保存...");
        await updateLearnedContent();
        hideLoading();
    };

    $("#btn-save-no").onclick = () => {
        hide($("#modal-save-learned"));
    };
}

async function updateLearnedContent() {
    // 从答题记录中提取语法点和得分
    const items = [];
    const seen = new Set();
    AppState.records.forEach(r => {
        // 作文是综合作文，不参与单个语法点的艾宾浩斯复习调度
        if (r.is_essay) return;
        // 复合 grammar_point（如 "A+B"）按组件拆分入库，各点都过 immediateSaved 去重
        const parts = splitGrammarPoint(r.question?.grammar_point);
        const gps = parts.length > 0 ? parts : [r.question?.grammar_point];
        gps.forEach(gp => {
            if (!gp) return;
            if (AppState.immediateSaved.has(gp)) return;  // 复习点已「立即更新」，弹窗跳过
            const key = normalizeGP(gp);
            if (seen.has(key)) return;
            seen.add(key);
            items.push({
                grammar_point: gp,
                level: r.question?.extra_level || AppState.config.level,
                score: r.feedback?.score || 0,
            });
        });
    });

    if (items.length > 0) {
        try {
            await api("/api/learned_content", {
                method: "POST",
                body: JSON.stringify({ items }),
            });
        } catch {
            // 静默失败
        }
    }

}

async function showSummaryScreen(result) {
    showScreen("summary");

    // 统计
    const scores = AppState.records.map(r => r.feedback?.score || 0);
    const avg = scores.length > 0
        ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
        : "0";
    const high = scores.filter(s => s >= 8).length;
    const low = scores.filter(s => s < 5).length;

    let vocabUsedHtml = "";
    if (AppState.vocabUsed && AppState.vocabUsed.length > 0) {
        vocabUsedHtml = `
            <div class="stat-card wide">
                <div class="stat-label" style="font-size:12px;">用到的新单词</div>
                <div style="font-size:14px; color: var(--text-primary); margin-top: 4px; line-height: 1.6;">
                    ${AppState.vocabUsed.map(w => `<span style="background: var(--color-primary-light); padding: 2px 8px; border-radius: 999px; margin: 2px; display: inline-block;">${w}</span>`).join(' ')}
                </div>
            </div>
        `;
    }

    $("#stats-card").innerHTML = `
        <div class="stat-card">
            <div class="stat-value">${AppState.records.length}</div>
            <div class="stat-label">总答题数</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${avg}</div>
            <div class="stat-label">平均分</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${high}</div>
            <div class="stat-label">高分题</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${low}</div>
            <div class="stat-label">需加强</div>
        </div>
        ${vocabUsedHtml}
    `;

    // Markdown 预览
    $("#markdown-preview").innerHTML = renderMarkdown(result.markdown || "");

    // 下载按钮（桥模式弹原生保存对话框，浏览器模式 window.open）
    const date = result.date || new Date().toISOString().slice(0, 10);
    $("#btn-download").onclick = async () => {
        try { await downloadFile(`/api/download/${date}`); }
        catch (e) { showToast("下载失败：" + ((e && e.message) || e), "error"); }
    };

    // 再来一轮
    $("#btn-new-round").onclick = () => {
        AppState.records = [];
        AppState.questions = [];
        AppState.currentIndex = 0;
        AppState.totalAnswered = 0;
        AppState.baseTotal = 0;
        AppState.vocabUsed = [];
        AppState.sessionNotes = "";   // Beta 6.0（2.1）：新会话不残留上一轮摘要
        AppState.reviewInBatchMode = false;
        AppState.selectedReviewPoints = [];
        showMainScreen();
    };

    // Beta 5.5：批量复习 session 结束后的剩余提示
    const existingBatch = $("#review-batch-actions");
    if (existingBatch) existingBatch.remove();
    if (AppState.reviewInBatchMode) {
        const summaryActions = $(".summary-actions");
        if (summaryActions) {
            showLoading("正在计算剩余复习知识点...");
            try {
                const dueData = await api("/api/review_due");
                hideLoading();
                const remaining = (dueData.due || []).filter(i => !AppState.selectedReviewPoints.includes(i.grammar_point));
                const batchDiv = document.createElement("div");
                batchDiv.id = "review-batch-actions";
                batchDiv.className = "review-batch-actions";
                batchDiv.innerHTML = `
                    <p class="review-batch-hint">本次复习完成，剩余 ${remaining.length} 个知识点未复习</p>
                    <div class="review-batch-btns">
                        <button id="btn-review-continue" class="btn btn-primary">继续下一批</button>
                        <button id="btn-review-end" class="btn btn-secondary">结束复习</button>
                    </div>
                `;
                summaryActions.parentNode.insertBefore(batchDiv, summaryActions);
                $("#btn-review-continue").onclick = () => {
                    if (remaining.length === 0) {
                        showToast("所有到期知识点已复习完毕", "success");
                        AppState.reviewInBatchMode = false;
                        AppState.selectedReviewPoints = [];
                        showSettingsScreen();
                        return;
                    }
                    showReviewSelectModal({ due: remaining, total: dueData.total || 0 });
                };
                $("#btn-review-end").onclick = () => {
                    AppState.reviewInBatchMode = false;
                    AppState.selectedReviewPoints = [];
                    showSettingsScreen();
                };
            } catch {
                hideLoading();
            }
        }
    }
}

// ============================================================
// 屏幕 5 & 6：历史记录
// ============================================================
async function initHistoryScreen() {
    showLoading("加载历史记录...");

    try {
        const result = await api("/api/history");
        hideLoading();
        showScreen("history");

        const list = $("#history-list");
        const empty = $("#history-empty");

        if (!result.files || result.files.length === 0) {
            list.innerHTML = "";
            show(empty);
        } else {
            hide(empty);
            list.innerHTML = result.files.map(f => `
                <div class="history-item" data-date="${f.date}">
                    <div class="history-item-info">
                        <span class="history-item-date">${f.date}</span>
                        <span class="history-item-meta">${f.level} | ${f.record_count} 题</span>
                    </div>
                    <span class="history-item-arrow">→</span>
                </div>
            `).join("");

            // 点击查看详情
            $$(".history-item").forEach(item => {
                item.onclick = () => {
                    const date = item.dataset.date;
                    showHistoryDetail(date);
                };
            });
        }
    } catch (err) {
        hideLoading();
        showToast(`加载历史失败：${err.message}`, "error");
    }

    $("#btn-history-back").onclick = showSettingsScreen;
}

async function showHistoryDetail(date) {
    showLoading("加载记录...");

    try {
        const result = await api(`/api/history/${date}`);
        hideLoading();

        if (!result.success) {
            throw new Error("加载失败");
        }

        AppState.historyDate = date;
        showScreen("history-detail");

        const data = result.data;
        $("#detail-title").textContent = `${date} 练习记录`;

        // 如果保存了 markdown 内容，尝试加载
        if (data.summary_md) {
            try {
                // 加载 markdown 文件内容（桥模式解码附件，浏览器模式 fetch text）
                const mdText = await apiFileText(`/api/download/${date}`);
                $("#detail-preview").innerHTML = renderMarkdown(mdText);
            } catch {
                showRecordFallback(data);
            }
        } else {
            showRecordFallback(data);
        }

        $("#btn-detail-download").onclick = async () => {
            try { await downloadFile(`/api/download/${date}`); }
            catch (e) { showToast("下载失败：" + ((e && e.message) || e), "error"); }
        };
    } catch (err) {
        hideLoading();
        showToast(`加载详情失败：${err.message}`, "error");
    }

    $("#btn-detail-back").onclick = initHistoryScreen;
}

function showRecordFallback(data) {
    const records = data.records || [];
    let html = `<h2>答题记录 (${records.length} 题)</h2>`;
    records.forEach((r, i) => {
        const q = r.question || {};
        const fb = r.feedback || {};
        html += `
            <h3>第 ${i + 1} 题</h3>
            <p><strong>语法点：</strong>${q.grammar_point || ""}</p>
            <p><strong>中文：</strong>${q.chinese || ""}</p>
            <p><strong>你的答案：</strong>${r.user_answer || ""}</p>
            <p><strong>参考答案：</strong>${q.reference_answer || ""}</p>
            <p><strong>得分：</strong>${fb.score || "N/A"} / 10</p>
            <hr>
        `;
    });
    $("#detail-preview").innerHTML = html;
}

// ============================================================
// Lucide 图标刷新
// ============================================================
function refreshIcons() {
    if (typeof lucide !== "undefined") lucide.createIcons();
}

// ============================================================
// 通用确认弹窗 + Toast（替代原生 alert / confirm / prompt）
// ============================================================

// Toast 图标用静态 SVG（toast 高频，避免每次触发 lucide 全量扫描）
const _TOAST_ICONS = {
    info: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
    success: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
};

/**
 * 轻提示（替代 alert）
 * @param {string} message 提示文案
 * @param {"info"|"success"|"error"} type 类型（决定图标与颜色）
 * @param {number} duration 自动消失毫秒数
 */
function showToast(message, type = "info", duration = 2600) {
    const viewport = $("#toast-viewport");
    if (!viewport) return;
    // 同屏最多 3 条，超出移除最早一条
    while (viewport.children.length >= 3) viewport.removeChild(viewport.firstChild);
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.setAttribute("role", "status");
    el.innerHTML = `${_TOAST_ICONS[type] || _TOAST_ICONS.info}<span></span>`;
    el.querySelector("span").textContent = message;
    viewport.appendChild(el);
    const remove = () => {
        if (!el.parentNode) return;
        el.classList.add("leaving");
        setTimeout(() => el.remove(), 200);
    };
    setTimeout(remove, duration);
}

/**
 * 确认弹窗（替代 confirm / prompt）
 * @param {object} opts { title, message, okText, cancelText, danger, icon, input:{placeholder} }
 * @returns Promise — 无 input 时 resolve true（确定）/ false（取消）；
 *          有 input 时 resolve 输入字符串（确定）/ null（取消）
 */
function showConfirm(opts = {}) {
    const {
        title = "确认操作",
        message = "",
        okText = "确定",
        cancelText = "取消",
        danger = false,
        icon = danger ? "alert-triangle" : "help-circle",
        input = null,
    } = opts;
    return new Promise((resolve) => {
        const overlay = $("#modal-confirm");
        if (!overlay) { resolve(input ? null : false); return; }
        const iconEl = overlay.querySelector("#confirm-icon");
        const titleEl = overlay.querySelector("#confirm-title");
        const msgEl = overlay.querySelector("#confirm-message");
        const inputWrap = overlay.querySelector("#confirm-input-wrap");
        const inputEl = overlay.querySelector("#confirm-input");
        const okBtn = overlay.querySelector("#btn-confirm-ok");
        const cancelBtn = overlay.querySelector("#btn-confirm-cancel");

        iconEl.className = "confirm-icon" + (danger ? " danger" : "");
        iconEl.innerHTML = `<i data-lucide="${icon}" style="width:26px;height:26px"></i>`;
        titleEl.textContent = title;
        msgEl.textContent = message;
        okBtn.textContent = okText;
        cancelBtn.textContent = cancelText;
        okBtn.className = "btn " + (danger ? "btn-danger" : "btn-primary");

        if (input) {
            inputWrap.style.display = "";
            inputEl.value = input.defaultValue || "";
            inputEl.placeholder = input.placeholder || "";
        } else {
            inputWrap.style.display = "none";
            inputEl.value = "";
        }

        show(overlay);
        refreshIcons();

        const finish = (val) => {
            hide(overlay);
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            overlay.onmousedown = null;
            document.removeEventListener("keydown", onKey);
            resolve(val);
        };
        const okValue = () => (input ? (inputEl.value.trim() || null) : true);
        const onKey = (e) => {
            if (e.key === "Escape") finish(input ? null : false);
            else if (e.key === "Enter" && document.activeElement !== okBtn && document.activeElement !== cancelBtn) finish(okValue());
        };
        okBtn.onclick = () => finish(okValue());
        cancelBtn.onclick = () => finish(input ? null : false);
        overlay.onmousedown = (e) => { if (e.target === overlay) finish(input ? null : false); };
        document.addEventListener("keydown", onKey);
        if (input) setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50);
    });
}

// ============================================================
// 复习状态
// ============================================================
let reviewStatusEl = null;

async function loadReviewStatus() {
    try {
        const data = await api("/api/review_due");
        const dueCount = (data.due || []).length;
        const totalCount = data.total || 0;

        // 顶部「待复习」chip（Beta 6.0）
        const dueChip = $("#chip-due");
        const dueChipNum = $("#chip-due-num");
        if (dueChip && dueChipNum) {
            dueChipNum.textContent = String(dueCount);
            dueChip.style.display = dueCount > 0 ? "" : "none";
        }

        const bar = $("#review-status-bar");
        const inner = $("#review-card-inner");
        if (!bar || !inner) return;

        if (dueCount > 0) {
            // 列出前 3 个到期语法点
            const topItems = (data.due || []).slice(0, 3);
            const itemTags = topItems.map(i =>
                `<span class="review-tag">${i.grammar_point}<span class="review-tag-stage">第${i.review_stage || 1}轮</span></span>`
            ).join("");

            inner.innerHTML = `
                <div class="review-card-top">
                    <div class="review-card-icon"><i data-lucide="brain" style="width:22px;height:22px"></i></div>
                    <div class="review-card-text">
                        <strong>${dueCount} 个语法点待复习</strong>
                        <span>艾宾浩斯记忆系统提醒你巩固（共学习 ${totalCount} 个）</span>
                    </div>
                </div>
                <div class="review-card-tags">${itemTags}${dueCount > 3 ? `<span class="review-tag-more">+${dueCount - 3} 个</span>` : ""}</div>
                <button class="btn btn-primary btn-sm" id="btn-start-review"><i data-lucide="rocket" style="width:14px;height:14px"></i> 开始复习</button>
            `;
            bar.style.display = "";
            refreshIcons();

            $("#btn-start-review").onclick = () => {
                // Beta 5.5：复习先弹出知识点选择弹窗（最多 12 个），再选题型
                showReviewSelectModal(data);
            };
        } else if (totalCount > 0) {
            inner.innerHTML = `
                <div class="review-card-top">
                    <div class="review-card-icon done"><i data-lucide="check-circle" style="width:22px;height:22px"></i></div>
                    <div class="review-card-text">
                        <strong>全部已掌握</strong>
                        <span>已学习 ${totalCount} 个语法点，暂无到期复习项</span>
                    </div>
                </div>
            `;
            bar.style.display = "";
        } else {
            bar.style.display = "none";
        }
        refreshIcons();
    } catch { /* 静默 */ }
}

// ============================================================
// 复习知识点选择 + 题型选择（Beta 5.5 温故更新）
// ============================================================
let _reviewSelectData = null;       // 缓存当前弹窗的 review_due 数据
let _reviewSelectedPoints = [];     // 当前弹窗选中的 grammar_point

function showReviewSelectModal(data) {
    _reviewSelectData = data;
    _reviewSelectedPoints = [];
    AppState.reviewInBatchMode = true;
    AppState.remainingReviewPoints = (data.due || []).map(i => i.grammar_point);
    const modal = $("#modal-review-select");
    if (!modal) {
        // 兜底：无弹窗则直接拿前 12 个出题
        const points = (data.due || []).slice(0, AppState.reviewBatchSize).map(i => i.grammar_point);
        showReviewTypeModal(points);
        return;
    }

    const due = (data.due || []).slice();
    const searchInput = $("#review-select-search");
    const listEl = $("#review-select-list");
    if (searchInput) searchInput.value = "";

    function renderList(filter = "") {
        const term = filter.trim().toLowerCase();
        const filtered = due.filter(i => !term || (i.grammar_point || "").toLowerCase().includes(term));
        // 默认勾选前 12 个
        if (_reviewSelectedPoints.length === 0 && due.length > 0) {
            _reviewSelectedPoints = due.slice(0, AppState.reviewBatchSize).map(i => i.grammar_point);
        }
        const fullCount = _reviewSelectedPoints.length >= AppState.reviewBatchSize;

        listEl.innerHTML = filtered.map(i => {
            const gp = i.grammar_point || "";
            const checked = _reviewSelectedPoints.includes(gp);
            const disabled = !checked && fullCount;
            const dueText = _reviewDueText(i.next_review);
            const mastery = Math.round((i.mastery || 0) * 100);
            return `
                <label class="review-select-item ${checked ? "selected" : ""} ${disabled ? "disabled" : ""}" data-gp="${escapeHtml(gp)}">
                    <input type="checkbox" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}>
                    <span class="review-select-name">${escapeHtml(gp)}</span>
                    <span class="review-select-meta">
                        <span class="review-select-due">${escapeHtml(dueText)}</span>
                        <span class="review-select-mastery">${mastery}%</span>
                    </span>
                </label>
            `;
        }).join("");

        // 绑定点击：点击整行卡片切换选中/反选
        listEl.querySelectorAll(".review-select-item").forEach(el => {
            el.onclick = (e) => {
                e.preventDefault();
                if (el.classList.contains("disabled")) return;
                const gp = el.dataset.gp;
                const cb = el.querySelector('input[type="checkbox"]');
                let newChecked;
                if (e.target === cb) {
                    // 直接点 checkbox：input 已经切换，按当前状态更新
                    newChecked = cb.checked;
                } else {
                    // 点整行：手动取反
                    newChecked = !cb.checked;
                    cb.checked = newChecked;
                }
                if (newChecked) {
                    if (!_reviewSelectedPoints.includes(gp)) _reviewSelectedPoints.push(gp);
                } else {
                    _reviewSelectedPoints = _reviewSelectedPoints.filter(p => p !== gp);
                }
                renderList(filter);
                updateReviewSelectCount();
            };
        });

        updateReviewSelectCount();
        refreshIcons();
    }

    renderList();

    if (searchInput) {
        searchInput.oninput = () => renderList(searchInput.value);
    }

    $("#btn-review-select-confirm").onclick = () => {
        if (_reviewSelectedPoints.length === 0) {
            showToast("请至少选择 1 个知识点", "error");
            return;
        }
        hide(modal);
        showReviewTypeModal(_reviewSelectedPoints);
    };
    $("#btn-review-select-cancel").onclick = () => hide(modal);
    $("#btn-review-select-close").onclick = () => hide(modal);
    modal.onclick = (e) => { if (e.target === modal) hide(modal); };

    show(modal);
    refreshIcons();
}

function updateReviewSelectCount() {
    const el = $("#review-select-count");
    if (!el) return;
    const count = _reviewSelectedPoints.length;
    el.textContent = `已选 ${count} / ${AppState.reviewBatchSize}`;
    el.classList.toggle("full", count >= AppState.reviewBatchSize);
}

function _reviewDueText(nextReview) {
    if (!nextReview) return "今天到期";
    const today = new Date();
    today.setHours(0,0,0,0);
    const d = new Date(nextReview);
    d.setHours(0,0,0,0);
    const diff = Math.round((d - today) / (1000 * 60 * 60 * 24));
    if (diff < 0) return `已逾期 ${Math.abs(diff)} 天`;
    if (diff === 0) return "今天到期";
    return `还剩 ${diff} 天`;
}

// 复习题型选择（Beta 5.5：先选择题型，再确认开始）
function showReviewTypeModal(selectedPoints) {
    const modal = $("#modal-review-type");
    if (!modal) { startReviewWithType(selectedPoints, "translation"); return; }
    show(modal);
    refreshIcons();

    let selectedType = "translation";
    const qtypeBtns = modal.querySelectorAll(".review-qtype-btn");
    qtypeBtns.forEach(btn => {
        // 默认第一个 active
        btn.classList.toggle("active", btn.dataset.qtype === selectedType);
        btn.onclick = () => {
            selectedType = btn.dataset.qtype || "translation";
            qtypeBtns.forEach(b => b.classList.toggle("active", b === btn));
        };
    });

    $("#btn-review-type-confirm").onclick = () => {
        hide(modal);
        startReviewWithType(selectedPoints, selectedType);
    };
    const cancelBtn = $("#btn-review-type-cancel");
    if (cancelBtn) cancelBtn.onclick = () => hide(modal);
    modal.onclick = (e) => { if (e.target === modal) hide(modal); };
}

async function startReviewWithType(selectedPoints, question_type) {
    if (!selectedPoints || selectedPoints.length === 0) {
        showToast("没有选中知识点", "error");
        return;
    }
    showLoading("正在生成复习题目...");
    loadLearnedMap();
    try {
        const result = await api("/api/generate_questions", {
            method: "POST",
            body: JSON.stringify({
                notes: "",
                review_points: selectedPoints,
                level: AppState.config.level,
                vocabulary: "",
                question_type: question_type,
                mode: "review",
            }),
        });
        if (!result.success || !result.data) throw new Error(result.error || "生成失败");
        // Beta 6.0（B1）：复习摘要只写 sessionNotes，绝不写 AppState.notes——
        // 否则回主页时笔记框被回填「复习：…」，下次练习发出两套矛盾指令
        AppState.sessionNotes = `复习：${selectedPoints.join("、")}`;
        AppState.vocabulary = "";
        AppState.questions = result.data.questions || [];
        AppState.vocabUsed = result.data.vocab_used || [];
        AppState.currentIndex = 0; AppState.records = [];
        AppState.totalAnswered = 0; AppState.baseTotal = AppState.questions.length;
        AppState.selectedReviewPoints = selectedPoints;
        AppState.reviewInBatchMode = true;
        hideLoading(); initQuizScreen();
    } catch (err) { hideLoading(); showToast(`复习题目生成失败：${err.message}`, "error"); }
}

// 继续下一批复习
async function continueReviewBatch() {
    try {
        const data = await api("/api/review_due");
        // 排除刚复习过的点
        const remaining = (data.due || []).filter(i => !AppState.selectedReviewPoints.includes(i.grammar_point));
        if (remaining.length === 0) {
            AppState.reviewInBatchMode = false;
            AppState.selectedReviewPoints = [];
            showToast("所有到期知识点已复习完毕", "success");
            showSettingsScreen();
            return;
        }
        showReviewSelectModal({ due: remaining, total: data.total || 0 });
    } catch (err) {
        showToast(`获取复习计划失败：${err.message}`, "error");
    }
}

// ============================================================
// 教材选择
// ============================================================
let textbookData = {};
let selectedGrammarLevelId = "";    // 当前语法点选择所属的级别卷 id
let grammarModalData = [];          // 当前弹窗内展示的语法点列表
let _manualLevel = "";              // B3：用户最近手动选择的目标级别（chips 全取消时回退用，不残留知识点级别）
const MAX_FOCUS_TAGS = 12;          // M4.5：语法点选择上限（出题 prompt 单点化配套，>12 时模型必然牺牲通顺度）

async function loadTextbookOptions() {
    try {
        const data = await api("/api/knowledge_base");
        const select = $("#textbook-select");
        if (!select) return;
        select.innerHTML = '<option value="">自由模式（不限定语法范围）</option>';
        // 只展示 jlpt_cards 教材（N5~N1）
        const jlpt = (data.textbooks || []).find(tb => tb.id === "jlpt_cards");
        const volumes = jlpt ? (jlpt.volumes || []) : [];
        volumes.forEach(vol => {
            const opt = document.createElement("option");
            opt.value = vol.id;
            opt.textContent = vol.name;  // "N5"、"N4"…
            select.appendChild(opt);
        });
        // 重建 options 后 select 显示值会重置为第一项（自由模式），但模块级
        // selectedGrammarLevelId 仍在——导致「自由模式 + 已选语法点」同屏的回归
        // bug（fix：showMainScreen 每次回主页都重建下拉）。这里按既有状态恢复
        // 选中值；状态悬空（该级别已不存在）则清态兜底。
        if (selectedGrammarLevelId && volumes.some(v => v.id === selectedGrammarLevelId)) {
            select.value = selectedGrammarLevelId;
        } else if (selectedGrammarLevelId) {
            AppState.selectedGrammarPoints = [];
            selectedGrammarLevelId = "";
            updateGrammarTagsDisplay();
            updateGrammarHint();
            updateTargetLevelCard();
        }
        select.onchange = async () => {
            const volId = select.value;
            if (!volId) {
                // 自由模式：清空选择
                AppState.selectedGrammarPoints = [];
                selectedGrammarLevelId = "";
                updateGrammarTagsDisplay();
                updateGrammarHint();
                updateTargetLevelCard();
                return;
            }
            // 切换级别时清空上一个级别的选择，保证下拉与标签一致
            if (selectedGrammarLevelId && selectedGrammarLevelId !== volId) {
                AppState.selectedGrammarPoints = [];
            }
            // 选中级别即记录，字段常驻显示（即使取消弹窗也能通过「编辑选择」重新打开）
            selectedGrammarLevelId = volId;
            updateGrammarTagsDisplay();
            updateGrammarHint();
            updateTargetLevelCard();
            const vol = volumes.find(v => v.id === volId);
            await openGrammarModal(volId, vol ? vol.name : volId);
        };
        // 弹窗按钮事件（每次绑定幂等，覆盖式赋值）
        // 全选/取消全选按钮已删除（09-09 用户裁定：上限 12 个的场景下全选无意义）
        $("#grammar-search").oninput = (e) => renderGrammarCheckboxes(e.target.value);
        $("#btn-grammar-confirm").onclick = confirmGrammarSelection;
        $("#btn-grammar-cancel").onclick = closeGrammarModal;
        $("#btn-grammar-close").onclick = closeGrammarModal;
        $("#modal-grammar").onclick = (e) => {
            if (e.target === $("#modal-grammar")) closeGrammarModal();
        };
        $("#btn-edit-grammar").onclick = async () => {
            const volId = $("#textbook-select").value;
            if (!volId) return;
            const vol = volumes.find(v => v.id === volId);
            await openGrammarModal(volId, vol ? vol.name : volId);
        };
    } catch { /* 静默 */ }
}

/** 打开语法点多选弹窗，展示指定级别的全部语法点（预勾选当前已选）。 */
async function openGrammarModal(volId, levelName) {
    const modal = $("#modal-grammar");
    if (!modal) return;
    if (!textbookData[volId]) {
        try { textbookData[volId] = await api(`/api/knowledge_base/${volId}`); }
        catch { textbookData[volId] = { lessons: [] }; }
    }
    // 展平所有 lesson 的 grammar
    let points = [];
    (textbookData[volId].lessons || []).forEach(l => { points = points.concat(l.grammar || []); });
    grammarModalData = points;
    const title = $("#grammar-modal-title");
    if (title) title.textContent = `选择 ${levelName} 语法点`;
    const search = $("#grammar-search");
    if (search) search.value = "";
    renderGrammarCheckboxes("");
    // 弹窗打开期间隐藏目标等级卡（此刻语法点为 0 会走「自由模式」分支把卡片亮出来，
    // 露在弹窗底下让用户看到 NX 等级按钮，09-09 用户实测）；关闭时按真实状态恢复
    const levelCard = $("#target-level-card");
    if (levelCard) levelCard.style.display = "none";
    show(modal);
}

/** 关闭语法点选择弹窗并恢复目标等级卡的正确显隐（确认/取消/右上角关闭/点遮罩共用）。
 * 09-10 用户裁定：取消时保留已选的教材级别（出题范围 = N4），
 * updateTargetLevelCard 据此隐藏目标级别卡；想回自由模式用下拉切回「自由模式」。 */
function closeGrammarModal() {
    hide($("#modal-grammar"));
    updateTargetLevelCard();
}

/** 渲染弹窗内复选框列表，可按关键词过滤。勾满 12 个后其余禁用（M4.5）。 */
function renderGrammarCheckboxes(filterText) {
    const list = $("#grammar-modal-list");
    if (!list) return;
    const kw = (filterText || "").trim().toLowerCase();
    list.innerHTML = "";
    let visible = 0;
    const alreadyCount = AppState.selectedGrammarPoints.length;
    grammarModalData.forEach(g => {
        const hay = (g.point || "") + " " + (g.explanation || "");
        const matches = !kw || hay.toLowerCase().includes(kw);
        if (!matches) return;
        visible++;
        const already = AppState.selectedGrammarPoints.some(p => p.point === g.point);
        const full = !already && alreadyCount >= MAX_FOCUS_TAGS;
        const item = document.createElement("label");
        item.className = "grammar-check-item";
        item.innerHTML =
            `<input type="checkbox"${already ? " checked" : ""}${full ? " disabled" : ""}>` +
            `<span class="grammar-check-body">` +
            `<span class="grammar-point">${escapeHtml(g.point)}</span>` +
            `<span class="grammar-explain">${escapeHtml(g.explanation || "")}</span>` +
            `</span>`;
        list.appendChild(item);
    });
    if (visible === 0) {
        list.innerHTML = '<p style="padding:var(--space-md) 0;text-align:center;color:var(--text-tertiary);font-size:14px;">没有匹配的语法点</p>';
    }
    // 单项勾选联动：计数 + 勾满禁用（原先无监听，计数只在全选/取消时刷新）
    list.querySelectorAll("input[type=checkbox]").forEach(cb => {
        cb.addEventListener("change", () => {
            if (cb.checked) {
                const checked = $$("#grammar-modal-list input[type=\"checkbox\"]:checked").length;
                if (checked > MAX_FOCUS_TAGS) { cb.checked = false; return; }   // 上限兜底
            }
            refreshGrammarDisabled();
            updateGrammarCount();
        });
    });
    refreshGrammarDisabled();
    updateGrammarCount();
}

/** M4.5：按已选数量刷新禁用态（勾满 12 后未选项禁用）与上限提示。 */
function refreshGrammarDisabled() {
    const list = $("#grammar-modal-list");
    if (!list) return;
    const checked = $$("#grammar-modal-list input[type=\"checkbox\"]:checked").length;
    const full = checked >= MAX_FOCUS_TAGS;
    list.querySelectorAll("input[type=checkbox]").forEach(cb => {
        if (!cb.checked) cb.disabled = full;
    });
    const hint = $("#grammar-limit-hint");
    if (hint) hint.style.display = full ? "" : "none";
}

/** 更新弹窗底部已选计数（M4.5：分母固定为上限 12）。 */
function updateGrammarCount() {
    const count = $("#grammar-count");
    if (!count) return;
    const checked = $$("#grammar-modal-list input[type=\"checkbox\"]:checked").length;
    count.textContent = `${checked} / ${MAX_FOCUS_TAGS} 已选`;
}

/** 确认弹窗选择：把勾选的语法点写入 AppState 并渲染标签。 */
function confirmGrammarSelection() {
    const checked = $$("#grammar-modal-list input[type=\"checkbox\"]:checked");
    const picked = [];
    checked.forEach(cb => {
        const point = cb.closest(".grammar-check-item").querySelector(".grammar-point").textContent;
        const g = grammarModalData.find(x => x.point === point);
        if (g) picked.push({ point: g.point, explanation: g.explanation || "" });
    });
    AppState.selectedGrammarPoints = picked.slice(0, MAX_FOCUS_TAGS);  // 上限兜底（正常勾选流程到不了这里）
    selectedGrammarLevelId = $("#textbook-select").value;
    hide($("#modal-grammar"));
    updateGrammarTagsDisplay();
    updateGrammarHint();
    updateTargetLevelCard();
}

/** 渲染教材卡片下方的已选语法点标签（级别激活时字段常驻显示）。 */
function updateGrammarTagsDisplay() {
    const field = $("#grammar-tags-field");
    const display = $("#grammar-tags-display");
    const editBtn = $("#btn-edit-grammar");
    if (!field || !display) return;
    const pts = AppState.selectedGrammarPoints || [];
    if (!selectedGrammarLevelId) {
        // 未选择任何级别：隐藏字段
        field.style.display = "none";
        return;
    }
    field.style.display = "";
    if (pts.length > 0) {
        display.innerHTML = pts.map((g, i) =>
            `<span class="grammar-tag-chip">${escapeHtml(g.point)}` +
            `<span class="tag-remove" data-idx="${i}" title="移除">×</span></span>`
        ).join("");
    } else {
        display.innerHTML = '<span class="grammar-tags-empty">未选择语法点</span>';
    }
    if (editBtn) editBtn.style.display = "";
    display.querySelectorAll(".tag-remove").forEach(el => {
        el.onclick = (e) => {
            e.stopPropagation();
            AppState.selectedGrammarPoints.splice(parseInt(el.dataset.idx, 10), 1);
            updateGrammarTagsDisplay();
            updateGrammarHint();
            updateTargetLevelCard();   // B3：chips 全取消时恢复等级卡并回退级别
        };
    });
}

/** 更新教材卡片底部提示文字。 */
function updateGrammarHint() {
    const hint = $("#textbook-hint");
    if (!hint) return;
    const count = (AppState.selectedGrammarPoints || []).length;
    if (!selectedGrammarLevelId) {
        hint.textContent = "选择级别后可指定具体的语法点范围";
    } else if (count > 0) {
        hint.textContent = `已选择 ${count} 个语法点，出题将聚焦这些知识点`;
    } else {
        hint.textContent = "已选择级别，可点击「编辑选择」指定语法点（不指定则出题不受语法点限制）";
    }
}

/** 目标级别卡片显示逻辑：仅自由模式（未选教材级别）显示。
 * 选了教材级别（无论是否勾语法点）= 出题范围已确定 → 自动设级别并隐藏卡片；
 * 09-10 修复：原条件要求「有语法点」——只选级别不选点时「已选 N4」与 NX 等级卡同屏矛盾。
 * 切回下拉「自由模式」即清空全部范围（onchange volId="" 分支）。 */
function updateTargetLevelCard() {
    const card = $("#target-level-card");
    if (!card) return;
    if (selectedGrammarLevelId) {
        // 教材范围模式：目标级别 = 所选教材级别（"n3" → "N3"），隐藏卡片
        card.style.display = "none";
        const level = selectedGrammarLevelId.toUpperCase();
        if (level) {
            AppState.config.level = level;
            $$(".level-btn").forEach(b => b.classList.toggle("active", b.dataset.level === level));
        }
    } else {
        // 自由模式：显示卡片，级别回退到用户最近手动选择的值
        card.style.display = "";
        if (_manualLevel) {
            AppState.config.level = _manualLevel;
            $$(".level-btn").forEach(b => b.classList.toggle("active", b.dataset.level === _manualLevel));
        }
    }
}

// ============================================================
// 错题本
// ============================================================
async function collectWrongAnswer(question, userAnswer, feedback) {
    const errorTypes = [];
    if (feedback.error_parts) feedback.error_parts.forEach(e => {
        if ((e.level || "").includes("❌")) errorTypes.push("核心错误");
        else if ((e.level || "").includes("⚠")) errorTypes.push("小问题");
    });
    const item = { id: Date.now(), grammar_point: question.grammar_point || "", question: question, user_answer: userAnswer, feedback: feedback, score: feedback.score || 0, error_types: errorTypes, added_at: new Date().toISOString().slice(0, 10), reviewed_count: 0, last_reviewed: null, mastered: false };
    try { await api("/api/wrong_book", { method: "POST", body: JSON.stringify({ items: [item] }) }); } catch { /* 静默 */ }
}

async function initWrongBookScreen() {
    showLoading("加载错题本...");
    try {
        const result = await api("/api/wrong_book"); hideLoading(); showScreen("wrong-book");
        const items = result.items || [];
        if (items.length === 0) { $("#wrong-list").innerHTML = ""; show($("#wrong-empty")); hide($("#wrong-stats")); }
        else {
            hide($("#wrong-empty"));

            // 按语法点分组
            const groups = new Map();
            for (const item of items) {
                const gp = item.grammar_point || "综合";
                if (!groups.has(gp)) groups.set(gp, []);
                groups.get(gp).push(item);
            }

            const totalGroups = groups.size;
            const totalItems = items.length;
            const activeGroups = [...groups.values()].filter(g => g.some(i => !i.mastered)).length;
            const activeItems = items.filter(i => !i.mastered).length;
            $("#wrong-stats").innerHTML = `共 <strong>${totalGroups}</strong> 个语法点（<strong>${totalItems}</strong> 题），未掌握 <strong>${activeGroups}</strong> 个${activeItems > 0 ? `，已掌握 ${totalItems - activeItems} 题` : ""}`;
            show($("#wrong-stats"));

            let html = "";
            for (const [grammar, groupItems] of groups) {
                const avgScore = (groupItems.reduce((s, i) => s + (i.score || 0), 0) / groupItems.length).toFixed(1);
                const allMastered = groupItems.every(i => i.mastered);
                const errorTypes = [...new Set(groupItems.flatMap(i => i.error_types || []))];

                html += `<div class="wrong-group${allMastered ? " wrong-group-mastered" : ""}">
                    <div class="wrong-group-header">
                        <div class="wrong-group-info">
                            <span class="wrong-group-grammar">${grammar}</span>
                            <span class="wrong-group-meta">${groupItems.length} 题 · 均分 ${avgScore}</span>
                            ${errorTypes.length > 0 ? `<span class="wrong-group-errors">${errorTypes.join(" · ")}</span>` : ""}
                        </div>
                        <i data-lucide="chevron-down" style="width:16px;height:16px;color:var(--text-tertiary);transition:transform 0.25s"></i>
                    </div>
                    <div class="wrong-group-body" style="display:none">`;

                for (const item of groupItems) {
                    const sc = item.score >= 5 ? "mid" : "low";
                    html += `<div class="wrong-item${item.mastered ? " wrong-item-mastered" : ""}" data-id="${item.id}">
                        <div class="wrong-item-header">
                            <span class="wrong-item-date">${item.added_at}</span>
                            <span class="wrong-item-score ${sc}">${item.score}分</span>
                        </div>
                        <div class="wrong-item-preview">${item.error_types.length > 0 ? "错误类型：" + item.error_types.join("、") : (item.feedback?.suggestions || "").slice(0, 50)}</div>
                    </div>`;
                }

                html += `</div></div>`;
            }
            $("#wrong-list").innerHTML = html;
            refreshIcons();

            // 点击组头展开/折叠
            $$(".wrong-group-header").forEach(header => {
                header.onclick = () => {
                    const group = header.closest(".wrong-group");
                    const body = group.querySelector(".wrong-group-body");
                    const icon = header.querySelector("i");
                    const isOpen = body.style.display !== "none";
                    body.style.display = isOpen ? "none" : "";
                    if (icon) icon.style.transform = isOpen ? "" : "rotate(180deg)";
                };
            });

            // 点击具体错题查看详情
            $$(".wrong-item").forEach(el => {
                el.onclick = (e) => {
                    e.stopPropagation();
                    const id = parseInt(el.dataset.id);
                    const item = items.find(i => i.id === id);
                    if (item) showWrongDetail(item);
                };
            });
        }
    } catch (err) { hideLoading(); showToast(`加载失败：${err.message}`, "error"); }
    $("#btn-wrong-back").onclick = showSettingsScreen;
}

function showWrongDetail(item) {
    showScreen("wrong-book"); hide($("#wrong-list")); hide($("#wrong-stats")); hide($("#wrong-empty"));
    const fb = item.feedback || {}; const errors = fb.error_parts || [];
    const errorHtml = errors.length > 0 ? errors.map(e => `<div class="wrong-detail-text error"><strong>${e.level || ""} ${e.error || ""}</strong><br>正确：${e.correction || ""}<br>${e.explanation || ""}</div>`).join("") : "<p>暂无详细错误信息</p>";
    const correctHtml = (fb.correct_parts || []).length > 0 ? fb.correct_parts.map(c => `<div class="wrong-detail-text correct">${c}</div>`).join("") : "";
    const html = `<div class="wrong-detail">
        <div class="wrong-detail-section"><div class="wrong-detail-label">原题</div><div class="wrong-detail-text">${item.question?.chinese || ""}</div></div>
        <div class="wrong-detail-section"><div class="wrong-detail-label">你的答案</div><div class="wrong-detail-text error">${item.user_answer || ""}</div></div>
        <div class="wrong-detail-section"><div class="wrong-detail-label">参考答案</div><div class="wrong-detail-text correct">${item.question?.reference_answer || ""}</div></div>
        ${correctHtml ? `<div class="wrong-detail-section"><div class="wrong-detail-label">做得对的地方</div>${correctHtml}</div>` : ""}
        <div class="wrong-detail-section"><div class="wrong-detail-label">需要注意</div>${errorHtml}</div>
        ${fb.suggestions ? `<div class="wrong-detail-section"><div class="wrong-detail-label">建议</div><div class="wrong-detail-text">${fb.suggestions}</div></div>` : ""}
    </div>
    <div class="wrong-actions">
        <button class="btn btn-primary" id="btn-wrong-retry">重新练习</button>
        <button class="btn btn-secondary" id="btn-wrong-mastered">标记已掌握</button>
        <button class="btn btn-text" id="btn-wrong-back-list">← 返回列表</button>
    </div>`;
    const container = document.createElement("div"); container.id = "wrong-detail-container"; container.innerHTML = html;
    const wrongScreen = $("#screen-wrong-book"); if (wrongScreen) wrongScreen.appendChild(container);
    $("#btn-wrong-retry").onclick = () => rePracticeWrong(item);
    $("#btn-wrong-mastered").onclick = () => markWrongMastered(item);
    $("#btn-wrong-back-list").onclick = () => { const dc = $("#wrong-detail-container"); if (dc) dc.remove(); show($("#wrong-list")); initWrongBookScreen(); };
}

async function rePracticeWrong(item) {
    const dc = $("#wrong-detail-container"); if (dc) dc.remove();
    showLoading("正在生成练习题目...");
    try {
        const result = await api("/api/grade_answer", { method: "POST", body: JSON.stringify({ question: { grammar_point: item.grammar_point }, user_answer: "", level: AppState.config.level, action: "retry" }) });
        if (!result.success || !result.new_question) throw new Error("生成失败");
        await api("/api/wrong_book", { method: "POST", body: JSON.stringify({ items: [{ id: item.id, reviewed_count: (item.reviewed_count || 0) + 1, last_reviewed: new Date().toISOString().slice(0, 10) }] }) });
        hideLoading(); AppState.questions = [result.new_question]; AppState.currentIndex = 0; AppState.records = []; AppState.totalAnswered = 0; AppState.baseTotal = 1;
        initQuizScreen();
    } catch (err) { hideLoading(); showToast(`生成失败：${err.message}`, "error"); }
}

async function markWrongMastered(item) {
    await api("/api/wrong_book", { method: "POST", body: JSON.stringify({ items: [{ id: item.id, mastered: true }] }) });
    const dc = $("#wrong-detail-container"); if (dc) dc.remove(); show($("#wrong-list")); initWrongBookScreen();
}

// ============================================================
// 初始化
// ============================================================
let clickSparkInstance = null;

function init() {
    // 提交按钮
    $("#btn-submit").onclick = submitAnswer;

    // 回车提交
    $("#answer-input").onkeydown = (e) => {
        if (e.key === "Enter" && !$("#btn-submit").disabled) {
            submitAnswer();
        }
    };

    // 答题页面返回按钮
    const quizBack = $("#btn-quiz-back");
    if (quizBack) quizBack.onclick = showMainScreen;

    // ====== ReactBits 动效 ======
    // ClickSpark — 全局点击火花
    if (typeof createClickSpark === 'function') {
        clickSparkInstance = createClickSpark({
            sparkColor: getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() || '#F00000',
            sparkCount: 6,
            sparkRadius: 18,
            duration: 350,
        });
    }

    // 所有按钮加弹簧按压
    document.addEventListener('click', e => {
        const btn = e.target.closest('.btn');
        if (btn && typeof springPress === 'function') {
            springPress(btn);
        }
    });

    // 首页「公告」彩色按钮 → 公告弹窗
    const announceBtn = $("#btn-guide-announce");
    if (announceBtn) announceBtn.onclick = showAnnounceModal;

    // 首页 QQ 群卡片 → 复制群号
    const qqCard = $("#btn-copy-qq");
    if (qqCard) qqCard.onclick = copyQqGroupNumber;

    // 首页 hero「使用说明」+ 底部「隐私政策」pill（Beta 6.0 落地页分层新增入口）
    const helpBtn = $("#btn-guide-help");
    if (helpBtn) helpBtn.onclick = showGuideModal;
    const privacyBtn = $("#btn-guide-privacy");
    if (privacyBtn) privacyBtn.onclick = showPrivacyScreen;

    // 启动
    initGuideScreen();
}

// ============================================================
// Dock 导航栏
// ============================================================
function setDockActive(screen) {
    document.querySelectorAll('.dock-item').forEach(item => {
        item.classList.toggle('active', item.dataset.screen === screen);
    });
}

function initDock() {
    const panel = $("#dock-panel");
    if (!panel) return;

    const items = panel.querySelectorAll('.dock-item');
    const baseSize = 48;
    const maxSize = 68;
    const distance = 120;

    panel.addEventListener('mousemove', e => {
        const panelRect = panel.getBoundingClientRect();
        const mouseX = e.clientX;

        items.forEach(item => {
            const rect = item.getBoundingClientRect();
            const itemCenter = rect.left + rect.width / 2;
            const dist = Math.abs(mouseX - itemCenter);
            const scale = dist < distance
                ? baseSize + (maxSize - baseSize) * Math.pow(1 - dist / distance, 2)
                : baseSize;
            item.style.width = scale + 'px';
            item.style.height = scale + 'px';
        });
    });

    panel.addEventListener('mouseleave', () => {
        items.forEach(item => {
            item.style.width = baseSize + 'px';
            item.style.height = baseSize + 'px';
        });
    });

    // 点击导航
    items.forEach(item => {
        item.addEventListener('click', () => {
            const screen = item.dataset.screen;
            switch (screen) {
                case 'guide': showGuideScreen(); break;
                case 'main': showMainScreen(); break;
                case 'vocab': showVocabScreen(); break;
                case 'reading': showReadingScreen(); break;
                case 'qa': showQaScreen(); break;
                case 'settings': showSettingsScreen(); break;
            }
        });
    });
}

// 首页（引导页）
function showGuideScreen() {
    showScreen("guide");
    setDockActive("guide");
    $("#btn-guide-start").onclick = async () => {
        const data = await loadConfig();
        if (data && data.has_api_key) {
            initMainScreen();
        } else {
            initSetupScreen();
        }
    };
}

// ============================================================
// 学习数据（打卡日历 / 复习计划 / 错题 / 历史 / 数据导出导入）
// 随设置页两列布局内联渲染，见 showSettingsScreen()
// ============================================================
function bindDataExportImport() {
    const exportBtn = $("#btn-data-export");
    if (exportBtn) exportBtn.onclick = async () => {
        // pywebview 原生环境：弹出系统保存对话框，让用户自选导出位置
        if (window.pywebview && window.pywebview.api
            && typeof window.pywebview.api.export_user_data_native === "function") {
            try {
                const r = await window.pywebview.api.export_user_data_native();
                if (r && r.success) {
                    showToast("学习数据已导出到：\n" + r.path, "success", 3600);
                }
                // 用户取消或不成功则不打扰
            } catch (e) {
                showToast("导出失败：" + ((e && e.message) || e), "error");
            }
            return;
        }
        // 浏览器模式降级：window.open 下载（桌面桥模式本分支不达，原生导出走上面）
        try { await downloadFile("/api/data/export"); }
        catch (e) { showToast("导出失败：" + ((e && e.message) || e), "error"); }
    };

    const importBtn = $("#btn-data-import");
    const importInput = $("#data-import-input");
    if (importBtn && importInput) {
        importBtn.onclick = () => importInput.click();
        importInput.onchange = async () => {
            const file = importInput.files && importInput.files[0];
            importInput.value = "";
            if (!file) return;
            if (!/\.json$/i.test(file.name)) {
                showToast("请选择 KOTOBA·AI 导出的 .json 备份文件", "error");
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(await file.text());
            } catch {
                showToast("文件解析失败，不是有效的备份文件", "error");
                return;
            }
            if (!parsed || parsed.app !== "KOTOBA-AI") {
                showToast("这不是 KOTOBA·AI 的备份文件", "error");
                return;
            }
            const okImport = await showConfirm({
                title: "导入学习数据？",
                message: "将把备份中的学习数据合并到本机，同名记录将被覆盖。",
                okText: "导入",
                danger: true,
            });
            if (!okImport) return;
            try {
                const j = await api("/api/data/import", {
                    method: "POST",
                    body: JSON.stringify(parsed),
                });
                if (j && j.success) {
                    // Beta 6.0 B4：导入覆盖了 learned_content/vocabulary → 同步失效
                    // 前端缓存（loadLearnedMap 复习点识别缓存 + vocabBooks 会话缓存），
                    // 随后整页 reload 兜底重置全部状态。
                    try { loadLearnedMap(); } catch {}
                    try { vocabBooks = []; } catch {}
                    showToast(j.message || "导入成功，正在刷新…", "success");
                    // 延迟刷新：给 toast 留出可见时间，避免一闪而过
                    setTimeout(() => location.reload(), 1200);
                } else {
                    showToast((j && j.error) || "导入失败", "error");
                }
            } catch (e) {
                showToast((e && e.message) || "导入失败，请重试", "error");
            }
        };
    }
}

// ============================================================
// 单词页（Beta 5.0：多词书首页 / 闪卡学习 / 词书详情）
// ============================================================
let vocabBooks = [];             // 词书列表 [{id, name, builtin, use_for_practice, stats}]
let vocabSelectedBook = null;    // 当前选中词书
let _vocabStudyMode = "learn";  // learn=学习（仅新词，默认）/ review=复习（仅到期词）
let _vocabStudyCards = [];
let _vocabStudyIndex = 0;
let _vocabBound = false;
let _vocabPickSelected = new Set();   // 选词弹窗已勾选的单词
let _vocabPickBookId = "";            // 选词弹窗第 2 步当前词书
let _vocabPickWordMeta = new Map();   // word → {word, reading, meaning}（Beta 6.0 全字段传词）
let _vocabPickBound = false;          // 选词弹窗是否已绑定过（防重复绑定）
const MAX_PRACTICE_WORDS = 30;        // Beta 6.0：出题词源上限（30 词融入效果最好；默认全不选）
let practiceVocabWords = [];     // 练习页「从词书选词」本次会话选中（不写回 SM-2）
let practiceVocabBookId = "";    // 上述选中所属词书（两步骤选词：一次仅一本，不支持跨词书）
let practiceVocabSource = "off"; // 与 #vocab-source-select 同步：off/book/input

function showVocabScreen() {
    showScreen("vocab");
    setDockActive("vocab");
    initVocabScreen();
}

async function loadVocabSettingsSummary() {
    // AC9：设置页「单词数据」入口摘要 = 词书数 + 当前词书背诵进度
    const el = $("#settings-vocab-desc");
    if (!el) return;
    try {
        const data = await api("/api/vocab/books");
        const books = Object.values(data.books || {});
        const cur = books.find(b => b.id === data.selected_book);
        if (!cur) { el.textContent = "暂无词书"; return; }
        const s = cur.stats || {};
        el.textContent = `${books.length} 本词书 · ${cur.name}：已背 ${s.learned || 0} / ${s.total || 0}`;
    } catch (e) {
        el.textContent = "词书 · 背诵进度";
    }
}

function initVocabScreen() {
    if (!_vocabBound) {
        bindVocabHome();
        bindVocabStudy();
        bindVocabDetail();
        bindVocabImportModal();
        bindVocabRenameModal();
        bindVocabPickModal();
        _vocabBound = true;
    }
    refreshIcons();
    loadVocabHome();
}

// ---------- 首页 ----------
function bindVocabHome() {
    const importBtn = $("#btn-vocab-import");
    if (importBtn) importBtn.onclick = openVocabImportModal;
    const pickEntry = $("#btn-vocab-pick-entry");
    if (pickEntry) pickEntry.onclick = toggleVocabBookList;
    const detailBtn = $("#btn-vocab-detail");
    if (detailBtn) detailBtn.onclick = showVocabDetail;
    const renameBtn = $("#btn-vocab-rename");
    if (renameBtn) renameBtn.onclick = () => { if (vocabSelectedBook) openVocabRenameModal(vocabSelectedBook.id, vocabSelectedBook.name); };
    const reviewBtn = $("#btn-vocab-review");
    if (reviewBtn) reviewBtn.onclick = () => showVocabStudy("review");
    const learnBtn = $("#btn-vocab-learn");
    if (learnBtn) learnBtn.onclick = () => showVocabStudy("learn");
    // 当前词书「用于练习出题」开关
    const practiceToggle = $("#vocab-home-practice-toggle");
    if (practiceToggle) practiceToggle.addEventListener("change", async () => {
        const b = vocabSelectedBook;
        if (!b) { practiceToggle.checked = false; return; }
        try {
            await api(`/api/vocab/books/${encodeURIComponent(b.id)}/practice`, {
                method: "POST",
                body: JSON.stringify({ use_for_practice: practiceToggle.checked }),
            });
            b.use_for_practice = practiceToggle.checked;
        } catch (e) {
            showToast("设置失败：" + ((e && e.message) || e), "error");
            practiceToggle.checked = !practiceToggle.checked;
        }
    });
}

function toggleVocabBookList() {
    const list = $("#vocab-book-list");
    if (!list) return;
    list.style.display = list.style.display === "none" ? "" : "none";
    refreshIcons();
}

// ---------- 词书重命名（应用内模态框，替代原生 prompt） ----------
let _vocabRenameBookId = "";      // 重命名弹窗当前词书 id
let _vocabRenameCurrentName = ""; // 重命名弹窗当前词书名（用于判断是否修改）

function openVocabRenameModal(bookId, currentName) {
    _vocabRenameBookId = bookId;
    _vocabRenameCurrentName = currentName || "";
    const input = $("#vocab-rename-name");
    if (input) {
        input.value = _vocabRenameCurrentName;
        input.focus();
        input.select();
    }
    show($("#modal-vocab-rename"));
    refreshIcons();
}

function bindVocabRenameModal() {
    const modal = $("#modal-vocab-rename");
    if (!modal) return;
    const closeBtn = $("#btn-vocab-rename-close");
    const cancelBtn = $("#btn-vocab-rename-cancel");
    if (closeBtn) closeBtn.onclick = () => hide(modal);
    if (cancelBtn) cancelBtn.onclick = () => hide(modal);
    modal.addEventListener("click", (e) => { if (e.target === modal) hide(modal); });
    const input = $("#vocab-rename-name");
    if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") submitVocabRename(); });
    const confirmBtn = $("#btn-vocab-rename-confirm");
    if (confirmBtn) confirmBtn.onclick = submitVocabRename;
}

async function submitVocabRename() {
    const input = $("#vocab-rename-name");
    const name = (input.value || "").trim();
    if (!name) { showToast("词书名称不能为空", "error"); if (input) input.focus(); return; }
    if (name === _vocabRenameCurrentName) { hide($("#modal-vocab-rename")); return; }  // 未修改
    try {
        const j = await api(`/api/vocab/books/${encodeURIComponent(_vocabRenameBookId)}/rename`, {
            method: "POST",
            body: JSON.stringify({ name }),
        });
        if (j.success === false) throw new Error(j.error || "重命名失败");
        hide($("#modal-vocab-rename"));
        loadVocabHome();
    } catch (e) {
        showToast("重命名失败：" + ((e && e.message) || e), "error");
    }
}

async function loadVocabHome() {
    try {
        const data = await api("/api/vocab/books");
        vocabBooks = Object.values(data.books || {});
        vocabSelectedBook = vocabBooks.find(b => b.id === data.selected_book) || null;
        renderVocabHome();
    } catch (e) {
        console.error("加载词书失败", e);
    }
}

function renderVocabHome() {
    const empty = $("#vocab-home-empty");
    const bookCard = $("#vocab-home-book");
    const bookList = $("#vocab-book-list");
    if (!vocabBooks.length) {
        if (bookCard) bookCard.style.display = "none";
        if (bookList) bookList.style.display = "none";
        if (empty) empty.style.display = "";
        refreshIcons();
        return;
    }
    if (empty) empty.style.display = "none";

    // 当前词书卡片
    if (bookCard) {
        bookCard.style.display = "";
        const b = vocabSelectedBook;
        const st = (b && b.stats) || { total: 0, learned: 0, due: 0, new: 0, mastery: 0 };
        $("#vocab-home-book-name").textContent = b ? b.name : "--";
        const pct = st.total ? Math.round((st.learned / st.total) * 100) : 0;
        $("#vocab-home-progress-fill").style.width = `${pct}%`;
        $("#vocab-home-progress-text").textContent = `已学 ${st.learned} / ${st.total} 词 · 掌握度 ${Math.round((st.mastery || 0) * 100)}%`;
        $("#vocab-home-new").textContent = st.new;
        $("#vocab-home-due").textContent = st.due;
        $("#vocab-home-learned").textContent = st.learned;
        const reviewBtn = $("#btn-vocab-review");
        const learnBtn = $("#btn-vocab-learn");
        if (reviewBtn) reviewBtn.disabled = !(st.due > 0);  // 功能2：复习仅到期词，无到期禁用
        if (learnBtn) learnBtn.disabled = !(st.new > 0);    // 功能2：学习仅新词，无新词禁用
        const practiceToggle = $("#vocab-home-practice-toggle");
        if (practiceToggle) practiceToggle.checked = !!b.use_for_practice;
        const renameBtn = $("#btn-vocab-rename");
        if (renameBtn) renameBtn.style.display = (b && !b.builtin) ? "" : "none";
    }

    // 词书列表（默认收起，点「选择词书」展开）
    if (bookList) {
        const body = $("#vocab-book-list-body");
        body.innerHTML = vocabBooks.map(b => {
            const st = b.stats || { total: 0 };
            const isActive = vocabSelectedBook && b.id === vocabSelectedBook.id;
            return `
                <div class="vocab-book-row ${isActive ? "active" : ""}" data-book-id="${b.id}">
                    <div class="vocab-book-info">
                        <span class="vocab-book-name">${escapeHtml(b.name)}</span>
                        <span class="vocab-book-meta">${st.total} 词${b.builtin ? " · 内置" : ""}</span>
                    </div>
                    <label class="toggle-label vocab-book-practice" title="启用后可在练习页「从词书选词」中看到本词书">
                        <input type="checkbox" data-book-id="${b.id}" ${b.use_for_practice ? "checked" : ""}>
                        <span>用于出题</span>
                    </label>
                    <button class="btn btn-secondary btn-sm vocab-book-detail" data-book-id="${b.id}" title="词书详情"><i data-lucide="search" style="width:14px;height:14px"></i></button>
                    ${b.builtin ? "" : `
                        <button class="btn btn-secondary btn-sm vocab-book-rename" data-book-id="${b.id}" title="重命名词书"><i data-lucide="pencil" style="width:14px;height:14px"></i></button>
                        <button class="btn btn-secondary btn-sm vocab-book-del" data-book-id="${b.id}" title="删除词书"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button>`}
                </div>
            `;
        }).join("");

        body.querySelectorAll(".vocab-book-row").forEach(row => {
            row.addEventListener("click", async (e) => {
                if (e.target.closest(".toggle-label") || e.target.closest("button")) return;
                await api("/api/vocab/books/select", {
                    method: "POST",
                    body: JSON.stringify({ book_id: row.dataset.bookId }),
                });
                loadVocabHome();
            });
        });
        body.querySelectorAll(".vocab-book-practice input").forEach(cb => {
            cb.addEventListener("change", async () => {
                try {
                    await api(`/api/vocab/books/${encodeURIComponent(cb.dataset.bookId)}/practice`, {
                        method: "POST",
                        body: JSON.stringify({ use_for_practice: cb.checked }),
                    });
                } catch (e) {
                    showToast("设置失败：" + ((e && e.message) || e), "error");
                }
                loadVocabHome();  // 与当前词书卡开关保持同步
            });
        });
        body.querySelectorAll(".vocab-book-detail").forEach(btn => {
            btn.addEventListener("click", () => {
                vocabSelectedBook = vocabBooks.find(b => b.id === btn.dataset.bookId) || null;
                showVocabDetail();
            });
        });
        body.querySelectorAll(".vocab-book-rename").forEach(btn => {
            btn.addEventListener("click", () => {
                const b = vocabBooks.find(x => x.id === btn.dataset.bookId);
                openVocabRenameModal(btn.dataset.bookId, b ? b.name : "");
            });
        });
        body.querySelectorAll(".vocab-book-del").forEach(btn => {
            btn.addEventListener("click", async () => {
                const b = vocabBooks.find(x => x.id === btn.dataset.bookId);
                const ok = await showConfirm({
                    title: "删除词书",
                    message: `确定删除「${b ? b.name : ""}」？该词书的复习进度将一并删除。`,
                    okText: "删除",
                    danger: true,
                    icon: "trash-2",
                });
                if (!ok) return;
                try {
                    await api(`/api/vocab/books/${encodeURIComponent(btn.dataset.bookId)}`, { method: "DELETE" });
                } catch (e) {
                    showToast("删除失败：" + ((e && e.message) || e), "error");
                }
                loadVocabHome();
            });
        });
    }
    refreshIcons();
}

// ---------- 闪卡学习 ----------
function showVocabStudy(mode) {
    _vocabStudyMode = mode || "learn";
    showScreen("vocab-study");
    $("#vocab-study-title").textContent = mode === "learn" ? "学习" : "复习";
    $("#vocab-study-book").textContent = vocabSelectedBook ? vocabSelectedBook.name : "--";
    loadVocabStudyCards();
}

function bindVocabStudy() {
    const backBtn = $("#btn-vocab-study-back");
    if (backBtn) backBtn.onclick = showVocabScreen;
    document.querySelectorAll("#vocab-actions .vocab-btn").forEach(btn => {
        btn.onclick = submitVocabReview;
    });
}

async function loadVocabStudyCards() {
    const progress = $("#vocab-study-progress");
    const card = $("#vocab-card");
    const actions = $("#vocab-actions");
    const empty = $("#vocab-study-empty");
    try {
        const data = await api(`/api/vocab/cards?mode=${_vocabStudyMode}&limit=20`);
        _vocabStudyCards = data.cards || [];
        _vocabStudyIndex = 0;
        if (!_vocabStudyCards.length) {
            if (progress) progress.style.display = "none";
            if (card) card.style.display = "none";
            if (actions) actions.style.display = "none";
            if (empty) {
                empty.style.display = "";
                $("#vocab-study-empty-text").textContent =
                    _vocabStudyMode === "learn" ? "没有待学习的新单词。" : "没有到期的复习单词，去学习新词吧";
            }
            return;
        }
        if (empty) empty.style.display = "none";
        if (card) card.style.display = "";
        if (progress) progress.style.display = "";
        renderVocabStudyCard();
    } catch (e) {
        if (card) card.innerHTML = `<div class="vocab-card-empty">加载失败：${e.message}</div>`;
    }
}

function renderVocabStudyCard() {
    const card = _vocabStudyCards[_vocabStudyIndex];
    const el = $("#vocab-card");
    if (!card || !el) return;
    el.classList.remove("flipped");
    el.innerHTML = `
        <div class="vocab-card-inner">
            <div class="vocab-card-face vocab-card-front">
                <div class="vocab-word">${escapeHtml(card.word)}</div>
                ${card.reading ? `<div class="vocab-reading">${escapeHtml(card.reading)}</div>` : ""}
                ${card.pos ? `<span class="vocab-pos">${escapeHtml(card.pos)}</span>` : ""}
                <div class="vocab-card-tip">点击卡片查看释义</div>
            </div>
            <div class="vocab-card-face vocab-card-back">
                <div class="vocab-word">${escapeHtml(card.word)}</div>
                ${card.reading ? `<div class="vocab-reading">${escapeHtml(card.reading)}</div>` : ""}
                <div class="vocab-meaning">${escapeHtml(card.meaning) || "（暂无释义）"}</div>
                ${card.example ? `<div class="vocab-example"><span class="vocab-example-label">例</span>${escapeHtml(card.example)}</div>` : ""}
            </div>
        </div>
    `;
    el.onclick = () => {
        const flipped = el.classList.toggle("flipped");
        $("#vocab-actions").style.display = flipped ? "" : "none";
    };
    $("#vocab-actions").style.display = "none";
    updateVocabStudyProgress();
    refreshIcons();
}

function updateVocabStudyProgress() {
    const text = $("#vocab-progress-text");
    const fill = $("#vocab-progress-fill");
    if (text) text.textContent = `${_vocabStudyIndex + 1} / ${_vocabStudyCards.length}`;
    if (fill) fill.style.width = `${(_vocabStudyIndex / _vocabStudyCards.length) * 100}%`;
}

async function submitVocabReview() {
    const card = _vocabStudyCards[_vocabStudyIndex];
    if (!card) return;
    const q = parseInt(this.dataset.q || "0", 10);
    const bookId = vocabSelectedBook ? vocabSelectedBook.id : "";
    try {
        await api("/api/vocab/review", {
            method: "POST",
            body: JSON.stringify({ book_id: bookId, word: card.word, quality: q }),
        });
    } catch { /* 忽略单卡提交失败，继续下一张 */ }
    _vocabStudyIndex++;
    if (_vocabStudyIndex >= _vocabStudyCards.length) {
        finishVocabStudy();
    } else {
        renderVocabStudyCard();
    }
}

function finishVocabStudy() {
    const el = $("#vocab-card");
    if (el) {
        el.classList.remove("flipped");
        el.innerHTML = `<div class="vocab-card-done"><i data-lucide="party-popper" style="width:36px;height:36px;color:var(--color-primary)"></i>本轮完成！<br><span>本次共学习 ${_vocabStudyCards.length} 个单词</span><br><button class="btn btn-primary btn-sm" id="btn-vocab-again" style="margin-top:12px">再学一轮</button></div>`;
        el.onclick = null;
    }
    $("#vocab-actions").style.display = "none";
    updateVocabStudyProgress();
    const againBtn = $("#btn-vocab-again");
    if (againBtn) againBtn.onclick = () => loadVocabStudyCards();
}

// ---------- 词书详情 ----------
function showVocabDetail() {
    showScreen("vocab-detail");
    const b = vocabSelectedBook;
    $("#vocab-detail-title").textContent = b ? b.name : "词书详情";
    $("#vocab-detail-count").textContent = b ? `共 ${(b.stats && b.stats.total) || 0} 词` : "共 0 词";
    const search = $("#vocab-detail-search");
    if (search) search.value = "";
    loadVocabDetail("");
}

function bindVocabDetail() {
    const backBtn = $("#btn-vocab-detail-back");
    if (backBtn) backBtn.onclick = showVocabScreen;
    const search = $("#vocab-detail-search");
    if (search) {
        let timer = null;
        search.addEventListener("input", () => {
            clearTimeout(timer);
            timer = setTimeout(() => loadVocabDetail(search.value.trim()), 250);
        });
    }
}

async function loadVocabDetail(q) {
    const list = $("#vocab-detail-list");
    if (!list) return;
    const b = vocabSelectedBook;
    if (!b) {
        list.innerHTML = `<p class="input-hint">暂无词书</p>`;
        return;
    }
    list.innerHTML = `<p class="input-hint">加载中...</p>`;
    try {
        const data = await api(`/api/vocab/books/${encodeURIComponent(b.id)}/words?q=${encodeURIComponent(q)}&limit=300`);
        const words = data.words || [];
        if (!words.length) {
            list.innerHTML = `<p class="input-hint">没有匹配的单词</p>`;
            return;
        }
        // AC4：已背 / 未背 分组展示
        const learned = [], unlearned = [];
        words.forEach(w => (w.review_count > 0 ? learned : unlearned).push(w));
        const canDel = !b.builtin;  // 仅用户词书可删词（内置书随辞书资源同步，禁止改动）
        const itemHtml = w => `
            <div class="vocab-detail-item">
                <div class="vocab-detail-word">
                    <span class="vocab-detail-kanji">${escapeHtml(w.word)}</span>
                    ${w.reading ? `<span class="vocab-detail-reading">${escapeHtml(w.reading)}</span>` : ""}
                    ${w.pos ? `<span class="vocab-pos">${escapeHtml(w.pos)}</span>` : ""}
                </div>
                <span class="vocab-detail-meaning">${escapeHtml(w.meaning) || ""}</span>
                <span class="vocab-detail-mastery">${w.review_count > 0 ? Math.round((w.mastery || 0) * 100) + "%" : "未背"}</span>
                ${canDel ? `<button class="btn-icon rd-act-icon vocab-word-del" data-word="${escapeHtml(w.word)}" title="删除单词"><i data-lucide="trash-2" style="width:16px;height:16px"></i></button>` : ""}
            </div>`;
        let html = "";
        if (unlearned.length) {
            html += `<div class="vocab-detail-group"><span>未背</span><em>${unlearned.length}</em></div>`;
            html += unlearned.map(itemHtml).join("");
        }
        if (learned.length) {
            html += `<div class="vocab-detail-group"><span>已背</span><em>${learned.length}</em></div>`;
            html += learned.map(itemHtml).join("");
        }
        list.innerHTML = html;
        refreshIcons();
        if (canDel) {
            $$("#vocab-detail-list .vocab-word-del").forEach(btn => {
                btn.onclick = () => deleteVocabWord(btn.dataset.word);
            });
        }
    } catch (e) {
        list.innerHTML = `<p class="input-hint">加载失败：${e.message}</p>`;
    }
}

async function deleteVocabWord(word) {
    const b = vocabSelectedBook;
    if (!b || b.builtin) return;
    const ok = await showConfirm({
        title: "删除单词",
        message: `从词书「${b.name}」中删除「${word}」？该词的背诵进度会一并删除。`,
        danger: true,
    });
    if (!ok) return;
    try {
        const data = await api(`/api/vocab/books/${encodeURIComponent(b.id)}/words/delete`, {
            method: "POST",
            body: JSON.stringify({ word }),
        });
        showToast(`已删除「${word}」`);
        const count = $("#vocab-detail-count");
        if (count && typeof data.total === "number") count.textContent = `共 ${data.total} 词`;
        const search = $("#vocab-detail-search");
        loadVocabDetail(search ? search.value.trim() : "");
    } catch (e) {
        showToast(e.message || "删除失败", "error");
    }
}

// ---------- 导入弹窗 ----------
function openVocabImportModal() {
    show($("#modal-vocab-import"));
    $("#vocab-import-name").value = "";
    $("#vocab-import-text").value = "";
    $("#vocab-import-file-wrap").style.display = "none";
    $("#vocab-import-text").style.display = "";
    document.querySelectorAll('input[name="vocab-import-mode"]').forEach(r => {
        if (r.value === "text") r.checked = true;
    });
    refreshIcons();
}

function bindVocabImportModal() {
    const modal = $("#modal-vocab-import");
    const closeBtn = $("#btn-vocab-import-close");
    const cancelBtn = $("#btn-vocab-import-cancel");
    if (closeBtn) closeBtn.onclick = () => hide(modal);
    if (cancelBtn) cancelBtn.onclick = () => hide(modal);
    modal.addEventListener("click", (e) => { if (e.target === modal) hide(modal); });
    document.querySelectorAll('input[name="vocab-import-mode"]').forEach(r => {
        r.addEventListener("change", () => {
            const isText = r.value === "text";
            $("#vocab-import-text").style.display = isText ? "" : "none";
            $("#vocab-import-file-wrap").style.display = isText ? "none" : "";
        });
    });
    const confirmBtn = $("#btn-vocab-import-confirm");
    if (confirmBtn) confirmBtn.onclick = submitVocabImport;
}

async function submitVocabImport() {
    const name = $("#vocab-import-name").value.trim();
    const useForPractice = $("#vocab-import-practice").checked;
    const modeEl = document.querySelector('input[name="vocab-import-mode"]:checked');
    const mode = (modeEl && modeEl.value) || "text";
    try {
        if (mode === "file") {
            const fileInput = $("#vocab-import-file");
            const file = fileInput.files && fileInput.files[0];
            if (!file) { showToast("请先选择要导入的文件", "error"); return; }
            const j = await apiUpload("/api/vocab/import_apkg", file, {
                name: name || (file.name || "").replace(/\.[^.]+$/, "") || "Anki 导入词书",
                use_for_practice: String(useForPractice),
            });
            if (!j || !j.success) throw new Error((j && j.error) || "导入失败");
            showToast(`导入成功：新增 ${j.added} 词（跳过 ${j.skipped || 0} 条非日文/重复）`, "success");
        } else {
            const text = $("#vocab-import-text").value;
            const j = await api("/api/vocab/import", {
                method: "POST",
                body: JSON.stringify({ name, use_for_practice: useForPractice, text }),
            });
            if (j.success === false) throw new Error(j.error || "导入失败");
            showToast(`导入成功：新增 ${j.added} 词（${j.created ? "新建词书" : "已合并进同名词书"}）`, "success");
        }
        hide($("#modal-vocab-import"));
        await loadVocabHome();
    } catch (e) {
        showToast("导入失败：" + ((e && e.message) || e), "error");
    }
}

// ---------- 练习页：从词书选词弹窗（两步骤：先选书，再选这本书的词） ----------
async function openVocabPickModal() {
    if (!vocabBooks.length) {
        try {
            const data = await api("/api/vocab/books");
            vocabBooks = Object.values(data.books || {});
        } catch (e) {
            showToast("加载词书失败：" + ((e && e.message) || e), "error");
            return;
        }
    }
    if (!vocabBooks.length) {
        showToast("还没有词书，请先到「单词」页导入词书");
        return;
    }
    bindVocabPickModal();   // 练习页直接打开时兜底绑定（initVocabScreen 仅在单词页首次访问时触发）
    _vocabPickSelected = new Set((practiceVocabWords || []).map(w => w.word));
    show($("#modal-vocab-pick"));
    // 有预选且所属词书仍存在 → 直接进该书选词；否则从选书开始
    const sourceBook = practiceVocabBookId && vocabBooks.find(b => b.id === practiceVocabBookId);
    if (sourceBook) {
        enterVocabPickStep2(sourceBook.id);
    } else {
        enterVocabPickStep1();
    }
    refreshIcons();
}

function enterVocabPickStep1() {
    _vocabPickBookId = "";
    const s1 = $("#vocab-pick-step1");
    const s2 = $("#vocab-pick-step2");
    if (s1) s1.style.display = "";
    if (s2) s2.style.display = "none";
    renderVocabPickBookList();
    refreshIcons();
}

function renderVocabPickBookList() {
    const list = $("#vocab-pick-booklist");
    if (!list) return;
    if (!vocabBooks.length) {
        list.innerHTML = `<p class="input-hint">还没有词书，请先到「单词」页导入词书</p>`;
        return;
    }
    const sourceId = practiceVocabBookId && vocabBooks.some(b => b.id === practiceVocabBookId) ? practiceVocabBookId : "";
    // 开启「用于出题」的词书排前面
    const sorted = [...vocabBooks].sort((a, b) => (b.use_for_practice ? 1 : 0) - (a.use_for_practice ? 1 : 0));
    list.innerHTML = sorted.map(b => {
        const st = b.stats || { total: 0 };
        const isSource = b.id === sourceId;
        return `
            <div class="vocab-pick-book ${isSource ? "active" : ""}" data-book-id="${b.id}" role="button" title="选择这本词书">
                <div class="vocab-pick-book-info">
                    <span class="vocab-pick-book-name">${escapeHtml(b.name)}</span>
                    <span class="vocab-pick-book-meta">${st.total} 词${b.builtin ? " · 内置" : ""}${isSource ? ` · 已选 ${practiceVocabWords.length} 词` : ""}</span>
                </div>
                ${b.use_for_practice ? `<em class="vocab-pick-tag">用于出题</em>` : ""}
                <i data-lucide="chevron-right" style="width:16px;height:16px;color:var(--text-tertiary)"></i>
            </div>
        `;
    }).join("");
    list.querySelectorAll(".vocab-pick-book").forEach(row => {
        row.addEventListener("click", () => enterVocabPickStep2(row.dataset.bookId));
    });
    refreshIcons();
}

function enterVocabPickStep2(bookId) {
    // Beta 6.0：默认全不选（删除默认全选逻辑）；重进原词书时保留已有预选（_vocabPickSelected 不动）
    _vocabPickBookId = bookId;
    _vocabPickWordMeta.clear();
    const s1 = $("#vocab-pick-step1");
    const s2 = $("#vocab-pick-step2");
    if (s1) s1.style.display = "none";
    if (s2) s2.style.display = "";
    const b = vocabBooks.find(x => x.id === bookId);
    const nameEl = $("#vocab-pick-bookname");
    if (nameEl) nameEl.textContent = b ? b.name : "";
    const search = $("#vocab-pick-search");
    if (search) search.value = "";
    renderVocabPickList("");
    refreshIcons();
}

function bindVocabPickModal() {
    if (_vocabPickBound) return;   // 幂等：仅绑定一次，避免 addEventListener 重复叠加
    _vocabPickBound = true;
    const modal = $("#modal-vocab-pick");
    const closeBtn = $("#btn-vocab-pick-close");
    const cancelBtn = $("#btn-vocab-pick-cancel");
    const backBtn = $("#btn-vocab-pick-back");
    if (closeBtn) closeBtn.onclick = () => hide(modal);
    if (cancelBtn) cancelBtn.onclick = () => hide(modal);
    if (backBtn) backBtn.onclick = enterVocabPickStep1;
    modal.addEventListener("click", (e) => { if (e.target === modal) hide(modal); });
    const search = $("#vocab-pick-search");
    if (search) search.addEventListener("input", () => renderVocabPickList(search.value.trim()));
    const allBtn = $("#btn-vocab-pick-all");
    if (allBtn) allBtn.onclick = () => {
        // Beta 6.0：「选前 30」— 受 MAX_PRACTICE_WORDS 上限约束
        document.querySelectorAll("#vocab-pick-list input[type=checkbox]").forEach(cb => {
            if (_vocabPickSelected.size >= MAX_PRACTICE_WORDS) return;
            cb.checked = true;
            _vocabPickSelected.add(cb.value);
        });
        refreshVocabPickDisabled();
        updateVocabPickCount();
    };
    const noneBtn = $("#btn-vocab-pick-none");
    if (noneBtn) noneBtn.onclick = () => {
        document.querySelectorAll("#vocab-pick-list input[type=checkbox]").forEach(cb => {
            cb.checked = false;
            cb.disabled = false;
            _vocabPickSelected.delete(cb.value);
        });
        refreshVocabPickDisabled();
        updateVocabPickCount();
    };
    const confirmBtn = $("#btn-vocab-pick-confirm");
    if (confirmBtn) confirmBtn.onclick = () => {
        // Beta 6.0：全字段传词（{word, reading, meaning}），后端 prompt 全量注入
        practiceVocabWords = _vocabPickSelected.size
            ? [..._vocabPickSelected].map(word => _vocabPickWordMeta.get(word) || { word })
            : [];
        practiceVocabBookId = practiceVocabWords.length ? _vocabPickBookId : "";
        if (practiceVocabWords.length) practiceVocabSource = "book";
        const countEl = $("#vocab-source-book-count");
        if (countEl) countEl.textContent = `已选 ${practiceVocabWords.length} 词`;
        hide(modal);
    };
}

/** Beta 6.0：按已选数量刷新禁用态（勾满 30 后未选项禁用）与上限提示。 */
function refreshVocabPickDisabled() {
    const full = _vocabPickSelected.size >= MAX_PRACTICE_WORDS;
    document.querySelectorAll("#vocab-pick-list input[type=checkbox]").forEach(cb => {
        if (!_vocabPickSelected.has(cb.value)) cb.disabled = full;
    });
    const hint = $("#vocab-pick-limit-hint");
    if (hint) hint.style.display = full ? "" : "none";
}

async function renderVocabPickList(q) {
    const list = $("#vocab-pick-list");
    if (!list) return;
    if (!_vocabPickBookId) return;
    list.innerHTML = `<p class="input-hint">加载中...</p>`;
    try {
        // 只取当前这本书的词（不支持跨词书）
        const data = await api(`/api/vocab/books/${encodeURIComponent(_vocabPickBookId)}/words?q=${encodeURIComponent(q)}&limit=500`);
        const words = data.words || [];
        if (!words.length) {
            list.innerHTML = `<p class="input-hint">没有匹配的单词</p>`;
            updateVocabPickCount();
            return;
        }
        // Beta 6.0：默认全不选；勾满 MAX_PRACTICE_WORDS 后其余 checkbox 禁用
        words.forEach(w => _vocabPickWordMeta.set(w.word, { word: w.word, reading: w.reading || "", meaning: w.meaning || "" }));
        list.innerHTML = words.map(w => {
            const checked = _vocabPickSelected.has(w.word);
            const disabled = !checked && _vocabPickSelected.size >= MAX_PRACTICE_WORDS;
            return `
            <label class="vocab-pick-item">
                <input type="checkbox" value="${escapeHtml(w.word)}" ${checked ? "checked" : ""}${disabled ? " disabled" : ""}>
                <span class="vocab-pick-word">${escapeHtml(w.word)}</span>
                ${w.reading ? `<span class="vocab-pick-reading">${escapeHtml(w.reading)}</span>` : ""}
                <span class="vocab-pick-meaning">${escapeHtml(w.meaning) || ""}</span>
            </label>
        `;}).join("");
        list.querySelectorAll("input[type=checkbox]").forEach(cb => {
            cb.addEventListener("change", () => {
                if (cb.checked) {
                    if (_vocabPickSelected.size >= MAX_PRACTICE_WORDS) { cb.checked = false; return; }   // 上限兜底
                    _vocabPickSelected.add(cb.value);
                }
                else _vocabPickSelected.delete(cb.value);
                refreshVocabPickDisabled();
                updateVocabPickCount();
            });
        });
        refreshVocabPickDisabled();   // 预选项可能已满 30，初始渲染即应用禁用态
        updateVocabPickCount();
    } catch (e) {
        list.innerHTML = `<p class="input-hint">加载失败：${e.message}</p>`;
    }
}

function updateVocabPickCount() {
    const all = document.querySelectorAll("#vocab-pick-list input[type=checkbox]");
    const checked = document.querySelectorAll("#vocab-pick-list input[type=checkbox]:checked");
    const countEl = $("#vocab-pick-count");
    if (countEl) countEl.textContent = `${checked.length} / ${all.length} 已选`;
}

// ---------- 练习页：出题词源三态 ----------
function onVocabSourceChange() {
    const v = $("#vocab-source-select").value;
    practiceVocabSource = v;
    const bookPanel = $("#vocab-source-book");
    const inputPanel = $("#vocab-source-input");
    if (bookPanel) bookPanel.style.display = v === "book" ? "" : "none";
    if (inputPanel) inputPanel.style.display = v === "input" ? "" : "none";
    if (v === "book") {
        const countEl = $("#vocab-source-book-count");
        if (countEl) countEl.textContent = `已选 ${practiceVocabWords.length} 词`;
    }
}

// ============================================================
// 学习数据可视化（Beta 7.0 M4：设置页卡3 四个可折叠图块）
// 数据源 /api/stats/visualization（零 LLM 成本本地聚合）；渲染纯 SVG 手写，零新增依赖
// ============================================================
const STATS_PALETTE = ["#F00000", "#2E6FD8", "#1FA65B", "#E09A00", "#9A5CE0", "#00A3BF"];
const STATS_BLOCKS = [
    { key: "trend", title: "正确率趋势", icon: "trending-up" },
    { key: "weak", title: "薄弱语法排行", icon: "target" },
    { key: "queue", title: "复习队列预测", icon: "calendar-clock" },
    { key: "vocab", title: "词汇量增长", icon: "languages" },
];

/** 渲染四个图块外壳（默认展开第一块）并拉取数据填充。 */
async function loadStatsPanels() {
    const root = $("#stats-panels");
    if (!root) return;
    root.innerHTML = STATS_BLOCKS.map((b, i) => `
        <div class="card stats-block${i === 0 ? " open" : ""}" data-stats-key="${b.key}">
            <div class="stats-block-header" role="button" tabindex="0">
                <i data-lucide="${b.icon}" class="stats-block-icon"></i><span>${b.title}</span>
                <i data-lucide="chevron-down" class="stats-block-chevron"></i>
            </div>
            <div class="stats-block-body"><p class="input-hint">加载中...</p></div>
        </div>`).join("");
    refreshIcons();
    root.querySelectorAll(".stats-block-header").forEach(h => {
        h.onclick = () => h.closest(".stats-block").classList.toggle("open");
    });
    let data;
    try {
        data = await api("/api/stats/visualization");
    } catch (e) {
        root.querySelectorAll(".stats-block-body").forEach(b => {
            b.innerHTML = `<p class="input-hint">加载失败：${escapeHtml(e.message || "")}</p>`;
        });
        return;
    }
    renderStatsTrend(data.trend);
    renderStatsWeak(data.weak_points);
    renderStatsQueue(data.review_queue);
    renderStatsVocab(data.vocab_growth);
}

function _statsBody(key) {
    return document.querySelector(`[data-stats-key="${key}"] .stats-block-body`);
}

function _svgLinePath(points) {
    return points.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
}

/** 图1：近 30 天正确率折线 + 答题量柱（双轴：线 0~100%，柱按最大值归一）。 */
function renderStatsTrend(trend) {
    const body = _statsBody("trend");
    if (!body) return;
    const days = (trend && trend.days) || [];
    if (!days.length) {
        body.innerHTML = `<p class="input-hint">还没有练习记录，先去练几题再来回看吧</p>`;
        return;
    }
    const W = 640, H = 220, padL = 36, padR = 10, padT = 14, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxTotal = Math.max(...days.map(d => d.total));
    const n = days.length, step = plotW / n;
    const barW = Math.max(4, Math.min(18, step * 0.5));
    let svg = "";
    [0, 50, 100].forEach(v => {
        const y = padT + plotH * (1 - v / 100);
        svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border-light)" stroke-width="1"/>` +
            `<text x="${padL - 6}" y="${y + 4}" font-size="10" fill="var(--text-tertiary)" text-anchor="end">${v}%</text>`;
    });
    days.forEach((d, i) => {
        if (!d.total) return;
        const x = padL + step * i + (step - barW) / 2;
        const h = plotH * (d.total / maxTotal) * 0.9;
        svg += `<rect x="${x.toFixed(1)}" y="${(padT + plotH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="var(--color-primary)" opacity="0.25"><title>${d.date}：${d.total} 题，答对 ${d.correct}</title></rect>`;
    });
    const pts = days.map((d, i) => [padL + step * i + step / 2, padT + plotH * (1 - d.rate / 100)]);
    svg += `<path d="${_svgLinePath(pts)}" fill="none" stroke="var(--color-primary)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach((p, i) => {
        svg += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="var(--color-primary)"><title>${days[i].date}：正确率 ${days[i].rate}%</title></circle>`;
    });
    svg += `<text x="${padL}" y="${H - 8}" font-size="10" fill="var(--text-tertiary)">${days[0].date.slice(5)}</text>` +
        `<text x="${W - padR}" y="${H - 8}" font-size="10" fill="var(--text-tertiary)" text-anchor="end">${days[n - 1].date.slice(5)}</text>`;
    body.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="近30天正确率趋势">${svg}</svg>
        <div class="stats-legend"><span><i class="stats-dot" style="background:var(--color-primary)"></i>正确率</span><span><i class="stats-dot stats-dot-bar"></i>答题量</span></div>`;
}

/** 图2：薄弱语法排行（正确率升序 top5 红标 + 去练习 focus_tags 桥接）。 */
function renderStatsWeak(points) {
    const body = _statsBody("weak");
    if (!body) return;
    if (!points || !points.length) {
        body.innerHTML = `<p class="input-hint">暂无薄弱点数据，先去练几题吧</p>`;
        return;
    }
    body.innerHTML = `<div class="stats-weak-list">` + points.map(p => `
        <div class="stats-weak-row">
            <span class="stats-weak-name" title="${escapeHtml(p.point)}">${escapeHtml(p.point)}</span>
            <span class="stats-weak-bar"><i style="width:${Math.max(2, p.rate)}%"></i></span>
            <span class="stats-weak-rate">${p.total ? `${p.rate}%` : "—"}<small>${p.total ? ` ${p.correct}/${p.total}` : ""}${p.wrong_count ? ` · 错 ${p.wrong_count}` : ""}</small></span>
        </div>`).join("") + `</div>`;
}

/** 图3：未来 7 天 SM-2 到期量柱状（hover 显日期明细，已到期并入今天）。 */
function renderStatsQueue(queue) {
    const body = _statsBody("queue");
    if (!body) return;
    const days = queue || [];
    if (!days.reduce((s, d) => s + d.count, 0)) {
        body.innerHTML = `<p class="input-hint">暂无待复习知识点，保持练习节奏吧</p>`;
        return;
    }
    const W = 640, H = 180, padL = 10, padR = 10, padT = 22, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxC = Math.max(...days.map(d => d.count));
    const step = plotW / days.length;
    const barW = Math.min(36, step * 0.5);
    let svg = "";
    days.forEach((d, i) => {
        const cx = padL + step * i + step / 2;
        const h = maxC ? plotH * (d.count / maxC) : 0;
        if (d.count) {
            const tip = d.points.slice(0, 5).join("、") + (d.points.length > 5 ? " 等" : "");
            svg += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${(padT + plotH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 2).toFixed(1)}" rx="4" fill="var(--color-primary)"><title>${d.date}（${d.count} 个）：${escapeHtml(tip)}</title></rect>` +
                `<text x="${cx.toFixed(1)}" y="${(padT + plotH - h - 6).toFixed(1)}" font-size="11" font-weight="700" fill="var(--text-primary)" text-anchor="middle">${d.count}</text>`;
        } else {
            svg += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${padT + plotH}" width="${barW.toFixed(1)}" height="2" rx="1" fill="var(--border-light)"/>`;
        }
        svg += `<text x="${cx.toFixed(1)}" y="${H - 8}" font-size="10" fill="var(--text-tertiary)" text-anchor="middle">${i === 0 ? "今天" : d.date.slice(5)}</text>`;
    });
    body.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="未来7天复习到期量">${svg}</svg>`;
}

/** 图4：已背词累计曲线（按词书分色，最多展示 6 本）+ 近 30 天新增/复习量。 */
function renderStatsVocab(g) {
    const body = _statsBody("vocab");
    if (!body) return;
    const days = (g && g.days) || [];
    const books = ((g && g.books) || []).filter(b => (b.cumulative[b.cumulative.length - 1] || 0) > 0).slice(0, 6);
    const newSum = ((g && g.daily_new) || []).reduce((a, b) => a + b, 0);
    const revSum = ((g && g.daily_review) || []).reduce((a, b) => a + b, 0);
    if (!books.length) {
        body.innerHTML = `<p class="input-hint">还没有背诵记录，去背单词页开始学习吧</p>`;
        return;
    }
    const W = 640, H = 200, padL = 36, padR = 10, padT = 12, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxY = Math.max(...books.map(b => b.cumulative[b.cumulative.length - 1] || 0), 1);
    const n = days.length;
    let svg = "";
    [0, 0.5, 1].forEach(f => {
        const y = padT + plotH * (1 - f);
        svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border-light)" stroke-width="1"/>` +
            `<text x="${padL - 6}" y="${y + 4}" font-size="10" fill="var(--text-tertiary)" text-anchor="end">${Math.round(maxY * f)}</text>`;
    });
    books.forEach((b, bi) => {
        const color = STATS_PALETTE[bi % STATS_PALETTE.length];
        const pts = b.cumulative.map((v, i) => [padL + plotW * (i / (n - 1)), padT + plotH * (1 - v / maxY)]);
        svg += `<path d="${_svgLinePath(pts)}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    });
    svg += `<text x="${padL}" y="${H - 8}" font-size="10" fill="var(--text-tertiary)">${days[0].slice(5)}</text>` +
        `<text x="${W - padR}" y="${H - 8}" font-size="10" fill="var(--text-tertiary)" text-anchor="end">${days[n - 1].slice(5)}</text>`;
    const legend = books.map((b, bi) =>
        `<span><i class="stats-dot" style="background:${STATS_PALETTE[bi % STATS_PALETTE.length]}"></i>${escapeHtml(b.name)}</span>`).join("");
    body.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="已背词累计曲线">${svg}</svg>
        <div class="stats-legend">${legend}</div>
        <p class="input-hint">近 30 天新增 ${newSum} 词 · 复习 ${revSum} 词次</p>`;
}

// 设置页面
function showSettingsScreen() {
    showScreen("settings");
    setDockActive("settings");

    const card = $("#screen-settings #settings-card");
    if (!card) return;
    card.innerHTML = `
        <!-- 卡 1：通用设置（AI 服务 / 复习融合 / 显示模式 / 帮助入口） -->
        <div class="card config-card" data-glow>
            <div class="config-card-header">
                <i data-lucide="settings" style="width:18px;height:18px"></i>
                <span>通用设置</span>
            </div>
            <div class="settings-list">
                <!-- AI 服务合并卡：厂商 + Key + 当前模型（只读行并入，消灭「使用模型」假设置） -->
                <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:var(--space-md)">
                    <div class="settings-item-title"><i data-lucide="key" style="width:18px;height:18px;color:var(--color-primary)"></i> AI 服务</div>
                    <div class="config-card-grid">
                        <div class="config-card-field">
                            <label class="config-card-label">厂商</label>
                            <select id="settings-provider" class="input"></select>
                        </div>
                        <div class="config-card-field">
                            <label class="config-card-label">当前模型</label>
                            <div class="settings-model-value" id="settings-model-name">--</div>
                        </div>
                    </div>
                    <div class="config-card-field">
                        <label class="config-card-label">API Key</label>
                        <input type="password" id="settings-apikey-input" class="input" placeholder="请输入 API Key" autocomplete="off">
                        <div class="settings-item-desc" id="settings-apikey-desc">Key 仅保存在本地，不会上传</div>
                        <p id="apikey-error" class="error-text" style="display:none;"></p>
                    </div>
                    <div style="display:flex;justify-content:flex-end">
                        <button class="btn btn-primary btn-sm" id="btn-save-apikey">保存并验证</button>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-title"><i data-lucide="refresh-cw" style="width:18px;height:18px;color:var(--color-primary)"></i> 练习时融入复习题</div>
                        <div class="settings-item-desc">练习中自动混入到期复习语法点，答对即时更新记忆曲线</div>
                    </div>
                    <label class="toggle-label">
                        <input type="checkbox" id="settings-mix-review-toggle" ${AppState.config.practice_mix_review ? "checked" : ""}>
                    </label>
                </div>
                <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:var(--space-sm)">
                    <div class="settings-item-title"><i data-lucide="sun-moon" style="width:18px;height:18px"></i> 显示模式</div>
                    <div class="theme-toggle">
                        <button class="theme-option" data-theme-val="light"><i data-lucide="sun" style="width:14px;height:14px"></i> 浅色</button>
                        <button class="theme-option" data-theme-val="auto"><i data-lucide="refresh-cw" style="width:14px;height:14px"></i> 自动</button>
                        <button class="theme-option" data-theme-val="dark"><i data-lucide="moon" style="width:14px;height:14px"></i> 深色</button>
                    </div>
                </div>
                <div class="settings-item clickable" id="settings-privacy">
                    <div class="settings-item-info">
                        <div class="settings-item-title"><i data-lucide="shield" style="width:18px;height:18px"></i> 隐私政策</div>
                        <div class="settings-item-desc">了解我们如何保护你的数据</div>
                    </div>
                    <i data-lucide="chevron-right" style="width:16px;height:16px;color:var(--text-tertiary)"></i>
                </div>
                <div class="settings-item clickable" id="settings-guide">
                    <div class="settings-item-info">
                        <div class="settings-item-title"><i data-lucide="book-open" style="width:18px;height:18px"></i> 使用说明</div>
                        <div class="settings-item-desc">快速上手 KOTOBA·AI 的使用流程</div>
                    </div>
                    <i data-lucide="chevron-right" style="width:16px;height:16px;color:var(--text-tertiary)"></i>
                </div>
                <div class="settings-item clickable" id="settings-roadmap">
                    <div class="settings-item-info">
                        <div class="settings-item-title"><i data-lucide="map" style="width:18px;height:18px"></i> 开发路线图</div>
                        <div class="settings-item-desc">查看未来版本的开发计划</div>
                    </div>
                    <i data-lucide="chevron-right" style="width:16px;height:16px;color:var(--text-tertiary)"></i>
                </div>
            </div>
        </div>
        <!-- 卡 2：数据管理（导出导入 / 去重 / 数据目录 / 清除） -->
        <div class="card config-card" data-glow>
            <div class="config-card-header">
                <i data-lucide="database" style="width:18px;height:18px"></i>
                <span>数据管理</span>
            </div>
            <div class="settings-list">
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-title"><i data-lucide="hard-drive" style="width:18px;height:18px"></i> 学习数据备份</div>
                        <div class="settings-item-desc">导出全部学习数据，更新版本或换机时导入恢复</div>
                    </div>
                    <div class="settings-data-actions">
                        <button class="btn btn-secondary btn-sm" id="btn-data-export"><i data-lucide="download" style="width:14px;height:14px"></i> 导出</button>
                        <button class="btn btn-secondary btn-sm" id="btn-data-import"><i data-lucide="upload" style="width:14px;height:14px"></i> 导入</button>
                        <input type="file" id="data-import-input" accept=".json,application/json" style="display:none">
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-title"><i data-lucide="file-text" style="width:18px;height:18px"></i> 导出日志</div>
                        <div class="settings-item-desc">遇到报错时导出日志反馈给开发者，帮助定位问题</div>
                    </div>
                    <button class="btn btn-secondary btn-sm" id="btn-logs-export"><i data-lucide="download" style="width:14px;height:14px"></i> 导出</button>
                </div>
                <div class="settings-item clickable" id="settings-merge-duplicates">
                    <div class="settings-item-info">
                        <div class="settings-item-title"><i data-lucide="git-merge" style="width:18px;height:18px"></i> 知识点去重</div>
                        <div class="settings-item-desc" id="settings-merge-duplicates-desc">检查并合并重复语法点</div>
                    </div>
                    <i data-lucide="chevron-right" style="width:16px;height:16px;color:var(--text-tertiary)"></i>
                </div>
                <div class="settings-item" id="settings-data-dir-item" style="flex-direction:column;align-items:stretch;gap:var(--space-sm)">
                    <div class="settings-item-title"><i data-lucide="folder" style="width:18px;height:18px"></i> 数据目录</div>
                    <div class="settings-item-desc" id="settings-data-dir-desc" style="word-break:break-all">加载中...</div>
                    <div style="display:flex;gap:8px;justify-content:flex-end" id="settings-data-dir-actions">
                        <button class="btn btn-secondary btn-sm" id="btn-open-data-dir"><i data-lucide="external-link" style="width:14px;height:14px"></i> 打开文件夹</button>
                        <button class="btn btn-secondary btn-sm" id="btn-change-data-dir"><i data-lucide="folder-cog" style="width:14px;height:14px"></i> 更改目录</button>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-title"><i data-lucide="trash-2" style="width:18px;height:18px;color:var(--color-danger)"></i> 清除数据</div>
                        <div class="settings-item-desc">清除 API Key、答题进度、知识库等所有本地数据</div>
                    </div>
                    <button class="btn btn-danger btn-sm" id="btn-clear-data">清除</button>
                </div>
            </div>
        </div>
        <!-- 卡 3：学习进度（打卡 / 复习计划 / 学习记录入口） -->
        <div class="card config-card" data-glow>
            <div class="config-card-header">
                <i data-lucide="bar-chart-3" style="width:18px;height:18px"></i>
                <span>学习进度</span>
            </div>
            <div class="checkin-calendar card" id="checkin-calendar" style="margin-bottom:var(--space-md)">
                <div class="checkin-cal-header">
                    <div class="checkin-stats-row">
                        <div class="checkin-stat-badge">
                            <i data-lucide="flame" style="width:22px;height:22px;color:var(--color-warning)"></i>
                            <div class="checkin-stat-info">
                                <span class="checkin-stat-num" id="cal-streak-num">--</span>
                                <span class="checkin-stat-label">连续学习</span>
                            </div>
                        </div>
                        <div class="checkin-stat-badge">
                            <i data-lucide="calendar-check" style="width:22px;height:22px;color:var(--color-primary)"></i>
                            <div class="checkin-stat-info">
                                <span class="checkin-stat-num" id="cal-month-num">--</span>
                                <span class="checkin-stat-label">本月累计</span>
                            </div>
                        </div>
                    </div>
                    <div class="checkin-month-nav">
                        <button class="checkin-nav-btn" id="cal-prev-month"><i data-lucide="chevron-left" style="width:16px;height:16px"></i></button>
                        <span class="checkin-month-label" id="cal-month-label">2026年8月</span>
                        <button class="checkin-nav-btn" id="cal-next-month"><i data-lucide="chevron-right" style="width:16px;height:16px"></i></button>
                    </div>
                </div>
                <div class="checkin-weekdays">
                    <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
                </div>
                <div class="checkin-grid" id="checkin-grid"></div>
            </div>
            <div class="review-plan card" id="review-plan" style="margin-bottom:var(--space-md)">
                <div class="review-plan-header" id="review-plan-header" role="button" tabindex="0" title="点击查看完整复习计划">
                    <i data-lucide="brain" style="width:18px;height:18px;color:var(--color-primary)"></i>
                    <span>复习计划</span>
                    <span class="review-plan-badge" id="review-plan-badge" style="display:none"></span>
                    <i data-lucide="chevron-right" id="review-plan-chevron" class="review-plan-chevron" style="width:16px;height:16px;color:var(--text-tertiary)"></i>
                </div>
                <div class="review-plan-list" id="review-plan-list">
                    <p class="review-plan-empty">加载中...</p>
                </div>
            </div>
            <div class="settings-list">
                <div class="settings-item clickable" id="settings-vocab">
                    <div class="settings-item-info">
                        <div class="settings-item-title"><i data-lucide="languages" style="width:18px;height:18px"></i> 单词</div>
                        <div class="settings-item-desc" id="settings-vocab-desc">词书 · 背诵进度</div>
                    </div>
                    <i data-lucide="chevron-right" style="width:16px;height:16px;color:var(--text-tertiary)"></i>
                </div>
                <div class="settings-item clickable" id="settings-wrong">
                    <div class="settings-item-info">
                        <div class="settings-item-title"><i data-lucide="edit-3" style="width:18px;height:18px"></i> 错题本</div>
                        <div class="settings-item-desc">查看和复习做错的题目</div>
                    </div>
                    <i data-lucide="chevron-right" style="width:16px;height:16px;color:var(--text-tertiary)"></i>
                </div>
                <div class="settings-item clickable" id="settings-history">
                    <div class="settings-item-info">
                        <div class="settings-item-title"><i data-lucide="clipboard-list" style="width:18px;height:18px"></i> 历史记录</div>
                        <div class="settings-item-desc">查看过往练习记录</div>
                    </div>
                    <i data-lucide="chevron-right" style="width:16px;height:16px;color:var(--text-tertiary)"></i>
                </div>
            </div>
            <!-- Beta 7.0 M4：学习数据可视化四图块（JS 渲染，纯 SVG 零依赖） -->
            <div id="stats-panels"></div>
        </div>
    `;
    refreshIcons();

    // 学习进度卡：单词 / 打卡日历 / 复习计划 / 错题本 / 历史
    renderCheckinCalendar();
    loadReviewPlan();
    loadStatsPanels();
    const vocabEntry = $("#settings-vocab");
    if (vocabEntry) {
        vocabEntry.onclick = showVocabScreen;
        loadVocabSettingsSummary();
    }
    const wrongEntry = $("#settings-wrong");
    if (wrongEntry) wrongEntry.onclick = initWrongBookScreen;
    const historyEntry = $("#settings-history");
    if (historyEntry) historyEntry.onclick = initHistoryScreen;
    // 数据管理卡：知识点去重 / 导出导入 / 导出日志
    const mergeEntry = $("#settings-merge-duplicates");
    if (mergeEntry) mergeEntry.onclick = checkAndShowDuplicates;
    bindDataExportImport();
    const logsExportBtn = $("#btn-logs-export");
    if (logsExportBtn) {
        logsExportBtn.onclick = async () => {
            try {
                await downloadFile("/api/logs/export");
                showToast("日志已导出", "success");
            } catch (e) {
                showToast(e.message || "日志导出失败", "error");
            }
        };
    }

    // 多模型支持（功能1）：厂商下拉 + 各厂商 key 独立保存（暂不支持 Pro / 自定义，模型跟随厂商固定）
    const apikeyInput = $("#settings-apikey-input");
    const providerSel = $("#settings-provider");
    const apikeyDesc = $("#settings-apikey-desc");
    const providers = AppState.config.providers || [];

    function settingsProviderObj() {
        return providers.find(p => p.id === AppState.config.provider) || providers[0] || null;
    }

    function renderSettingsProviderUI() {
        if (providerSel) {
            providerSel.innerHTML = providers.map(p =>
                `<option value="${p.id}">${p.name}</option>`).join("");
        }
        const cur = settingsProviderObj();
        if (!cur) return;
        if (providerSel) providerSel.value = cur.id;
        const nameEl = $("#settings-model-name");
        if (nameEl && cur.default_model) nameEl.textContent = cur.default_model;
    }

    // 切换厂商：刷新 key 输入框、获取链接与当前模型名；模型跟随厂商保存（防模型名漂移）
    function syncSettingsProvider(pid) {
        if (!pid) return;
        AppState.config.provider = pid;
        const prov = providers.find(p => p.id === pid) || settingsProviderObj();
        if (providerSel) providerSel.value = pid;
        const nameEl = $("#settings-model-name");
        if (nameEl && prov) nameEl.textContent = prov.default_model || "";
        const keys = AppState.config.provider_keys || {};
        if (apikeyInput) apikeyInput.value = keys[pid] || "";
        if (apikeyDesc && prov) {
            const url = prov.key_url || "#";
            apikeyDesc.innerHTML = `在 <a href="${url}" target="_blank" rel="noopener">${prov.name} 平台</a> 获取，Key 仅保存在本地，不会上传`;
        }
    }

    renderSettingsProviderUI();
    // 初始填充：当前厂商 key + 获取链接
    {
        const cur = settingsProviderObj();
        // key 按「界面当前厂商」从 provider_keys 取。顶层 config.api_key 是 GET
        // /api/config 返回的「配置文件当前厂商」的 key——切过厂商后（如切到未存
        // key 的 gemini）会变成空串，导致设置页打开时输入框空白、手动切走再切回
        // 才显示（syncSettingsProvider 走的正是 provider_keys）。两者对齐。
        const keys = AppState.config.provider_keys || {};
        if (apikeyInput) {
            apikeyInput.value = (cur && keys[cur.id]) || AppState.config.api_key || "";
        }
        if (apikeyDesc && cur) {
            const url = cur.key_url || "#";
            apikeyDesc.innerHTML = `在 <a href="${url}" target="_blank" rel="noopener">${cur.name} 平台</a> 获取，Key 仅保存在本地，不会上传`;
        }
    }

    if (providerSel) {
        providerSel.onchange = () => {
            const pid = providerSel.value;
            syncSettingsProvider(pid);
            const prov = providers.find(p => p.id === pid) || settingsProviderObj();
            saveConfig({ provider: pid, model: (prov && prov.default_model) || "" }).catch(() => {});
        };
    }

    // 保存 API Key 按钮：先验证，再保存；失败给出具体原因
    const saveBtn = $("#btn-save-apikey");
    if (saveBtn) saveBtn.onclick = async () => {
        const key = apikeyInput ? apikeyInput.value.trim() : "";
        if (!key) {
            showError("apikey-error", "请输入 API Key");
            return;
        }
        const pid = AppState.config.provider || "deepseek";
        const prov = providers.find(p => p.id === pid) || settingsProviderObj();
        saveBtn.disabled = true;
        saveBtn.textContent = "验证中...";
        try {
            // 1) 验证 key 是否可用
            const v = await api("/api/validate_key", {
                method: "POST",
                body: JSON.stringify({ provider: pid, api_key: key }),
            });
            if (!v.valid) {
                showError("apikey-error", v.error || "API Key 验证失败");
                return;
            }
            // 2) 验证通过再保存
            await saveConfig({ provider: pid, api_key: key });
            // 同步前端状态，避免切换厂商后 has_api_key 误判
            if (!AppState.config.provider_keys) AppState.config.provider_keys = {};
            AppState.config.provider_keys[pid] = key;
            AppState.config.api_key = key;
            hide($("#apikey-error"));
            if (apikeyInput) apikeyInput.value = key;
            showToast(`API Key 已保存（${prov ? prov.name : pid} 验证通过）`, "success");
        } catch (err) {
            showError("apikey-error", err.message || "保存失败，请检查网络连接");
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = "保存";
        }
    };

    // 复习融合整改：「练习时融入复习题」开关
    const mixReviewToggle = $("#settings-mix-review-toggle");
    if (mixReviewToggle) {
        mixReviewToggle.onchange = async () => {
            try {
                await saveConfig({ practice_mix_review: mixReviewToggle.checked });
                AppState.config.practice_mix_review = mixReviewToggle.checked;
            } catch { /* 静默 */ }
        };
    }

    // 主题切换按钮（作用域限定在设置页）
    const currentTheme = getTheme();
    document.querySelectorAll('#screen-settings .theme-option').forEach(btn => {
        if (btn.dataset.themeVal === currentTheme) btn.classList.add('active');
        btn.onclick = () => {
            setTheme(btn.dataset.themeVal);
            document.querySelectorAll('#screen-settings .theme-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        };
    });

    // 清除数据按钮（danger 确认弹窗）
    const clearBtn = $("#btn-clear-data");
    if (clearBtn) {
        clearBtn.onclick = async () => {
            const ok = await showConfirm({
                title: "清除所有数据？",
                message: "将删除 API Key、答题进度、知识库等所有本地数据，此操作不可撤销。",
                okText: "清除",
                danger: true,
            });
            if (!ok) return;
            try {
                await api("/api/reset", { method: "POST" });
                showToast("数据已清除，软件将返回初始状态", "success");
                location.reload();
            } catch { showToast("清除失败", "error"); }
        };
    }

    // 数据目录（统一存储）：展示当前目录 + 打开 / 更改；商店版禁用并提示（PRD DIR-1）
    (async () => {
        try {
            const info = await api("/api/data_dir");
            const dirEl = $("#settings-data-dir-desc");
            if (dirEl) {
                if (info.packaged) {
                    dirEl.textContent = "商店版不支持修改数据目录，如需自定义请使用 GitHub 版";
                    const actions = $("#settings-data-dir-actions");
                    if (actions) actions.style.display = "none";
                    const item = $("#settings-data-dir-item");
                    if (item) item.style.opacity = "0.6";
                } else {
                    const tag = info.customized ? "（自定义）" : "（默认）";
                    dirEl.textContent = info.dir + " " + tag;
                }
            }
        } catch { /* 静默 */ }
    })();
    const openDirBtn = $("#btn-open-data-dir");
    if (openDirBtn) openDirBtn.onclick = async () => {
        try {
            // pywebview 原生：直接调 JsApi；浏览器模式降级为后端 os.startfile
            if (window.pywebview && window.pywebview.api
                && typeof window.pywebview.api.open_data_dir === "function") {
                await window.pywebview.api.open_data_dir();
            } else {
                await api("/api/data_dir/open", { method: "POST" });
            }
        } catch (e) {
            showToast("无法打开数据目录：" + ((e && e.message) || e), "error");
        }
    };
    const changeDirBtn = $("#btn-change-data-dir");
    if (changeDirBtn) changeDirBtn.onclick = async () => {
        let newDir = "";
        if (window.pywebview && window.pywebview.api
            && typeof window.pywebview.api.choose_data_dir === "function") {
            const r = await window.pywebview.api.choose_data_dir();
            if (r && r.cancelled) return;
            if (r && r.success) newDir = r.path;
            else { showToast((r && r.error) || "无法选择文件夹", "error"); return; }
        } else {
            newDir = await showConfirm({
                title: "更改数据目录",
                message: "请输入新的数据目录绝对路径：",
                okText: "继续",
                input: "例如 C:\\KOTOBA-Data",
            });
            if (!newDir) return;
        }
        const ok = await showConfirm({
            title: "确认更改数据目录？",
            message: "新目录：" + newDir + "\n\n所有学习数据会迁移到新目录，软件将自动重启。",
            okText: "更改并重启",
            danger: true,
        });
        if (!ok) return;
        try {
            const res = await api("/api/data_dir/change", {
                method: "POST",
                body: JSON.stringify({ path: newDir }),
            });
            showToast((res.migrated ? "已迁移 " + res.migrated + " 个文件，" : "目录已设置，") + "软件即将自动重启…", "success");
            // 服务端已安排延迟重启，此处无需额外动作
        } catch (e) {
            showToast("更改失败：" + ((e && e.message) || e), "error");
        }
    };

    // 隐私政策
    const privacyBtn = $("#settings-privacy");
    if (privacyBtn) privacyBtn.onclick = showPrivacyScreen;

    // 使用说明
    const guideBtn = $("#settings-guide");
    if (guideBtn) guideBtn.onclick = showGuideModal;

    // 开发路线图
    const roadmapBtn = $("#settings-roadmap");
    if (roadmapBtn) roadmapBtn.onclick = showRoadmapModal;

    // 自绘下拉组件：厂商（统一下拉风格）
    initCustomSelect($("#settings-provider"));
}


// ============================================================
// 自绘下拉组件 CustomSelect（统一下拉风格，弹出列表也定制）
// 用法：initCustomSelect($("#xxx"))
// - 原 <select> 保留为数据源（隐藏），组件同步其 value 并派发 change 事件，
//   原有 .value 读取 / onchange 处理器完全不受影响
// - 外部往原 select 增删 option 时自动重建列表（MutationObserver）
// ============================================================
class CustomSelect {
    constructor(select, opts = {}) {
        if (!select || select.__cs) return;
        this.select = select;
        this.onSelect = opts.onSelect || null;
        this.open = false;
        this.container = document.createElement("div");
        this.container.className = "cs";
        // 继承原 select 的布局约束（如设置页学习目标固定 104px 宽）
        if (select.style.width) this.container.style.width = select.style.width;
        if (select.style.flexShrink) this.container.style.flexShrink = select.style.flexShrink;
        const curText = select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : "";
        this.container.innerHTML = `
            <button type="button" class="cs-trigger" aria-haspopup="listbox" aria-expanded="false">
                <span class="cs-value">${this._esc(curText)}</span>
                <svg class="cs-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <ul class="cs-list" role="listbox"></ul>
        `;
        this.trigger = this.container.querySelector(".cs-trigger");
        this.valueEl = this.container.querySelector(".cs-value");
        this.listEl = this.container.querySelector(".cs-list");
        select.classList.add("cs-native");
        select.insertAdjacentElement("afterend", this.container);

        this._observer = new MutationObserver(() => this.refresh());
        this._observer.observe(select, { childList: true });

        this.refresh();
        this._bind();
    }

    _esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    // 从原 select 重建选项列表 + 触发框文字（外部动态更新选项后自动调用）
    refresh() {
        this.listEl.innerHTML = Array.from(this.select.options).map((o, i) =>
            `<li class="cs-item${o.selected ? " active" : ""}" data-index="${i}" role="option" aria-selected="${o.selected}">${this._esc(o.textContent)}</li>`
        ).join("");
        const sel = this.select.options[this.select.selectedIndex];
        this.valueEl.textContent = sel ? sel.textContent : "";
        // 列表正展开时，外部改选项后重算 maxHeight / 上翻
        if (this.open) this._position();
    }

    // 展开：列表留在卡片内，靠 CSS 定位（position:absolute 于 .cs 容器）。
    // CSS transform 天然作用于后代 —— 卡片 hover 浮起时列表同步浮起，不再错位；
    // 溢出被下方卡片遮住的问题改由「所在卡片 z-index 抬升（.card.cs-open=90）」解决。
    // 命名 _open（非 open）：this.open 是布尔展开态字段，会遮蔽同名原型方法
    _open() {
        if (this.open) return;
        this.open = true;
        this.container.classList.add("open");
        this.trigger.setAttribute("aria-expanded", "true");
        const card = this.container.closest(".card");
        if (card) card.classList.add("cs-open");
        this._position();
        // 滚动/缩放时关闭，避免列表与触发框错位（capture 捕获任意祖先滚动）
        window.addEventListener("scroll", this._onScroll, true);
        window.addEventListener("resize", this._onScroll);
    }

    // 列表定位完全交给 CSS（.cs-list 默认 top:calc(100%+6px)），
    // 这里只按视口剩余高度钳制 maxHeight；下方空间不足时上翻
    _position() {
        const r = this.trigger.getBoundingClientRect();
        const spaceBelow = window.innerHeight - r.bottom;
        const spaceAbove = r.top;
        const estH = this.listEl.scrollHeight || 240;
        if (spaceBelow >= estH + 6 || spaceBelow >= spaceAbove) {
            this.listEl.style.top = "";
            this.listEl.style.bottom = "";
            this.listEl.style.maxHeight = Math.min(240, Math.max(120, spaceBelow - 6)) + "px";
        } else {
            this.listEl.style.top = "auto";
            this.listEl.style.bottom = "calc(100% + 6px)";
            this.listEl.style.maxHeight = Math.min(240, Math.max(120, spaceAbove - 6)) + "px";
        }
    }

    // 列表自身滚动不关闭（滚动的是列表内容）；祖先/窗口滚动才关闭
    _onScroll = (e) => {
        if (e && e.target && this.listEl.contains(e.target)) return;
        this.close();
    };

    _bind() {
        this.trigger.addEventListener("click", () => {
            if (this.open) this.close();
            else this._open();
        });
        this.listEl.addEventListener("click", e => {
            const li = e.target.closest(".cs-item");
            if (!li) return;
            const opt = this.select.options[parseInt(li.dataset.index, 10)];
            if (opt) {
                this.select.selectedIndex = opt.index;
                this.select.dispatchEvent(new Event("change", { bubbles: true }));
                if (this.onSelect) this.onSelect(opt.value, opt.textContent, opt);
                this.refresh();
            }
            this.close();
        });
        // 点击外部关闭（列表在卡片内，container.contains 已覆盖列表）
        document.addEventListener("click", e => {
            if (this.open && !this.container.contains(e.target)) this.close();
        });
        // Esc 关闭
        document.addEventListener("keydown", e => {
            if (e.key === "Escape" && this.open) this.close();
        });
    }

    close() {
        if (!this.open) return;
        this.open = false;
        this.container.classList.remove("open");
        this.trigger.setAttribute("aria-expanded", "false");
        const card = this.container.closest(".card");
        if (card) card.classList.remove("cs-open");
        window.removeEventListener("scroll", this._onScroll, true);
        window.removeEventListener("resize", this._onScroll);
        // 列表从未离开容器，仅清空 _position() 写入的 inline 定位
        this.listEl.style.top = "";
        this.listEl.style.bottom = "";
        this.listEl.style.maxHeight = "";
    }
}

function initCustomSelect(select) {
    if (!select || select.__cs) return select && select.__cs;
    select.__cs = new CustomSelect(select);
    return select.__cs;
}


// 隐私政策弹窗
function showPrivacyScreen() {
    show($("#modal-privacy"));
    refreshIcons();
    $("#btn-privacy-close").onclick = () => hide($("#modal-privacy"));
    // 点击遮罩关闭
    $("#modal-privacy").onclick = (e) => {
        if (e.target === $("#modal-privacy")) hide($("#modal-privacy"));
    };
}

// 使用说明弹窗
function showGuideModal() {
    show($("#modal-guide"));
    refreshIcons();
    $("#btn-guide-close").onclick = () => hide($("#modal-guide"));
    $("#modal-guide").onclick = (e) => {
        if (e.target === $("#modal-guide")) hide($("#modal-guide"));
    };
}

// 开发路线图弹窗
function showRoadmapModal() {
    show($("#modal-roadmap"));
    refreshIcons();
    $("#btn-roadmap-close").onclick = () => hide($("#modal-roadmap"));
    $("#modal-roadmap").onclick = (e) => {
        if (e.target === $("#modal-roadmap")) hide($("#modal-roadmap"));
    };
}

// 公告弹窗（三标签：本版公告 / 历史更新 / 反馈与鸣谢）
function showAnnounceModal() {
    show($("#modal-announce"));
    refreshIcons();
    document.querySelectorAll("#modal-announce .announce-tab").forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll("#modal-announce .announce-tab").forEach(t =>
                t.classList.toggle("active", t === tab));
            document.querySelectorAll("#modal-announce .announce-pane").forEach(p => {
                p.style.display = p.dataset.apane === tab.dataset.atab ? "" : "none";
            });
        };
    });
    $("#btn-announce-close").onclick = () => hide($("#modal-announce"));
    $("#modal-announce").onclick = (e) => {
        if (e.target === $("#modal-announce")) hide($("#modal-announce"));
    };
}

// 首页 QQ 群卡片 → 复制群号到剪贴板（WebView2 navigator.clipboard + execCommand 兜底）
const QQ_GROUP_NUMBER = "342747706";
function copyQqGroupNumber() {
    const hint = $("#qq-copy-hint");
    const showDone = () => {
        if (!hint) return;
        hint.textContent = "已复制群号，打开 QQ 搜索加入";
        setTimeout(() => { hint.textContent = "群号 " + QQ_GROUP_NUMBER + " · 点击复制"; }, 2500);
    };
    const fallback = () => {
        const ta = document.createElement("textarea");
        ta.value = QQ_GROUP_NUMBER;
        ta.style.cssText = "position:fixed;opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta);
        showDone();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(QQ_GROUP_NUMBER).then(showDone).catch(fallback);
    } else {
        fallback();
    }
}

// ============================================================
// 打卡记录
// ============================================================
let checkinData = null;
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth() + 1; // 0-based → 1-based

async function loadCheckinData() {
    try {
        checkinData = await api("/api/checkin");
    } catch {
        checkinData = { dates: [], streak: 0, monthly_count: 0, monthly_dates: [] };
    }
    return checkinData;
}

// 顶部状态 chips：连续打卡（Beta 6.0 练习页聚焦流，替代原右侧迷你打卡卡）
async function loadCheckinMini() {
    const data = await loadCheckinData();
    const streakEl = $("#chip-streak-num");
    if (streakEl) streakEl.textContent = String(data.streak || 0);
}

// 个人页完整日历
let calActiveSet = new Set();

async function renderCheckinCalendar(monthOffset = 0) {
    const data = await loadCheckinData();
    calActiveSet = new Set(data.dates || []);

    // 计算目标月份
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    calYear = target.getFullYear();
    calMonth = target.getMonth() + 1;

    // 更新标题
    const label = $("#cal-month-label");
    if (label) label.textContent = `${calYear}年${calMonth}月`;

    // 本月活跃天数
    const monthPrefix = `${calYear}-${String(calMonth).padStart(2, "0")}`;
    const monthActive = (data.dates || []).filter(d => d.startsWith(monthPrefix));

    // 更新统计数字
    const streakEl = $("#cal-streak-num");
    const monthEl = $("#cal-month-num");
    if (streakEl) streakEl.textContent = data.streak || "0";
    if (monthEl) monthEl.textContent = monthActive.length;

    // 渲染日历网格
    const grid = $("#checkin-grid");
    if (!grid) return;

    const firstDay = new Date(calYear, calMonth - 1, 1).getDay(); // 0=周日
    const daysInMonth = new Date(calYear, calMonth, 0).getDate();

    let html = "";
    // 填充前面的空白格
    for (let i = 0; i < firstDay; i++) {
        html += '<div class="checkin-day empty"></div>';
    }
    // 日期格
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${calYear}-${String(calMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const isActive = calActiveSet.has(dateStr);
        const isToday = dateStr === new Date().toISOString().slice(0, 10);
        let cls = "checkin-day";
        if (isToday) cls += " today";
        if (isActive) cls += " active";
        html += `<div class="${cls}">${isActive ? '<span class="checkin-day-num">' + day + '</span>' : day}</div>`;
    }
    grid.innerHTML = html;

    // 导航按钮
    const prevBtn = $("#cal-prev-month");
    const nextBtn = $("#cal-next-month");
    if (prevBtn) prevBtn.onclick = () => renderCheckinCalendar(monthOffset - 1);
    if (nextBtn) {
        // 不能超过当前月份
        const isCurrentOrFuture = (calYear === now.getFullYear() && calMonth >= now.getMonth() + 1) || calYear > now.getFullYear();
        nextBtn.disabled = isCurrentOrFuture;
        if (!isCurrentOrFuture) nextBtn.onclick = () => renderCheckinCalendar(monthOffset + 1);
    }
}

// 个人页复习计划（Beta 5.5：点击卡片弹完整列表面板）
async function loadReviewPlan() {
    try {
        const data = await api("/api/review_due");
        const due = data.due || [];
        const total = data.total || 0;
        const badge = $("#review-plan-badge");
        const list = $("#review-plan-list");
        if (!list) return;

        if (due.length > 0) {
            if (badge) { badge.textContent = `${due.length} 个待复习`; badge.style.display = ""; }
            const items = due.slice(0, 3);
            list.innerHTML = items.map(i => {
                const stageLabel = i.review_stage ? `第${i.review_stage}轮` : "新学";
                const lastScore = i.history_scores?.length ? i.history_scores[i.history_scores.length - 1].toFixed(1) : "--";
                return `<div class="review-plan-item" data-grammar="${i.grammar_point}">
                    <div class="review-plan-item-left">
                        <span class="review-plan-grammar">${i.grammar_point}</span>
                        <span class="review-plan-meta">${stageLabel} · 上次得分 ${lastScore} · ${i.review_interval || 0} 天间隔</span>
                    </div>
                    <i data-lucide="play-circle" style="width:18px;height:18px;color:var(--color-primary)"></i>
                </div>`;
            }).join("") + (due.length > 3 ? `<p class="review-plan-more">还有 ${due.length - 3} 个语法点待复习...</p>` : "");
        } else if (total > 0) {
            list.innerHTML = `<p class="review-plan-empty">全部语法点已掌握，暂无到期复习</p>`;
            if (badge) badge.style.display = "none";
        } else {
            list.innerHTML = `<p class="review-plan-empty">完成首次练习后，艾宾浩斯记忆系统将自动安排复习</p>`;
            if (badge) badge.style.display = "none";
        }
        refreshIcons();

        // 点击复习项：立即复习单个知识点
        $$(".review-plan-item").forEach(el => {
            el.onclick = async (e) => {
                e.stopPropagation();
                const gp = el.dataset.grammar;
                showReviewTypeModal([gp]);
            };
        });

        // Beta 5.5：点击卡片头部弹出完整列表面板
        const header = $("#review-plan-header");
        if (header) {
            header.onclick = () => openReviewPlanPanel(data);
        }
    } catch { /* 静默 */ }
}

// 复习计划完整列表面板（Beta 5.5）
let _reviewPlanPanelData = null;
let _reviewPlanPanelSort = "due";

function openReviewPlanPanel(data) {
    _reviewPlanPanelData = data;
    const modal = $("#modal-review-plan");
    if (!modal) return;
    const sortSel = $("#review-plan-sort");
    if (sortSel) sortSel.value = _reviewPlanPanelSort;
    renderReviewPlanPanel();

    $("#btn-review-plan-close").onclick = () => hide(modal);
    modal.onclick = (e) => { if (e.target === modal) hide(modal); };
    $("#btn-review-plan-start-batch").onclick = () => {
        hide(modal);
        showReviewSelectModal(data);
    };
    if (sortSel) {
        sortSel.onchange = () => {
            _reviewPlanPanelSort = sortSel.value;
            renderReviewPlanPanel();
        };
    }

    show(modal);
    refreshIcons();
}

function renderReviewPlanPanel() {
    const data = _reviewPlanPanelData;
    if (!data) return;
    let due = (data.due || []).slice();
    if (_reviewPlanPanelSort === "mastery") {
        due.sort((a, b) => (a.mastery || 0) - (b.mastery || 0));
    } else {
        due.sort((a, b) => (a.next_review || "").localeCompare(b.next_review || ""));
    }

    $("#review-plan-panel-title").textContent = "复习计划";
    $("#review-plan-panel-subtitle").textContent = `共 ${due.length} 个知识点待复习`;

    const listEl = $("#review-plan-panel-list");
    if (due.length === 0) {
        listEl.innerHTML = `<p class="review-plan-panel-empty">全部语法点已掌握，暂无到期复习</p>`;
        return;
    }

    listEl.innerHTML = due.map(i => {
        const gp = i.grammar_point || "";
        const dueText = _reviewDueText(i.next_review);
        const mastery = Math.round((i.mastery || 0) * 100);
        const overdueClass = (dueText || "").startsWith("已逾期") ? "overdue" : "";
        return `
            <div class="review-plan-panel-item" data-gp="${escapeHtml(gp)}">
                <div class="review-plan-panel-left">
                    <div class="review-plan-panel-name">${escapeHtml(gp)}</div>
                    <div class="review-plan-panel-due ${overdueClass}">${escapeHtml(dueText)} · 复习 ${i.review_count || 0} 次</div>
                </div>
                <div class="review-plan-panel-right">
                    <span class="review-plan-panel-mastery">${mastery}%</span>
                </div>
            </div>
        `;
    }).join("");
    refreshIcons();
}

// ============================================================
// 知识点去重（Beta 5.5 温故更新）
// ============================================================
let _mergeDuplicatesGroups = [];

async function checkAndShowDuplicates() {
    showLoading("正在检查重复知识点...");
    try {
        const data = await api("/api/learned_content/duplicates");
        hideLoading();
        const groups = data.groups || [];
        if (groups.length === 0) {
            showToast("未发现重复知识点，数据很干净", "success");
            return;
        }
        _mergeDuplicatesGroups = groups;
        renderMergeDuplicates();
        const modal = $("#modal-merge-duplicates");
        show(modal);
        refreshIcons();
    } catch (err) {
        hideLoading();
        showToast(`检查失败：${err.message}`, "error");
    }
}

function renderMergeDuplicates() {
    const listEl = $("#merge-duplicates-list");
    if (!_mergeDuplicatesGroups.length) {
        listEl.innerHTML = `<p class="merge-duplicates-empty">无重复知识点</p>`;
        return;
    }

    listEl.innerHTML = _mergeDuplicatesGroups.map((g, idx) => {
        const items = g.items || [];
        const itemHtml = items.map(it => {
            const stage = it.review_stage != null ? `第${it.review_stage}轮` : "新学";
            const mastery = Math.round((it.mastery || 0) * 100);
            return `<div class="merge-duplicates-item">
                <span>${escapeHtml(it.grammar_point || "")}</span>
                <span class="merge-duplicates-item-meta">${stage} · 掌握度 ${mastery}% · 下次复习 ${escapeHtml(it.next_review || "--")}</span>
            </div>`;
        }).join("");

        return `
            <div class="merge-duplicates-group" data-idx="${idx}">
                <div class="merge-duplicates-group-title">将合并为：${escapeHtml(g.canonical_name || "")}</div>
                <div class="merge-duplicates-items">${itemHtml}</div>
                <div class="merge-duplicates-group-actions">
                    <label class="merge-duplicates-radio"><input type="radio" name="merge-action-${idx}" value="merge" checked> 合并</label>
                    <label class="merge-duplicates-radio"><input type="radio" name="merge-action-${idx}" value="keep"> 保留全部</label>
                    <label class="merge-duplicates-radio"><input type="radio" name="merge-action-${idx}" value="ignore"> 忽略</label>
                </div>
            </div>
        `;
    }).join("");

    // 绑定确认/取消/关闭
    const modal = $("#modal-merge-duplicates");
    $("#btn-merge-duplicates-confirm").onclick = confirmMergeDuplicates;
    $("#btn-merge-duplicates-cancel").onclick = () => hide(modal);
    $("#btn-merge-duplicates-close").onclick = () => hide(modal);
    modal.onclick = (e) => { if (e.target === modal) hide(modal); };
}

async function confirmMergeDuplicates() {
    const groups = _mergeDuplicatesGroups.map((g, idx) => {
        const radios = document.getElementsByName(`merge-action-${idx}`);
        let action = "merge";
        for (const r of radios) { if (r.checked) { action = r.value; break; } }
        return {
            canonical_name: g.canonical_name,
            grammar_points: (g.items || []).map(it => it.grammar_point),
            action,
        };
    });

    showLoading("正在合并知识点...");
    try {
        const result = await api("/api/learned_content/merge", {
            method: "POST",
            body: JSON.stringify({ groups }),
        });
        hideLoading();
        if (result.success) {
            hide($("#modal-merge-duplicates"));
            showToast(`已合并 ${result.merged_count || 0} 组重复知识点`, "success");
            loadReviewPlan();
            loadReviewStatus();
        } else {
            throw new Error(result.error || "合并失败");
        }
    } catch (err) {
        hideLoading();
        showToast(`合并失败：${err.message}`, "error");
    }
}

// ============================================================
// 答疑（QA）页面 — M2
// ============================================================
// 三入口互斥 / 输入质量门 / 三模式解析 / 去练习联动
const QaState = {
    entry: "text",          // image / pdf / text
    content: "",
    answerKey: "",
    userAnswer: "",
    result: null,           // 最近一次解析结果
    detailShown: false,     // 是否已展开详细讲解
    pendingVisible: false,  // 待确认池面板是否展开
    socratic: null,         // 苏格拉底「考考我」会话（M5）：{questions, index, results, done, sm2}
};

const QA_TYPE_LABELS = {
    single_question: "单题",
    passage_with_blanks: "完形填空",
    passage_only: "阅读文章",
    not_japanese: "非日语",
};
const QA_TAG_TYPE_LABELS = {
    grammar: "语法",
    vocab_pair: "易混词",
    comprehension: "理解",
};
const QA_MODE_HINTS = {
    A: "将走：模式 A · 标准答案确定性判分（对错由代码对比，AI 不判分）",
    B: "将走：模式 B · AI 评判你的答案",
    C: "将走：模式 C · AI 解题（低置信，结果由 AI 给出参考答案）",
};

function qaHasJapanese(text) {
    return /[぀-ヿ]/.test(text || "") || /[々・]/.test(text || "");
}
function qaIsPureSymbols(content) {
    const s = content.replace(/\s/g, "");
    if (!s) return false; // 空输入由空检查拦截
    // 不含任何文字/数字/假名/汉字 → 纯符号
    return !/[぀-ヿ㐀-䶿一-鿿０-９Ａ-Ｚａ-ｚa-zA-Z0-9]/.test(s);
}
function qaIsPureNumbers(content) {
    const s = content.replace(/\s/g, "");
    if (!s) return false;
    return s.replace(/[\d０-９]/g, "").trim() === "";
}
function qaValidate(content) {
    // QA-2：输入质量门（零 token，不发起请求）
    if (!content) return { ok: false, msg: "请先粘贴题目内容" };
    if (qaIsPureSymbols(content)) return { ok: false, msg: "输入内容只包含符号，无法识别为题目" };
    if (qaIsPureNumbers(content)) return { ok: false, msg: "输入内容只包含数字，无法识别为题目" };
    if (!qaHasJapanese(content)) return { ok: false, msg: "未检测到日语内容（日文一般含假名）。请确认这是日语题目" };
    return { ok: true };
}
function qaDetectMode(answerKey, userAnswer) {
    if (answerKey && answerKey.trim()) return "A";
    if (userAnswer && userAnswer.trim()) return "B";
    return "C";
}

function showQaScreen() {
    showScreen("qa");
    setDockActive("qa");

    const card = $("#qa-card");
    if (!card) return;
    card.innerHTML = `
        <div class="card config-card" data-glow>
            <div class="config-card-header">
                <i data-lucide="layout-grid" style="width:18px;height:18px"></i>
                <span>答疑方式</span>
            </div>
            <div class="qa-entry-grid" id="qa-entry-grid">
                <div class="qa-entry-card" data-entry="image">
                    <div class="qa-entry-icon"><i data-lucide="camera" style="width:22px;height:22px"></i></div>
                    <span class="qa-entry-name">图片</span>
                    <small class="qa-entry-desc">拍照 / 截图</small>
                </div>
                <div class="qa-entry-card" data-entry="pdf">
                    <div class="qa-entry-icon"><i data-lucide="file-text" style="width:22px;height:22px"></i></div>
                    <span class="qa-entry-name">PDF</span>
                    <small class="qa-entry-desc">上传文档</small>
                </div>
                <div class="qa-entry-card active" data-entry="text">
                    <div class="qa-entry-icon"><i data-lucide="pencil" style="width:22px;height:22px"></i></div>
                    <span class="qa-entry-name">文字</span>
                    <small class="qa-entry-desc">粘贴题目</small>
                </div>
            </div>
        </div>

        <div class="card config-card" data-glow id="qa-text-area">
            <div class="config-card-header">
                <i data-lucide="pencil-line" style="width:18px;height:18px"></i>
                <span>题目内容</span>
            </div>
            <textarea id="qa-content-input" class="input textarea qa-content-input" placeholder="粘贴日语题目。例如：&#10;次の言葉を使って、正しい文を作りなさい。&#10;毎日＿＿＿散歩します。（てから / ながら）"></textarea>
            <p class="input-hint" id="qa-char-count">0 字</p>
        </div>

        <div class="card config-card" data-glow id="qa-file-upload" style="display:none;">
            <div class="config-card-header">
                <i data-lucide="pencil-line" style="width:18px;height:18px"></i>
                <span>题目内容</span>
            </div>
            <label class="input-label" id="qa-file-label">上传文件</label>
            <div class="qa-drop-zone" id="qa-drop-zone">
                <i data-lucide="upload" style="width:28px;height:28px"></i>
                <p id="qa-drop-text">拖拽文件到这里，或点击选择</p>
                <span class="qa-drop-hint" id="qa-drop-hint">支持 PDF / PNG / JPG / WebP，最大 10 MB</span>
                <input type="file" id="qa-file-input" accept=".pdf,image/png,image/jpg,image/jpeg,image/webp" hidden>
            </div>
            <div class="qa-media-notice" id="qa-media-note">
                <i data-lucide="alert-triangle" style="width:16px;height:16px"></i>
                <p>应用自带识别功能准确率较低，建议使用外置识别工具</p>
            </div>
            <p class="input-hint" id="qa-file-status"></p>
        </div>

        <div class="card config-card" data-glow>
            <div class="config-card-header">
                <i data-lucide="check-circle-2" style="width:18px;height:18px"></i>
                <span>标准答案与我的答案</span>
                <span class="badge-optional">可选</span>
            </div>
            <div class="qa-optional-grid">
                <div class="qa-optional-field">
                    <label class="input-label" for="qa-answer-key">标准答案</label>
                    <input type="text" id="qa-answer-key" class="input" placeholder="题目自带答案？填这里可自动判分" autocomplete="off">
                </div>
                <div class="qa-optional-field">
                    <label class="input-label" for="qa-user-answer">我的答案</label>
                    <input type="text" id="qa-user-answer" class="input" placeholder="你写的答案？AI 评判对错" autocomplete="off">
                </div>
            </div>
            <p class="input-hint" id="qa-mode-hint"></p>
        </div>

        <div class="main-start">
            <button class="btn btn-primary btn-full btn-lg" id="btn-qa-parse"><i data-lucide="sparkles" style="width:20px;height:20px"></i> 开始解析</button>
            <p id="qa-error" class="error-text" style="display:none;"></p>
        </div>

        <div id="qa-result" class="qa-result" style="display:none;"></div>
        <div id="qa-socratic" class="qa-socratic" style="display:none;"></div>
    `;
    refreshIcons();

    // 恢复状态（DOM 刚重建，重置文件绑定标记让 PDF 入口重新挂事件）
    resetQaFileBind();
    qaSetEntry(QaState.entry);
    $("#qa-content-input").value = QaState.content;
    $("#qa-answer-key").value = QaState.answerKey;
    $("#qa-user-answer").value = QaState.userAnswer;
    updateQaCharCount();
    updateQaModeHint();

    // 三入口互斥（QA-1：选一个，其余置灰）
    $$("#qa-entry-grid .qa-entry-card").forEach(el => {
        el.onclick = () => qaSetEntry(el.dataset.entry);
    });

    // 输入事件
    $("#qa-content-input").oninput = () => {
        QaState.content = $("#qa-content-input").value;
        updateQaCharCount();
    };
    $("#qa-answer-key").oninput = () => { QaState.answerKey = $("#qa-answer-key").value; updateQaModeHint(); };
    $("#qa-user-answer").oninput = () => { QaState.userAnswer = $("#qa-user-answer").value; updateQaModeHint(); };

    $("#btn-qa-parse").onclick = () => submitQaParse(false);

    // 若已有结果，重新渲染
    if (QaState.result) renderQaResult(QaState.result);
}

function qaSetEntry(type) {
    QaState.entry = type;
    $$("#qa-entry-grid .qa-entry-card").forEach(el => {
        el.classList.toggle("active", el.dataset.entry === type);
    });
    const textArea = $("#qa-text-area");
    const fileUpload = $("#qa-file-upload");
    const parseBtn = $("#btn-qa-parse");

    if (type === "text") {
        // 文字入口：显示 textarea，隐藏文件上传
        if (textArea) textArea.style.display = "";
        if (fileUpload) fileUpload.style.display = "none";
        if (parseBtn) parseBtn.disabled = false;
    } else {
        // 图片 / PDF 入口：显示文件上传区，隐藏 textarea（提取后在 textarea 回显）
        if (textArea) textArea.style.display = "none";
        if (fileUpload) fileUpload.style.display = "";
        if (parseBtn) parseBtn.disabled = !(QaState.content && QaState.content.trim());
        // 按入口类型更新拖拽区文案，并绑定文件选择事件
        updateQaDropHint(type);
        bindQaFileUpload();
    }
}

function updateQaDropHint(type) {
    const label = $("#qa-file-label");
    const dropText = $("#qa-drop-text");
    const hint = $("#qa-drop-hint");
    if (type === "pdf") {
        if (label) label.textContent = "上传 PDF";
        if (dropText) dropText.textContent = "拖拽 PDF 文件到这里，或点击选择";
        if (hint) hint.textContent = "支持 .pdf，最大 10 MB，最多 50 页";
    } else {
        if (label) label.textContent = "上传图片";
        if (dropText) dropText.textContent = "拖拽截图 / 照片到这里，或点击选择";
        if (hint) hint.textContent = "支持 PNG / JPG / WebP，最大 10 MB";
    }
}

let _qaFileBound = false;
function bindQaFileUpload() {
    if (_qaFileBound) return;
    _qaFileBound = true;

    const dropZone = $("#qa-drop-zone");
    const fileInput = $("#qa-file-input");
    const statusEl = $("#qa-file-status");

    if (!dropZone || !fileInput) { _qaFileBound = false; return; }

    // 点击打开文件选择器
    dropZone.onclick = () => fileInput.click();

    // 拖拽事件
    ["dragenter", "dragover"].forEach(ev => {
        dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add("qa-drop-active"); });
    });
    ["dragleave", "drop"].forEach(ev => {
        dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove("qa-drop-active"); });
    });
    dropZone.addEventListener("drop", e => {
        const files = e.dataTransfer.files;
        if (files.length) handleQaFile(files[0], statusEl);
    });

    fileInput.onchange = () => {
        if (fileInput.files.length) handleQaFile(fileInput.files[0], statusEl);
    };
}

function resetQaFileBind() { _qaFileBound = false; }

function qaFileKind(file) {
    const n = (file && file.name || "").toLowerCase();
    if (/\.pdf$/.test(n)) return "pdf";
    if (/\.(png|jpe?g|webp)$/.test(n)) return "image";
    return "";
}

async function handleQaFile(file, statusEl) {
    const kind = qaFileKind(file);
    if (!kind) {
        if (statusEl) statusEl.textContent = "请选择 PDF 或图片（PNG / JPG / WebP）";
        return;
    }
    if (file.size > 10 * 1024 * 1024) {
        if (statusEl) statusEl.textContent = "文件过大（最大 10 MB）";
        return;
    }

    const action = kind === "pdf" ? "提取 PDF 文字" : "识别图片文字";
    if (statusEl) statusEl.textContent = `正在${action}（${(file.size / 1024 / 1024).toFixed(1)} MB）…`;

    try {
        const data = await apiUpload("/api/qa/upload", file);

        if (!data.success) {
            if (statusEl) statusEl.textContent = data.warning || data.error || "提取失败";
            return;
        }

        if (statusEl) statusEl.textContent = kind === "pdf"
            ? `已提取 ${data.pages} 页，${data.text.length} 字`
            : `已识别图片文字（${data.text.length} 字）`;
        QaState.content = data.text;

        // 回填 textarea，切换到文字入口让用户编辑
        const textArea = $("#qa-content-input");
        if (textArea) textArea.value = data.text;
        updateQaCharCount();

        // 显示 textarea，隐藏文件上传区
        const ta = $("#qa-text-area");
        const fu = $("#qa-file-upload");
        if (ta) ta.style.display = "";
        if (fu) fu.style.display = "none";

        const parseBtn = $("#btn-qa-parse");
        if (parseBtn) parseBtn.disabled = false;
    } catch (err) {
        if (statusEl) statusEl.textContent = `上传失败：${err.message}`;
    }
}

function updateQaCharCount() {
    const el = $("#qa-char-count");
    if (el) el.textContent = `${($("#qa-content-input").value || "").length} 字`;
}

function updateQaModeHint() {
    const hint = $("#qa-mode-hint");
    if (!hint) return;
    const mode = qaDetectMode(QaState.answerKey, QaState.userAnswer);
    hint.textContent = QA_MODE_HINTS[mode];
}

async function submitQaParse(detail) {
    const content = ($("#qa-content-input").value || "").trim();
    const gate = qaValidate(content);
    if (!gate.ok) {
        showError("qa-error", gate.msg);
        return;
    }
    hide($("#qa-error"));

    const answerKey = ($("#qa-answer-key").value || "").trim();
    const userAnswer = ($("#qa-user-answer").value || "").trim();
    QaState.content = content;
    QaState.answerKey = answerKey;
    QaState.userAnswer = userAnswer;

    showLoading(detail ? "正在生成详细讲解..." : "正在解析题目...");
    try {
        const result = await api("/api/qa/parse", {
            method: "POST",
            body: JSON.stringify({
                content,
                answer_key: answerKey,
                user_answer: userAnswer,
                level: AppState.config.level || "N4",
                detail: !!detail,
            }),
        });
        hideLoading();
        QaState.result = result;
        QaState.detailShown = !!detail;
        resetSocraticPanel();  // 新解析 → 旧考考我会话作废
        renderQaResult(result);
    } catch (err) {
        hideLoading();
        showError("qa-error", err.message);
    }
}

function qaFocusTagsOf(result) {
    return [...new Set((result.knowledge_tags || [])
        .filter(t => t.type === "grammar" || t.type === "vocab_pair")
        .map(t => (t.tag || "").trim())
        .filter(Boolean))];
}

function renderQaResult(result) {
    const wrap = $("#qa-result");
    if (!wrap) return;
    wrap.style.display = "";

    const mode = result.mode || "C";
    const qtype = result.question_type || "";
    const struct = result.structure || {};
    const ans = result.answer || {};

    const modeBadge = {
        A: { cls: "qa-mode-a", text: "模式 A · 确定性判分" },
        B: { cls: "qa-mode-b", text: "模式 B · AI 评判" },
        C: { cls: "qa-mode-c", text: "模式 C · AI 解题" },
    }[mode] || { cls: "qa-mode-c", text: "模式 " + mode };

    // 题目结构
    let structHtml = "";
    if (struct.stem) structHtml += `<div class="qa-stem">${escapeHtml(struct.stem)}</div>`;
    if (struct.options && struct.options.length) {
        structHtml += `<div class="qa-options">${struct.options.map((o, i) =>
            `<div class="qa-option"><span class="qa-option-letter">${String.fromCharCode(65 + i)}</span>${escapeHtml(o)}</div>`
        ).join("")}</div>`;
    }
    if (struct.passage) {
        structHtml += `<details class="qa-passage"><summary>阅读全文（${struct.passage.length} 字）</summary><p class="qa-passage-body">${escapeHtml(struct.passage)}</p></details>`;
    }
    if (struct.sub_questions && struct.sub_questions.length) {
        structHtml += `<div class="qa-sub-questions">${struct.sub_questions.map(sq => {
            const opts = (sq.options && sq.options.length)
                ? `<div class="qa-options">${sq.options.map((o, i) => `<div class="qa-option"><span class="qa-option-letter">${String.fromCharCode(65 + i)}</span>${escapeHtml(o)}</div>`).join("")}</div>` : "";
            const a = sq.answer ? `<div class="qa-sub-answer">答案：${escapeHtml(sq.answer)}</div>` : "";
            return `<div class="qa-sub-question"><span class="qa-sub-num">${sq.id || ""}</span><div class="qa-sub-body">${escapeHtml(sq.stem)}${opts}${a}</div></div>`;
        }).join("")}</div>`;
    }

    // 答案块
    let ansHtml = "";
    if (mode === "A") {
        let verdictHtml = "";
        if (ans.is_correct === true) verdictHtml = `<div class="qa-verdict qa-verdict-correct">✓ 回答正确</div>`;
        else if (ans.is_correct === false) verdictHtml = `<div class="qa-verdict qa-verdict-wrong">✗ 回答错误</div>`;
        else verdictHtml = `<div class="qa-verdict qa-verdict-neutral">未填「我的答案」，未判分</div>`;
        ansHtml = `
            <div class="qa-answer-block">
                ${verdictHtml}
                <div class="qa-compare-row">
                    <div><small>标准答案</small><p>${escapeHtml(ans.answer_key || "—")}</p></div>
                    <div><small>你的答案</small><p>${escapeHtml(ans.user_answer || "—")}</p></div>
                </div>
            </div>`;
    } else if (mode === "B") {
        ansHtml = `
            <div class="qa-answer-block">
                <div class="qa-compare-row">
                    <div><small>你的答案</small><p>${escapeHtml(ans.user_answer || "—")}</p></div>
                    <div><small>参考解析</small><p>${escapeHtml(ans.correct_answer || "—")}</p></div>
                </div>
                <div class="qa-judgment"><strong>AI 评判：</strong><span>${escapeHtml(ans.judgment || "—")}</span></div>
            </div>`;
    } else {
        const conf = typeof ans.ai_confidence === "number" ? Math.round(ans.ai_confidence * 100) : null;
        ansHtml = `
            <div class="qa-answer-block qa-ai-block">
                <div class="qa-ai-tag"><i data-lucide="bot" style="width:12px;height:12px"></i> AI 解答</div>
                <div class="qa-ai-answer">${escapeHtml(ans.correct_answer || "—")}</div>
                ${conf !== null ? `<div class="qa-ai-confidence">置信度 ${conf}%</div>` : ""}
            </div>`;
    }

    // 讲解（QP-7：默认精简，展开调详细版）
    const detailBtnHtml = QaState.detailShown
        ? ""
        : `<button class="btn btn-secondary btn-sm qa-detail-toggle" id="btn-qa-detail"><i data-lucide="chevron-down" style="width:14px;height:14px"></i> 展开详细讲解</button>`;

    // 知识点标签
    const tags = result.knowledge_tags || [];
    const tagsHtml = tags.length ? `<div class="qa-tags">${tags.map(t => {
        const type = (t.type && QA_TAG_TYPE_LABELS[t.type]) ? t.type : "comprehension";
        const inferred = t.ai_inferred ? " · AI 推断" : "";
        return `<span class="qa-tag-chip qa-tag-${type}">${escapeHtml(QA_TAG_TYPE_LABELS[type])} · ${escapeHtml(t.tag)}${inferred}</span>`;
    }).join("")}</div>` : "";

    // 去练习（QG-1：提取 grammar + vocab_pair）
    const focusTags = qaFocusTagsOf(result);
    const practiceDisabled = focusTags.length === 0;

    // M3：模式 C 且有知识点 → 已入待确认池，提供查看入口
    let pendingNoteHtml = "";
    if ((result.knowledge_tags || []).length) {
        pendingNoteHtml = `
            <div class="qa-pending-note">
                <i data-lucide="inbox" style="width:14px;height:14px"></i>
                <span>知识点已加入「待确认池」，确认后才会纳入复习计划</span>
                <button class="btn btn-secondary btn-sm" id="btn-qa-pending-open">查看待确认</button>
            </div>`;
    }

    wrap.innerHTML = `
        <div class="qa-result-divider"></div>
        <div class="qa-result-header">
            <span class="qa-mode-badge ${modeBadge.cls}">${modeBadge.text}</span>
            <span class="qa-type-badge">${escapeHtml(QA_TYPE_LABELS[qtype] || qtype)}</span>
            ${result.cached ? `<span class="qa-cached-badge"><i data-lucide="zap" style="width:12px;height:12px"></i> 缓存</span>` : ""}
        </div>

        <div class="qa-question-block">
            <div class="qa-section-title"><i data-lucide="file-text" style="width:14px;height:14px"></i> 题目</div>
            ${structHtml || `<p class="qa-empty">（未提取到题目结构）</p>`}
        </div>

        ${ansHtml}

        <div class="qa-explanation">
            <div class="qa-section-title"><i data-lucide="lightbulb" style="width:14px;height:14px"></i> 讲解</div>
            <div class="qa-explanation-body">${renderMarkdown(result.explanation)}</div>
            ${result.explanation_detail ? `<div class="qa-explanation-detail">${renderMarkdown(result.explanation_detail)}</div>` : ""}
            ${detailBtnHtml}
        </div>

        ${tagsHtml}

        ${pendingNoteHtml}

        <div class="qa-action-row">
            <button class="btn btn-secondary" id="btn-qa-again"><i data-lucide="rotate-ccw" style="width:16px;height:16px"></i> 再解析一道</button>
            <button class="btn btn-primary" id="btn-qa-practice" ${practiceDisabled ? "disabled" : ""}><i data-lucide="arrow-right" style="width:16px;height:16px"></i> 去练习</button>
        </div>
        ${practiceDisabled ? `<p class="input-hint">该题暂无语法 / 易混词知识点，暂不能联动练习</p>` : ""}

        ${QaState.socratic ? "" : `
        <div class="qa-socratic-entry">
            <button class="btn btn-primary btn-full" id="btn-qa-socratic"><i data-lucide="help-circle" style="width:16px;height:16px"></i> 考考我</button>
            <p class="input-hint">用 2~3 个小问题检验你是否真正听懂了这次讲解</p>
        </div>`}
    `;
    refreshIcons();

    const detailBtn = $("#btn-qa-detail");
    if (detailBtn) detailBtn.onclick = () => submitQaParse(true);

    const againBtn = $("#btn-qa-again");
    if (againBtn) againBtn.onclick = resetQaForm;

    const practiceBtn = $("#btn-qa-practice");
    if (practiceBtn) practiceBtn.onclick = () => startQaPractice(focusTags);

    const socraticBtn = $("#btn-qa-socratic");
    if (socraticBtn) socraticBtn.onclick = startSocraticQuiz;

    const pendingOpenBtn = $("#btn-qa-pending-open");
    if (pendingOpenBtn) pendingOpenBtn.onclick = toggleQaPendingPanel;

    wrap.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetQaForm() {
    QaState.content = "";
    QaState.answerKey = "";
    QaState.userAnswer = "";
    QaState.result = null;
    QaState.detailShown = false;
    resetSocraticPanel();
    const contentInput = $("#qa-content-input");
    if (contentInput) contentInput.value = "";
    const ak = $("#qa-answer-key"); if (ak) ak.value = "";
    const ua = $("#qa-user-answer"); if (ua) ua.value = "";
    updateQaCharCount();
    updateQaModeHint();
    const err = $("#qa-error"); if (err) hide(err);
    const res = $("#qa-result"); if (res) { res.style.display = "none"; res.innerHTML = ""; }
    const sc = $("#qa-socratic"); if (sc) { sc.style.display = "none"; sc.innerHTML = ""; }
    if (contentInput) contentInput.focus();
}

async function startQaPractice(focusTags) {
    let tags = focusTags || qaFocusTagsOf(QaState.result);
    if (!tags.length) return;
    // M4.5 P2：focus 上限 12（答疑联动通常 1~3 个，兜底性质）
    if (tags.length > MAX_FOCUS_TAGS) {
        tags = tags.slice(0, MAX_FOCUS_TAGS);
        showToast(`知识点较多，本次聚焦前 ${MAX_FOCUS_TAGS} 个`, "info");
    }

    // Beta 6.0（B2 §3.1 契约）：答疑→练习走统一出题函数，预填练习页状态——
    // chips = QA 推断点、词源清零（明确不带，§3.1 表）、notes 不携带。
    // 用户手输的笔记草稿保留在练习页（不发送、不清空），仅本次会话不发 notes。
    AppState.selectedGrammarPoints = tags.map(t => ({ point: t, explanation: "" }));
    practiceVocabWords = [];      // 词源清零：答疑联动出题明确不带词源
    practiceVocabBookId = "";
    const srcSel = $("#vocab-source-select");
    if (srcSel) {
        srcSel.value = "off";
        if (srcSel.__cs) srcSel.__cs.refresh();
    }

    try {
        await beginPractice({
            notes: "",          // 契约：答疑入口 notes ✗（框里有也不发）
            focusTags: tags,    // M4 起由出题 API 正式消费
            vocabText: "",
            practiceWords: [],
            sessionNotes: "答疑联动：" + tags.join("、"),
        });
    } catch (err) {
        showToast(`去练习失败：${err.message}`, "error");
    }
}

// ============================================================
// 苏格拉底模式「考考我」— Beta 7.0 M5（prd-v7.md §四）
// 单入口（答疑结果底部）/ 零配置 / 判分复用批改管线 + 缓存 / SM-2 联动
// ============================================================
const SOCRATIC_TYPE_LABELS = {
    judgment: "判断式",
    discrimination: "辨析式",
    production: "造句式",
    misuse: "误用挑错",
};

function resetSocraticPanel() {
    QaState.socratic = null;
    const sc = $("#qa-socratic");
    if (sc) { sc.style.display = "none"; sc.innerHTML = ""; }
}

async function startSocraticQuiz() {
    const r = QaState.result;
    if (!r) return;
    showLoading("正在出题...");
    try {
        const res = await api("/api/socratic/quiz", {
            method: "POST",
            body: JSON.stringify({
                content: QaState.content || "",
                explanation: r.explanation || "",
                explanation_detail: r.explanation_detail || "",
                knowledge_tags: r.knowledge_tags || [],
                level: AppState.config.level || "N4",
            }),
        });
        hideLoading();
        const questions = res.questions || [];
        if (!questions.length) { showToast("AI 未产出可用题目，请重试", "error"); return; }
        QaState.socratic = { questions, index: 0, results: [], done: false, sm2: null };
        renderSocraticPanel();
        $("#qa-socratic")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
        hideLoading();
        showToast(`出题失败：${err.message}`, "error");
    }
}

function renderSocraticPanel() {
    const wrap = $("#qa-socratic");
    const st = QaState.socratic;
    if (!wrap || !st) return;
    wrap.style.display = "";
    wrap.innerHTML = st.done ? renderSocraticSettlement() : renderSocraticQuestion();
    refreshIcons();

    if (!st.done) {
        const submitBtn = $("#btn-socratic-submit");
        if (submitBtn) submitBtn.onclick = submitSocraticAnswer;
        const nextBtn = $("#btn-socratic-next");
        if (nextBtn) nextBtn.onclick = nextSocraticQuestion;
        // 09-10：输入框随内容自动延展（09-10 用户要求）
        const answerBox = $("#socratic-answer");
        if (answerBox) {
            const grow = () => { answerBox.style.height = "auto"; answerBox.style.height = Math.min(answerBox.scrollHeight, 240) + "px"; };
            answerBox.addEventListener("input", grow);
            grow();
        }
    } else {
        const againBtn = $("#btn-socratic-again");
        if (againBtn) againBtn.onclick = startSocraticQuiz;  // 再考一轮：重新出题
    }
}

function renderSocraticQuestion() {
    const st = QaState.socratic;
    const q = st.questions[st.index];
    // 两状态模型（09-10 重构，修复「提交没反应 / 下一问无法输入」）：
    //   cur = results[index] 当前问已提交的反馈 —— 有 → 展示反馈+下一问按钮，无输入框
    // 09-10 用户裁定：点下一问后只显示新问题，不保留上一问反馈（提交时已看过）
    const cur = st.results[st.index];

    const feedbackHtml = (r) => `
        <div class="qa-socratic-feedback">
            <span class="qa-verdict ${r.correct ? "qa-verdict-correct" : "qa-verdict-wrong"}">${r.correct ? "✓ 回答正确" : "✗ 未答到要点"}</span>
            ${renderSocraticFeedbackBody(r.feedback)}
        </div>`;

    // 当前问未提交：输入框 + 提交按钮
    const inputHtml = cur ? "" : `
            <textarea id="socratic-answer" class="input qa-socratic-answer" rows="2"
                placeholder="${q.type === "production" || q.type === "misuse" ? "用日语写下你的句子…" : "用中文或日语写下你的回答…"}"></textarea>
            <div class="qa-action-row">
                <button class="btn btn-primary" id="btn-socratic-submit"><i data-lucide="send" style="width:16px;height:16px"></i> 提交回答</button>
            </div>`;

    // 当前问已提交：本问反馈 + 下一问/看结算
    const isLast = st.index >= st.questions.length - 1;
    const nextHtml = cur ? `
            ${feedbackHtml(cur)}
            <div class="qa-action-row">
                <button class="btn btn-primary" id="btn-socratic-next">
                    ${isLast ? "看结算" : "下一问"}<i data-lucide="chevron-right" style="width:16px;height:16px"></i>
                </button>
            </div>` : "";

    return `
        <div class="qa-result-divider"></div>
        <div class="qa-socratic-card card">
            <div class="qa-socratic-header">
                <span class="qa-socratic-badge"><i data-lucide="help-circle" style="width:13px;height:13px"></i> 考考我</span>
                <span class="qa-socratic-progress">第 ${st.index + 1} / ${st.questions.length} 问</span>
                <span class="qa-socratic-type">${escapeHtml(SOCRATIC_TYPE_LABELS[q.type] || q.type)}</span>
            </div>
            <div class="qa-socratic-stem">${renderMarkdown(q.stem)}</div>
            ${inputHtml}
            ${nextHtml}
        </div>
    `;
}

// 判分反馈 → 紧凑展示（与批改同 schema：correct/error/suggestions/encouragement）
function renderSocraticFeedbackBody(fb) {
    if (!fb) return "";
    const correct = (fb.correct_parts || []).map(s => `<li>${escapeHtml(String(s).replace(/[✅⚠️❌]/gu, "").trim())}</li>`).join("");
    const errors = (fb.error_parts || []).map(e => `
        <li><strong>${escapeHtml(String(e.error || "").replace(/[⚠️❌]/gu, "").trim())}</strong>
        ${e.correction ? `→ ${escapeHtml(String(e.correction).replace(/[⚠️❌]/gu, "").trim())}` : ""}
        ${e.explanation ? `<span class="qa-socratic-why">${escapeHtml(e.explanation)}</span>` : ""}</li>`).join("");
    return `
        ${correct ? `<ul class="qa-socratic-list qa-socratic-list-ok">${correct}</ul>` : ""}
        ${errors ? `<ul class="qa-socratic-list qa-socratic-list-bad">${errors}</ul>` : ""}
        ${fb.suggestions ? `<p class="qa-socratic-suggest">${escapeHtml(fb.suggestions)}</p>` : ""}
        ${fb.encouragement ? `<p class="qa-socratic-encourage">${escapeHtml(fb.encouragement)}</p>` : ""}
    `;
}

async function submitSocraticAnswer() {
    const st = QaState.socratic;
    if (!st || st.done) return;
    const q = st.questions[st.index];
    const ans = ($("#socratic-answer")?.value || "").trim();
    if (!ans) { showToast("请先写下你的回答", "info"); return; }

    const submitBtn = $("#btn-socratic-submit");
    const answerBox = $("#socratic-answer");
    // 09-10 用户裁定：不弹整面加载蒙版，只在按钮上显示「批改中」，批改完就地展示反馈
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "批改中..."; }
    if (answerBox) answerBox.disabled = true;
    try {
        const res = await api("/api/grade_answer", {
            method: "POST",
            body: JSON.stringify({
                question: {
                    question_type: "socratic",   // 走 /api/grade_answer 苏格拉底分支（同管线 + 缓存）
                    socratic_type: q.type,
                    grammar_point: q.point || "",
                    stem: q.stem,
                    reference_answer: q.reference,
                },
                user_answer: ans,
                level: AppState.config.level || "N4",
            }),
        });
        const fb = res.feedback || {};
        st.results.push({ q, answer: ans, feedback: fb, correct: (typeof fb.score === "number" ? fb.score : 0) >= 5 });
        renderSocraticPanel();
    } catch (err) {
        // 失败恢复输入，可重试
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "提交回答"; }
        if (answerBox) answerBox.disabled = false;
        showToast(`批改失败：${err.message}`, "error");
    }
}

async function nextSocraticQuestion() {
    const st = QaState.socratic;
    if (!st || st.done) return;   // done 守卫：结算页/重复点击不再推进（防 SM-2 双写）
    st.index += 1;
    if (st.index >= st.questions.length) {
        st.done = true;
        await saveSocraticSm2();   // 结算前完成 SM-2 联动
    }
    renderSocraticPanel();
}

// SM-2 联动：所讲语法点按本轮平均分过一次 learned_content（新点明天到期，旧点按 SM-2 推进）
async function saveSocraticSm2() {
    const st = QaState.socratic;
    if (!st) return;
    const points = [...new Set(st.questions.map(q => (q.point || "").trim()).filter(Boolean))];
    if (!points.length) { st.sm2 = { saved: false }; return; }
    const avg = st.results.length
        ? st.results.reduce((s, r) => s + (typeof r.feedback.score === "number" ? r.feedback.score : 0), 0) / st.results.length
        : 0;
    const score = Math.round(avg * 10) / 10;
    let isNew = false;
    try {
        const learnedMap = await loadLearnedMap();
        isNew = points.some(p => !learnedMap.has(normalizeGP(p)));
    } catch { /* 拉取失败不影响写入 */ }
    try {
        await api("/api/learned_content", {
            method: "POST",
            body: JSON.stringify({
                items: points.map(p => ({
                    grammar_point: p,
                    score,
                    level: AppState.config.level || "N4",
                })),
            }),
        });
        points.forEach(p => AppState.immediateSaved.add(p));  // 后续练习弹窗不重复入库
        st.sm2 = { saved: true, isNew };
    } catch {
        st.sm2 = { saved: false };   // 静默失败：结算条提示未入复习计划
    }
}

function renderSocraticSettlement() {
    const st = QaState.socratic;
    const correctCount = st.results.filter(r => r.correct).length;
    const rows = st.results.map((r, i) => `
        <div class="qa-socratic-result-row">
            <span class="qa-socratic-verdict ${r.correct ? "ok" : "bad"}">${r.correct ? "✓" : "✗"}</span>
            <span class="qa-socratic-result-label">第 ${i + 1} 问 · ${escapeHtml(SOCRATIC_TYPE_LABELS[r.q.type] || r.q.type)}</span>
            ${r.q.point ? `<span class="qa-socratic-result-point">${escapeHtml(r.q.point)}</span>` : ""}
        </div>`).join("");

    const sm2 = st.sm2 || { saved: false };
    const sm2Text = sm2.saved
        ? (sm2.isNew ? "本次语法点已加入复习计划（明天到期）" : "复习计划已更新，按艾宾浩斯曲线安排下次复习")
        : "复习计划更新失败，本次结果未入库";
    const sm2Icon = sm2.saved ? "calendar-check" : "calendar-x";

    return `
        <div class="qa-result-divider"></div>
        <div class="qa-socratic-card card qa-socratic-settlement">
            <div class="qa-socratic-header">
                <span class="qa-socratic-badge"><i data-lucide="check-check" style="width:13px;height:13px"></i> 考考我 · 结算</span>
                <span class="qa-socratic-progress">${correctCount} / ${st.results.length} 问答到要点</span>
            </div>
            <div class="qa-socratic-results">${rows}</div>
            <div class="qa-socratic-sm2 ${sm2.saved ? "" : "failed"}">
                <i data-lucide="${sm2Icon}" style="width:14px;height:14px"></i> ${sm2Text}
            </div>
            <div class="qa-action-row">
                <button class="btn btn-primary" id="btn-socratic-again"><i data-lucide="rotate-ccw" style="width:16px;height:16px"></i> 再考一轮</button>
            </div>
        </div>
    `;
}

// ============================================================
// 答疑（QA）M3 — 待确认池（KB-3/KB-4）
// ============================================================
async function toggleQaPendingPanel() {
    const panel = $("#qa-pending-panel");
    if (!panel) return;
    QaState.pendingVisible = !QaState.pendingVisible;
    panel.style.display = QaState.pendingVisible ? "" : "none";
    if (QaState.pendingVisible) {
        await renderQaPendingList();
        if (panel.scrollIntoView) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
}

function qaPendingStatus(msg, isError) {
    const el = $("#qa-pending-status");
    if (!el) return;
    el.textContent = msg;
    el.className = "qa-pending-status" + (isError ? " error-text" : "");
    show(el);
}

async function renderQaPendingList() {
    const panel = $("#qa-pending-panel");
    if (!panel) return;
    panel.innerHTML = `
        <div class="qa-pending-header">
            <h3><i data-lucide="inbox" style="width:18px;height:18px"></i> 待确认池</h3>
            <button class="btn btn-text btn-sm" id="btn-qa-pending-close">收起</button>
        </div>
        <p class="input-hint">答疑解析出的知识点在此待确认，确认后才会进入复习计划；不需要的忽略或丢弃即可。</p>
        <div id="qa-pending-body"><p class="input-hint">加载中...</p></div>
        <p class="qa-pending-status" id="qa-pending-status" style="display:none;"></p>
    `;
    refreshIcons();
    $("#btn-qa-pending-close").onclick = () => {
        QaState.pendingVisible = false;
        panel.style.display = "none";
    };
    try {
        const res = await api("/api/qa/pending");
        renderQaPendingBody(res.items || []);
    } catch (err) {
        qaPendingStatus(err.message, true);
    }
}

function renderQaPendingBody(items) {
    const body = $("#qa-pending-body");
    if (!body) return;
    if (!items.length) {
        body.innerHTML = `<p class="input-hint">待确认池是空的。</p>`;
        return;
    }
    body.innerHTML = items.map(item => {
        const tags = (item.knowledge_tags || []).map(t =>
            `<span class="qa-tag-chip qa-tag-${t.type || "comprehension"}">${escapeHtml(t.tag)}</span>`
        ).join(" ");
        const conf = typeof item.ai_confidence === "number"
            ? ` · 置信度 ${Math.round(item.ai_confidence * 100)}%` : "";
        return `
            <div class="qa-pending-item" data-id="${escapeHtml(item.id)}">
                <div class="qa-pending-item-head">
                    <span class="qa-pending-item-time">${escapeHtml((item.parsed_at || "").slice(0, 16))}</span>
                    <span class="qa-pending-item-mode">AI 推断${conf}</span>
                </div>
                <p class="qa-pending-item-preview">${escapeHtml(item.content_preview || "")}</p>
                <div class="qa-pending-item-tags">${tags}</div>
                ${item.ai_answer ? `<p class="qa-pending-item-answer">${escapeHtml(item.ai_answer)}</p>` : ""}
                <div class="qa-pending-item-actions">
                    <button class="btn btn-primary btn-sm qa-pending-confirm">确认入库</button>
                    <button class="btn btn-secondary btn-sm qa-pending-reparse">补答案键重解析</button>
                    <button class="btn btn-text btn-sm qa-pending-discard">丢弃</button>
                </div>
                <div class="qa-reparse-box" style="display:none;">
                    <input type="text" class="input" placeholder="粘贴这道题的标准答案，重新解析后覆盖 AI 推断" autocomplete="off">
                    <button class="btn btn-primary btn-sm qa-reparse-submit">重新解析</button>
                </div>
            </div>`;
    }).join("");
    refreshIcons();

    body.querySelectorAll(".qa-pending-confirm").forEach(btn => {
        btn.onclick = () => confirmQaPending(btn.closest(".qa-pending-item").dataset.id);
    });
    body.querySelectorAll(".qa-pending-discard").forEach(btn => {
        btn.onclick = () => discardQaPending(btn.closest(".qa-pending-item").dataset.id);
    });
    body.querySelectorAll(".qa-pending-reparse").forEach(btn => {
        btn.onclick = () => {
            const box = btn.closest(".qa-pending-item").querySelector(".qa-reparse-box");
            box.style.display = box.style.display === "none" ? "" : "none";
        };
    });
    body.querySelectorAll(".qa-reparse-submit").forEach(btn => {
        btn.onclick = async () => {
            const item = btn.closest(".qa-pending-item");
            const answerKey = item.querySelector(".qa-reparse-box input").value.trim();
            await reparseQaPending(item.dataset.id, answerKey);
        };
    });
}

async function confirmQaPending(id) {
    showLoading("正在确认入库...");
    try {
        const res = await api("/api/qa/pending/confirm", {
            method: "POST",
            body: JSON.stringify({ ids: [id] }),
        });
        hideLoading();
        let msg = `已确认 ${res.confirmed} 条知识点入库`;
        if (res.fuzzy && res.fuzzy.length) {
            msg += `；${res.fuzzy.length} 条存在相近知识点，需进一步核对`;
        }
        qaPendingStatus(msg);
        renderQaPendingList();
    } catch (err) {
        hideLoading();
        qaPendingStatus(err.message, true);
    }
}

async function discardQaPending(id) {
    showLoading("正在丢弃...");
    try {
        const res = await api("/api/qa/pending/discard", {
            method: "POST",
            body: JSON.stringify({ ids: [id] }),
        });
        hideLoading();
        qaPendingStatus(`已丢弃 ${res.discarded} 条`);
        renderQaPendingList();
    } catch (err) {
        hideLoading();
        qaPendingStatus(err.message, true);
    }
}

async function reparseQaPending(id, answerKey) {
    if (!answerKey) { qaPendingStatus("请先填写这道题的标准答案", true); return; }
    showLoading("正在重新解析...");
    try {
        const res = await api("/api/qa/pending/reparse", {
            method: "POST",
            body: JSON.stringify({ id, answer_key: answerKey, level: AppState.config.level || "N4" }),
        });
        hideLoading();
        QaState.result = res.result;
        QaState.detailShown = false;
        qaPendingStatus("已按标准答案重新解析，请再次「确认入库」");
        renderQaPendingList();
        if (QaState.result) renderQaResult(QaState.result);
    } catch (err) {
        hideLoading();
        qaPendingStatus(err.message, true);
    }
}

// ============================================================
// 屏幕 11：精读（Beta 7.0 M2/M3，prd-v7.md §2.2~§2.8；M3.5 修缮见 §2.9）
// 三视图：文章列表 home / 输入标注 input / 正文精读 article；
// 词级 ruby 渲染走 M1 的 pos 坐标，前端再做一次重叠拒绝兜底；
// 语法清单（matched 语法点）→ 练这些 → /api/reading/practice → beginPractice。
// 清单键（B1）：textbook_point 优先、pattern 回退，加一个点只红该点各处。
// ============================================================
const READING_MAX_CHARS = 8000;

const ReadingState = {
    view: "home",            // home | input | article
    entry: "text",           // 输入入口：text | image | pdf
    content: "",
    source: "paste",
    listStatus: "",          // 文章列表过滤："" | reading | archived
    articles: [],
    article: null,           // 当前打开的文章（含 annotated）
    basket: [],              // 当前文章语法清单（清单键列表，前端持有全量）
    annotateReqId: null,
    annotateCleanup: null,
    segData: {},             // "sent:idx" → 词/语法数据（渲染后事件委托查表）
    pendingVocab: null,      // 释义卡当前词
    pendingGrammarKey: "",   // 语法卡当前清单键
    practiceQtype: "translation",
    fileBound: false,
};

function showReadingScreen() {
    showScreen("reading");
    setDockActive("reading");
    initReadingScreen();
}

let _readingModalsBound = false;
async function initReadingScreen() {
    if (!_readingModalsBound) {
        _readingModalsBound = true;
        // 弹窗关闭（静态 DOM，只绑一次）
        [["btn-reading-vocab-close", "modal-reading-vocab"],
         ["btn-reading-vocab-cancel", "modal-reading-vocab"],
         ["btn-reading-grammar-close", "modal-reading-grammar"],
         ["btn-reading-grammar-cancel", "modal-reading-grammar"]].forEach(([btnId, modalId]) => {
            const b = $(`#${btnId}`), m = $(`#${modalId}`);
            if (b && m) b.onclick = () => hide(m);
        });
        ["modal-reading-vocab", "modal-reading-grammar", "modal-reading-practice"].forEach(id => {
            const m = $(`#${id}`);
            if (m) m.onclick = (e) => { if (e.target === m) hide(m); };
        });
        $("#btn-reading-practice-cancel").onclick = () => hide($("#modal-reading-practice"));
        $("#btn-reading-practice-close").onclick = () => hide($("#modal-reading-practice"));
        $$("#modal-reading-practice .reading-qtype-btn").forEach(btn => {
            btn.onclick = () => {
                ReadingState.practiceQtype = btn.dataset.qtype || "translation";
                $$("#modal-reading-practice .reading-qtype-btn").forEach(b =>
                    b.classList.toggle("active", b === btn));
            };
        });
        $("#btn-reading-practice-confirm").onclick = confirmReadingPractice;
        $("#reading-practice-more").onclick = () => {
            hide($("#modal-reading-practice"));
            goToPracticeWithBasket();
        };
        $("#btn-reading-grammar-basket").onclick = toggleReadingBasketFromModal;
        $("#btn-reading-vocab-save").onclick = saveReadingVocabFromModal;
    }
    // 入口规则（B3）：文章数为 0 → 直达输入视图（首用一击直达）；>0 → 进列表
    try {
        const data = await api("/api/reading/articles");
        if (((data && data.articles) || []).length === 0) {
            renderReadingInput();
            return;
        }
    } catch (e) { /* 读取失败回退列表视图展示错误 */ }
    renderReadingView();
}

function renderReadingView() {
    if (ReadingState.view === "input") renderReadingInput();
    else if (ReadingState.view === "article") renderReadingArticle();
    else renderReadingHome();
}

// ---------- 视图一：文章列表 ----------
async function renderReadingHome() {
    ReadingState.view = "home";
    cancelReadingAnnotate();
    const root = $("#reading-root");
    root.classList.remove("has-basket-space");
    const filterLabel = (s) => s === "reading" ? "阅读中" : s === "archived" ? "已归档" : "全部";
    root.innerHTML = `
        <div class="card config-card" data-glow>
            <div class="config-card-header">
                <i data-lucide="book-open" style="width:18px;height:18px"></i>
                <span>我的文章</span>
                <button class="btn btn-primary btn-sm" id="btn-reading-new" style="margin-left:auto">
                    <i data-lucide="plus" style="width:16px;height:16px"></i> 新建精读
                </button>
            </div>
            <div class="reading-filter-row" id="reading-filter-row">
                ${["", "reading", "archived"].map(s => `
                    <button class="reading-filter-chip ${ReadingState.listStatus === s ? "active" : ""}" data-status="${s}">${filterLabel(s)}</button>
                `).join("")}
            </div>
            <div id="reading-list"><p class="input-hint">正在加载...</p></div>
        </div>
    `;
    refreshIcons();
    $("#btn-reading-new").onclick = () => renderReadingInput();
    $$("#reading-filter-row .reading-filter-chip").forEach(chip => {
        chip.onclick = () => { ReadingState.listStatus = chip.dataset.status; renderReadingHome(); };
    });

    try {
        const data = await api(`/api/reading/articles?status=${encodeURIComponent(ReadingState.listStatus)}`);
        ReadingState.articles = (data && data.articles) || [];
    } catch (err) {
        $("#reading-list").innerHTML = `<p class="error-text">${escapeHtml(err.message || "加载失败")}</p>`;
        return;
    }
    if (ReadingState.view !== "home") return;  // 用户已切走
    const list = $("#reading-list");
    if (!list) return;
    if (ReadingState.articles.length === 0) {
        list.innerHTML = `<p class="input-hint">还没有文章。点击「新建精读」，粘贴一段日文文章开始。</p>`;
        return;
    }
    list.innerHTML = ReadingState.articles.map(a => `
        <div class="reading-article-item" data-id="${escapeHtml(a.id)}">
            <div class="reading-article-main">
                <div class="reading-article-title">
                    ${a.level ? `<span class="rd-level-badge">${escapeHtml(a.level)}</span>` : ""}
                    <span class="reading-article-name">${escapeHtml(a.title || "未命名文章")}</span>
                    <span class="reading-article-status ${a.status === "archived" ? "is-archived" : ""}">${a.status === "archived" ? "已归档" : "阅读中"}</span>
                </div>
                <p class="reading-article-meta">${a.sentence_count || 0} 句 · 命中语法 ${a.grammar_hit_count || 0} · ${escapeHtml((a.created_at || "").slice(0, 10))}</p>
            </div>
            <div class="reading-article-actions">
                <button class="btn-icon rd-act-icon rd-act" data-act="open" title="打开文章"><i data-lucide="book-open" style="width:16px;height:16px"></i></button>
                ${a.status === "archived"
                    ? `<button class="btn-icon rd-act-icon rd-act" data-act="reopen" title="恢复阅读"><i data-lucide="rotate-ccw" style="width:16px;height:16px"></i></button>`
                    : `<button class="btn-icon rd-act-icon rd-act" data-act="archive" title="读完归档"><i data-lucide="archive" style="width:16px;height:16px"></i></button>`}
                <button class="btn-icon rd-act-icon rd-act rd-act-danger" data-act="delete" title="删除"><i data-lucide="trash-2" style="width:16px;height:16px"></i></button>
            </div>
        </div>
    `).join("");
    $$("#reading-list .rd-act").forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();  // 防触发整行打开
            readingArticleAction(btn.closest(".reading-article-item").dataset.id, btn.dataset.act);
        };
    });
    // 整行可点击进入文章（图标按钮只是快捷入口）
    $$("#reading-list .reading-article-item").forEach(item => {
        item.onclick = () => readingArticleAction(item.dataset.id, "open");
    });
    refreshIcons();  // 列表在 await 后注入，图标必须在此补刷新（否则按钮全空白）
}

async function readingArticleAction(id, act) {
    if (act === "open") {
        showLoading("正在打开文章...");
        try {
            const data = await api(`/api/reading/articles/${encodeURIComponent(id)}`);
            hideLoading();
            if (!data.success || !data.article) throw new Error("文章读取失败");
            ReadingState.article = data.article;
            setReadingBasket(data.article.basket || []);
            renderReadingArticle();
        } catch (err) {
            hideLoading();
            showToast(err.message || "打开失败", "error");
        }
        return;
    }
    if (act === "delete") {
        const ok = await showConfirm({
            title: "删除文章",
            message: "删除后无法恢复，确定删除这篇文章吗？",
            danger: true,
        });
        if (!ok) return;
    }
    if (act === "archive") {
        // 归档 = 纯整理动作（B3），可逆，确认里说清
        const ok = await showConfirm({
            title: "读完归档",
            message: "把这篇文章标记为已读完？归档只是整理，不影响任何功能，可随时「恢复阅读」。",
        });
        if (!ok) return;
    }
    try {
        const data = await api("/api/reading/articles", {
            method: "POST",
            body: JSON.stringify({ id, action: act }),
        });
        showToast(data.message || "操作成功");
        if (ReadingState.article && ReadingState.article.id === id && act !== "delete") {
            ReadingState.article.status = act === "archive" ? "archived" : "reading";
        }
        // 操作后立即重渲染当前视图，按钮状态实时同步（B3，防「点不动」观感）
        if (act !== "delete" && ReadingState.view === "article"
            && ReadingState.article && ReadingState.article.id === id) {
            renderReadingArticle();
        } else if (ReadingState.view === "home") {
            renderReadingHome();
        }
    } catch (err) {
        showToast(err.message || "操作失败", "error");
    }
}

// ---------- 视图二：输入 + 标注 ----------
function renderReadingInput() {
    ReadingState.view = "input";
    const root = $("#reading-root");
    root.classList.remove("has-basket-space");
    root.innerHTML = `
        <div class="card config-card" data-glow>
            <div class="config-card-header">
                <i data-lucide="layout-grid" style="width:18px;height:18px"></i>
                <span>文章来源</span>
                <button class="btn btn-text btn-sm" id="btn-reading-back-home" style="margin-left:auto">返回列表</button>
            </div>
            <div class="qa-entry-grid" id="reading-entry-grid">
                <div class="qa-entry-card" data-entry="image">
                    <div class="qa-entry-icon"><i data-lucide="camera" style="width:22px;height:22px"></i></div>
                    <span class="qa-entry-name">图片</span>
                    <small class="qa-entry-desc">拍照 / 截图</small>
                </div>
                <div class="qa-entry-card" data-entry="pdf">
                    <div class="qa-entry-icon"><i data-lucide="file-text" style="width:22px;height:22px"></i></div>
                    <span class="qa-entry-name">PDF</span>
                    <small class="qa-entry-desc">上传文档</small>
                </div>
                <div class="qa-entry-card active" data-entry="text">
                    <div class="qa-entry-icon"><i data-lucide="pencil" style="width:22px;height:22px"></i></div>
                    <span class="qa-entry-name">文字</span>
                    <small class="qa-entry-desc">粘贴文章</small>
                </div>
            </div>
        </div>

        <div class="card config-card" data-glow id="reading-text-area">
            <div class="config-card-header">
                <i data-lucide="pencil-line" style="width:18px;height:18px"></i>
                <span>日文文章</span>
            </div>
            <textarea id="reading-content-input" class="input textarea reading-content-input" placeholder="粘贴日文文章。例如：&#10;毎朝、駅前のパン屋でパンを買います。&#10;店員のおばさんはいつも笑顔で、「いらっしゃいませ」と言います。"></textarea>
            <p class="input-hint" id="reading-char-count">0 字</p>
        </div>

        <div class="card config-card" data-glow id="reading-file-upload" style="display:none;">
            <div class="config-card-header">
                <i data-lucide="pencil-line" style="width:18px;height:18px"></i>
                <span>文章内容</span>
            </div>
            <label class="input-label" id="reading-file-label">上传文件</label>
            <div class="qa-drop-zone" id="reading-drop-zone">
                <i data-lucide="upload" style="width:28px;height:28px"></i>
                <p id="reading-drop-text">拖拽文件到这里，或点击选择</p>
                <span class="qa-drop-hint" id="reading-drop-hint">支持 PDF / PNG / JPG / WebP，最大 10 MB</span>
                <input type="file" id="reading-file-input" accept=".pdf,image/png,image/jpg,image/jpeg,image/webp" hidden>
            </div>
            <div class="qa-media-notice">
                <i data-lucide="alert-triangle" style="width:16px;height:16px"></i>
                <p>应用自带识别功能准确率较低，建议使用外置识别工具</p>
            </div>
            <p class="input-hint" id="reading-file-status"></p>
        </div>

        <div class="main-start">
            <button class="btn btn-primary btn-full btn-lg" id="btn-reading-annotate">
                <i data-lucide="sparkles" style="width:20px;height:20px"></i> 开始精读
            </button>
            <div id="reading-progress" style="display:none;">
                <div class="spinner"></div>
                <p id="reading-progress-text">正在标注...</p>
                <button class="btn btn-text btn-sm" id="btn-reading-annotate-cancel">取消</button>
            </div>
            <p id="reading-error" class="error-text" style="display:none;"></p>
        </div>
    `;
    refreshIcons();
    ReadingState.fileBound = false;

    $("#btn-reading-back-home").onclick = () => renderReadingHome();
    $$("#reading-entry-grid .qa-entry-card").forEach(el => {
        el.onclick = () => readingSetEntry(el.dataset.entry);
    });
    $("#reading-content-input").oninput = () => {
        ReadingState.content = $("#reading-content-input").value;
        updateReadingCharCount();
    };
    $("#reading-content-input").value = ReadingState.content;
    updateReadingCharCount();
    readingSetEntry(ReadingState.entry);
    $("#btn-reading-annotate").onclick = startReadingAnnotate;
    $("#btn-reading-annotate-cancel").onclick = () => {
        cancelReadingAnnotate();
        $("#reading-progress").style.display = "none";
        $("#btn-reading-annotate").disabled = false;
    };
}

function readingSetEntry(type) {
    ReadingState.entry = type;
    $$("#reading-entry-grid .qa-entry-card").forEach(el => {
        el.classList.toggle("active", el.dataset.entry === type);
    });
    const textArea = $("#reading-text-area");
    const fileUpload = $("#reading-file-upload");
    if (type === "text") {
        if (textArea) textArea.style.display = "";
        if (fileUpload) fileUpload.style.display = "none";
    } else {
        if (textArea) textArea.style.display = "none";
        if (fileUpload) fileUpload.style.display = "";
        const label = $("#reading-file-label"), dropText = $("#reading-drop-text"), hint = $("#reading-drop-hint");
        if (type === "pdf") {
            if (label) label.textContent = "上传 PDF";
            if (dropText) dropText.textContent = "拖拽 PDF 文件到这里，或点击选择";
            if (hint) hint.textContent = "支持 .pdf，最大 10 MB，最多 50 页";
        } else {
            if (label) label.textContent = "上传图片";
            if (dropText) dropText.textContent = "拖拽截图 / 照片到这里，或点击选择";
            if (hint) hint.textContent = "支持 PNG / JPG / WebP，最大 10 MB";
        }
        bindReadingFileUpload();
    }
}

function bindReadingFileUpload() {
    if (ReadingState.fileBound) return;
    const dropZone = $("#reading-drop-zone");
    const fileInput = $("#reading-file-input");
    if (!dropZone || !fileInput) return;
    ReadingState.fileBound = true;

    dropZone.onclick = () => fileInput.click();
    ["dragenter", "dragover"].forEach(ev => {
        dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add("qa-drop-active"); });
    });
    ["dragleave", "drop"].forEach(ev => {
        dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove("qa-drop-active"); });
    });
    dropZone.addEventListener("drop", e => {
        if (e.dataTransfer.files.length) handleReadingFile(e.dataTransfer.files[0]);
    });
    fileInput.onchange = () => {
        if (fileInput.files.length) handleReadingFile(fileInput.files[0]);
    };
}

async function handleReadingFile(file) {
    const n = (file && file.name || "").toLowerCase();
    const isPdf = /\.pdf$/.test(n);
    const isImg = /\.(png|jpe?g|webp)$/.test(n);
    const statusEl = $("#reading-file-status");
    if (!isPdf && !isImg) {
        if (statusEl) statusEl.textContent = "请选择 PDF 或图片（PNG / JPG / WebP）";
        return;
    }
    if (file.size > 10 * 1024 * 1024) {
        if (statusEl) statusEl.textContent = "文件过大（最大 10 MB）";
        return;
    }
    if (statusEl) statusEl.textContent = `正在${isPdf ? "提取 PDF 文字" : "识别图片文字"}（${(file.size / 1024 / 1024).toFixed(1)} MB）…`;
    try {
        const data = await apiUpload("/api/qa/upload", file);
        if (!data.success) {
            if (statusEl) statusEl.textContent = data.warning || data.error || "提取失败";
            return;
        }
        if (statusEl) statusEl.textContent = isPdf
            ? `已提取 ${data.pages} 页，${data.text.length} 字`
            : `已识别图片文字（${data.text.length} 字）`;
        ReadingState.content = data.text;
        ReadingState.source = isPdf ? "pdf" : "image";
        $("#reading-content-input").value = data.text;
        updateReadingCharCount();
        // 回填 textarea，切回文字入口让用户校对后再标注
        readingSetEntry("text");
    } catch (err) {
        if (statusEl) statusEl.textContent = `上传失败：${err.message}`;
    }
}

function updateReadingCharCount() {
    const el = $("#reading-char-count");
    if (el) el.textContent = `${($("#reading-content-input").value || "").length} 字`;
}

// 流式标注（桥优先 → dev SSE → 同步回退）
function startReadingAnnotate() {
    const content = ($("#reading-content-input").value || "").trim();
    if (!content) { showError("reading-error", "请先粘贴日文文章"); return; }
    if (content.length > READING_MAX_CHARS) {
        showError("reading-error", `正文过长（最多 ${READING_MAX_CHARS} 字符，当前 ${content.length}）`);
        return;
    }
    if (!qaHasJapanese(content)) {
        showError("reading-error", "未检测到日语内容，请粘贴日文文章");
        return;
    }
    hide($("#reading-error"));
    ReadingState.content = content;
    ReadingState.article = null;

    const progressEl = $("#reading-progress");
    const progressText = $("#reading-progress-text");
    const startBtn = $("#btn-reading-annotate");
    startBtn.disabled = true;
    if (progressEl) progressEl.style.display = "";
    const finishUI = () => {
        if (progressEl) progressEl.style.display = "none";
        const b = $("#btn-reading-annotate");
        if (b) b.disabled = false;
    };

    const onProgress = (payload) => {
        if (progressText && typeof payload.done === "number" && payload.total) {
            progressText.textContent = `正在精读 第 ${payload.done + 1}/${payload.total} 段...`;
        }
    };
    const onDone = (article) => {
        ReadingState.annotateCleanup = null;
        finishUI();
        ReadingState.article = article;
        setReadingBasket(article.basket || []);
        ReadingState.source = article.source || ReadingState.source;
        showToast("标注完成，开始精读吧");
        renderReadingArticle();
    };
    const onError = (err) => {
        ReadingState.annotateCleanup = null;
        finishUI();
        showError("reading-error", (err && err.message) || "标注失败，请重试");
    };

    const reqId = Math.random().toString(36).slice(2, 10);
    ReadingState.annotateReqId = reqId;

    // 桥模式：JsApi.reading_annotate_stream + annotate_chunk 事件（镜像批改流式）
    const cleanup = bridgeAnnotateStream(content, ReadingState.source, reqId, onProgress, onDone, onError);
    if (cleanup) {
        ReadingState.annotateCleanup = cleanup;
        return;
    }
    // 浏览器 dev：SSE 流式（标注耗时长，不做 20s 超时）
    if (location.protocol !== "file:") {
        ReadingState.annotateCleanup = readingSseStream("/api/reading/annotate/stream",
            JSON.stringify({ content, source: ReadingState.source }),
            onProgress, onDone, onError);
        return;
    }
    // 桥存在但事件通道不可用 → 同步回退
    if (!(window.pywebview && window.pywebview.api)) {
        showError("reading-error", "应用桥不可用，请重启应用后重试");
        finishUI();
        return;
    }
    (async () => {
        try {
            const data = await api("/api/reading/annotate", {
                method: "POST",
                body: JSON.stringify({ content, source: ReadingState.source }),
            });
            if (!data.success || !data.article) throw new Error("标注失败，请重试");
            onDone(data.article);
        } catch (err) {
            onError(err);
        }
    })();
}

// 桥流式标注：返回取消函数；启动失败返回 null → 调用方回退
function bridgeAnnotateStream(content, source, req_id, onProgress, onDone, onError) {
    if (typeof window.events === "undefined" || typeof window.events.annotate_chunk !== "object"
        || typeof window.events.annotate_chunk.addEventListener !== "function") return null;
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try { if (window.events.annotate_chunk.removeEventListener) window.events.annotate_chunk.removeEventListener(handler); } catch (e) {}
        try { window.pywebview.api.cancel_annotate_stream(req_id); } catch (e) {}
    };
    const handler = (payload) => {
        if (!payload || payload.req_id !== req_id) return;  // 丢弃旧流
        if (payload.kind === "done") {
            cleanup();
            onDone(payload.article);
        } else if (payload.kind === "error") {
            cleanup();
            onError(new Error(payload.message || "标注失败，请重试"));
        } else {
            onProgress(payload);
        }
    };
    let r;
    try { r = window.pywebview.api.reading_annotate_stream(content, source, req_id); }
    catch (e) { return null; }
    if (!r || !r.ok) return null;
    window.events.annotate_chunk.addEventListener(handler);
    return cleanup;
}

// dev SSE 流式标注（与 apiStream 同构，但不设 20s 超时——标注是多段 LLM 长任务）
function readingSseStream(url, body, onProgress, onDone, onError) {
    const ac = new AbortController();
    (async () => {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
                signal: ac.signal,
            });
            if (!res.ok) {
                let msg = "HTTP " + res.status;
                try {
                    const j = await res.json();
                    if (j && j.error) msg = j.error;
                } catch (e) {}
                throw new Error(msg);
            }
            if (!res.body) throw new Error("流式不可用");
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let sep;
                while ((sep = buf.indexOf("\n\n")) >= 0) {
                    const frame = buf.slice(0, sep);
                    buf = buf.slice(sep + 2);
                    let data = "";
                    frame.split("\n").forEach(line => {
                        if (line.startsWith("data:")) data = (data ? data + "\n" : "") + line.slice(5).trim();
                    });
                    if (!data) continue;
                    let payload;
                    try { payload = JSON.parse(data); } catch { continue; }
                    if (payload.kind === "done") { onDone(payload.article); return; }
                    if (payload.kind === "error") throw new Error(payload.message || "标注失败，请重试");
                    onProgress(payload);
                }
            }
            throw new Error("流式未完成");
        } catch (err) {
            if (err && err.name === "AbortError") return;  // 用户主动取消
            onError(err);
        }
    })();
    return () => { try { ac.abort(); } catch (e) {} };
}

function cancelReadingAnnotate() {
    if (ReadingState.annotateCleanup) {
        try { ReadingState.annotateCleanup(); } catch (e) {}
        ReadingState.annotateCleanup = null;
    }
}

// ---------- 视图三：正文精读 ----------
// 切片算法：词/语法 span 按 pos 排序（同位长者优先），重叠或越界直接跳过——
// 后端唯一定位验证之外的前端兜底，宁可少标绝不标错
function buildSentenceSegments(sent) {
    const spans = [];
    (sent.words || []).forEach(w => spans.push({ pos: w.pos, len: (w.surface || "").length, type: "vocab", data: w }));
    (sent.grammar_hits || []).forEach(g => spans.push({ pos: g.pos, len: (g.surface || "").length, type: "gram", data: g }));
    spans.sort((a, b) => (a.pos - b.pos) || (b.len - a.len));
    const out = [];
    let cursor = 0;
    for (const s of spans) {
        const start = typeof s.pos === "number" ? s.pos : -1;
        const end = start + s.len;
        if (start < cursor || start < 0 || end > (sent.text || "").length) continue;
        if (start > cursor) out.push({ type: "text", text: sent.text.slice(cursor, start) });
        out.push({ ...s, text: sent.text.slice(start, end) });
        cursor = end;
    }
    if (cursor < (sent.text || "").length) out.push({ type: "text", text: sent.text.slice(cursor) });
    return out;
}

function renderReadingArticle() {
    ReadingState.view = "article";
    const art = ReadingState.article;
    const root = $("#reading-root");
    if (!art) { renderReadingHome(); return; }
    root.classList.add("has-basket-space");  // 正文底部预留清单浮条空间（B2）
    const sentences = (art.annotated || {}).sentences || [];
    ReadingState.segData = {};
    ReadingState.hiddenLevels = new Set();  // 级别筛选：默认全显示（09-10 新增）
    const archived = art.status === "archived";
    const allWords = collectReadingWords();

    root.innerHTML = `
        <div class="card config-card reading-article-header">
            <div class="reading-article-head-row">
                <button class="btn btn-text btn-sm" id="btn-reading-back-list">
                    <i data-lucide="arrow-left" style="width:16px;height:16px"></i> 返回列表
                </button>
                <div class="reading-article-head-actions">
                    ${allWords.length ? `<button class="btn btn-secondary btn-sm" id="btn-reading-save-all">全部存入生词</button>` : ""}
                    <button class="btn btn-text btn-sm" id="btn-reading-toggle-status">${archived ? "恢复阅读" : "读完归档"}</button>
                </div>
            </div>
            <h2 class="reading-title">
                ${art.level ? `<span class="rd-level-badge">${escapeHtml(art.level)}</span>` : ""}
                ${escapeHtml(art.title || "未命名文章")}
            </h2>
            <div class="reading-legend">
                <span class="reading-legend-item"><span class="rd-legend-swatch rd-legend-vocab"></span>生词 · 点击看释义</span>
                <span class="reading-legend-item"><span class="rd-legend-swatch rd-legend-gram"></span>语法 · 点击加入/移出清单</span>
            </div>
            <div class="rd-level-filter" id="rd-level-filter">
                <span class="rd-level-filter-label">语法级别</span>
                ${["N5", "N4", "N3", "N2", "N1"].map(l =>
                    `<button class="rd-level-chip on" data-level="${l}">${l}</button>`).join("")}
            </div>
        </div>

        <div class="card config-card reading-body-card">
            <div class="reading-body" id="reading-body">
                ${sentences.map((sent, si) => {
                    const segs = buildSentenceSegments(sent);
                    ReadingState.segData[si] = segs;
                    return `
                    <div class="sentence">
                        <p class="wordline">${segs.map((seg, gi) => {
                            if (seg.type === "text") return `<span class="word"><span class="ruby"></span><span class="surface">${escapeHtml(seg.text)}</span></span>`;
                            const d = seg.data || {};
                            // 09-10：未匹配教材库的语法不标红不响应（无解释可看，纯文本呈现）；
                            // 匹配的挂 data-level 供级别筛选（.rd-level-chip 切换 data-hide）
                            if (seg.type === "gram" && !d.matched) {
                                return `<span class="word"><span class="ruby"></span><span class="surface">${escapeHtml(seg.text)}</span></span>`;
                            }
                            const cls = seg.type === "vocab"
                                ? "rd-vocab rd-clickable"
                                : `rd-gram rd-clickable ${ReadingState.basket.includes(gramKey(d)) ? "rd-in-basket" : ""}`;
                            const levelAttr = seg.type === "gram" ? ` data-level="${escapeHtml(d.level || "")}"` : "";
                            // note 默认不展开（B2）：正文只留 ruby + surface，注释走 title 提示与点击弹窗
                            const tip = d.note ? ` title="${escapeHtml(d.note)}"` : "";
                            return `<span class="word ${cls}"${tip}${levelAttr} data-kind="${seg.type}" data-sent="${si}" data-idx="${gi}">` +
                                `<span class="ruby">${escapeHtml(d.reading || "")}</span>` +
                                `<span class="surface">${escapeHtml(seg.text)}</span></span>`;
                        }).join("")}</p>
                        ${sent.translation ? `
                        <details class="rd-trans">
                            <summary>✎ 译文</summary>
                            <p>${escapeHtml(sent.translation)}</p>
                        </details>` : ""}
                    </div>`;
                }).join("")}
            </div>
        </div>

        <div class="reading-basket-bar" id="reading-basket-bar"></div>
    `;
    refreshIcons();

    $("#btn-reading-back-list").onclick = () => renderReadingHome();
    const toggleBtn = $("#btn-reading-toggle-status");
    if (toggleBtn) toggleBtn.onclick = () => {
        readingArticleAction(art.id, archived ? "reopen" : "archive");
    };
    const saveAllBtn = $("#btn-reading-save-all");
    if (saveAllBtn) saveAllBtn.onclick = saveAllReadingVocab;

    // 事件委托：词/语法点击
    const body = $("#reading-body");
    body.onclick = (e) => {
        const wordEl = e.target.closest(".word");
        if (!wordEl || !wordEl.dataset.kind) return;
        const seg = (ReadingState.segData[wordEl.dataset.sent] || [])[+wordEl.dataset.idx];
        if (!seg || seg.type === "text") return;
        if (seg.type === "vocab") openReadingVocabModal(seg.data);
        else if (seg.data.matched) openReadingGrammarModal(seg.data);  // 未匹配已按纯文本渲染，不会再进这里
    };

    // 语法级别筛选（09-10）：多选开关，取消的级别不标红；只改 data-hide 不重渲染（不丢滚动位置）
    const filterRow = $("#rd-level-filter");
    if (filterRow) {
        filterRow.querySelectorAll(".rd-level-chip").forEach(chip => {
            chip.onclick = () => {
                const lv = chip.dataset.level;
                const hidden = ReadingState.hiddenLevels;
                if (hidden.has(lv)) { hidden.delete(lv); chip.classList.add("on"); }
                else { hidden.add(lv); chip.classList.remove("on"); }
                if (hidden.size) body.dataset.hide = [...hidden].join(" ");
                else delete body.dataset.hide;
            };
        });
    }

    renderReadingBasketBar();
}

// 清单键（M3.5 B1）：教材语法点优先，未命中回退 LLM pattern——
// 同一语法点全文各处共用一个键，加一个只红该点各处
function gramKey(g) {
    return (g && g.matched && g.textbook_point) || (g && g.pattern) || "";
}

function setReadingBasket(list) {
    // 旧文章兼容：后端已把旧 pattern 键归一为 textbook_point 键，这里兜底去重
    const out = [];
    for (const k of (list || [])) {
        const key = String(k || "").trim();
        if (key && !out.includes(key)) out.push(key);
    }
    ReadingState.basket = out;
}

function countGramHits(key) {
    let n = 0;
    for (const sent of ((ReadingState.article.annotated || {}).sentences || [])) {
        for (const g of (sent.grammar_hits || [])) {
            if (g.matched && gramKey(g) === key) n += 1;
        }
    }
    return n;
}

function findGrammarHit(key) {
    const sentences = (ReadingState.article.annotated || {}).sentences || [];
    for (const sent of sentences) {
        for (const g of (sent.grammar_hits || [])) {
            if (g.matched && gramKey(g) === key) return g;
        }
    }
    return null;
}

function collectReadingWords() {
    const seen = new Set();
    const out = [];
    for (const sent of ((ReadingState.article.annotated || {}).sentences || [])) {
        for (const w of (sent.words || [])) {
            const surface = (w.surface || "").trim();
            if (!surface || seen.has(surface)) continue;
            seen.add(surface);
            out.push(w);
        }
    }
    return out;
}

// ---------- 语法清单（M3，M3.5 B1/B4 修缮） ----------
function toggleReadingBasket(key) {
    const i = ReadingState.basket.indexOf(key);
    const adding = i < 0;
    if (adding) ReadingState.basket.push(key);
    else ReadingState.basket.splice(i, 1);

    // 立即同步高亮（乐观更新，失败仅提示不回滚）
    const body = $("#reading-body");
    if (body) {
        body.querySelectorAll(".word.rd-gram").forEach(el => {
            const seg = (ReadingState.segData[el.dataset.sent] || [])[+el.dataset.idx];
            if (seg && seg.data && gramKey(seg.data) === key) {
                el.classList.toggle("rd-in-basket", adding);
            }
        });
    }
    renderReadingBasketBar();

    // 状态文案显式带范围（B1）：同点全文多处一起标红是预期行为，文案消除歧义
    if (adding) {
        const n = countGramHits(key);
        showToast(n > 1 ? `已加入清单（全文 ${n} 处已标红）` : "已加入清单");
    } else {
        showToast("已移出清单");
    }

    api("/api/reading/basket", {
        method: "POST",
        body: JSON.stringify({ id: ReadingState.article.id, patterns: ReadingState.basket.slice() }),
    }).catch(err => showToast(err.message || "语法清单保存失败", "error"));
}

function renderReadingBasketBar() {
    const bar = $("#reading-basket-bar");
    if (!bar) return;
    const matchedKeys = new Set();
    for (const sent of ((ReadingState.article.annotated || {}).sentences || [])) {
        for (const g of (sent.grammar_hits || [])) {
            if (g.matched) {
                const k = gramKey(g);
                if (k) matchedKeys.add(k);
            }
        }
    }
    const chips = ReadingState.basket.map(key => {
        const hit = findGrammarHit(key) || {};
        return `
        <button class="rd-basket-chip" data-key="${escapeHtml(key)}">
            ${escapeHtml(key)}
            ${hit.level ? `<b>${escapeHtml(hit.level)}</b>` : ""}
            <span class="rd-chip-x" data-remove title="移出清单">&times;</span>
        </button>`;
    }).join("");
    bar.innerHTML = `
        <div class="rd-basket-info">
            <i data-lucide="list-checks" style="width:18px;height:18px"></i>
            <span>已选 <b>${ReadingState.basket.length}</b> / 命中 <b>${matchedKeys.size}</b></span>
        </div>
        <div class="rd-basket-chips">${chips || `<span class="rd-basket-empty">点击文中浅红语法高亮，把语法点加入清单</span>`}</div>
        <div class="rd-basket-actions">
            ${ReadingState.basket.length ? `<button class="btn btn-text btn-sm" id="btn-reading-basket-clear">清空</button>
            <button class="btn btn-primary" id="btn-reading-practice-open">练这些</button>` : ""}
        </div>
    `;
    refreshIcons();
    $$("#reading-basket-bar .rd-basket-chip").forEach(chip => {
        chip.onclick = (e) => {
            if (e.target.closest("[data-remove]")) {
                toggleReadingBasket(chip.dataset.key);
                return;
            }
            const hit = findGrammarHit(chip.dataset.key);
            if (hit) openReadingGrammarModal(hit);
        };
    });
    const clearBtn = $("#btn-reading-basket-clear");
    if (clearBtn) clearBtn.onclick = () => {
        ReadingState.basket = [];
        const body = $("#reading-body");
        if (body) body.querySelectorAll(".word.rd-gram.rd-in-basket").forEach(el => el.classList.remove("rd-in-basket"));
        renderReadingBasketBar();
        api("/api/reading/basket", {
            method: "POST",
            body: JSON.stringify({ id: ReadingState.article.id, patterns: [] }),
        }).catch(err => showToast(err.message || "语法清单保存失败", "error"));
    };
    const openBtn = $("#btn-reading-practice-open");
    if (openBtn) openBtn.onclick = openReadingPracticeModal;
}

// ---------- 释义卡 / 语法卡（M2） ----------
function openReadingVocabModal(w) {
    ReadingState.pendingVocab = w;
    const savedSet = new Set(ReadingState.article.vocab_saved || []);
    const surface = (w.surface || "").trim();
    const saved = savedSet.has(surface);
    $("#reading-vocab-title").textContent = surface || "生词";
    $("#reading-vocab-reading").textContent = w.reading || "";
    $("#reading-vocab-note").textContent = w.note || "";
    const saveBtn = $("#btn-reading-vocab-save");
    saveBtn.disabled = saved;
    saveBtn.textContent = saved ? "已存入" : "存入词书";
    show($("#modal-reading-vocab"));
}

function saveReadingVocabFromModal() {
    const w = ReadingState.pendingVocab;
    if (!w) return;
    saveReadingVocab([w]);
    hide($("#modal-reading-vocab"));
}

async function saveReadingVocab(words) {
    const payload = words.map(w => ({
        word: (w.surface || "").trim(),
        reading: (w.reading || "").trim(),
        meaning: (w.note || "").trim(),
    })).filter(x => x.word);
    if (!payload.length) return;
    try {
        const data = await api("/api/reading/vocab_save", {
            method: "POST",
            body: JSON.stringify({ article_id: ReadingState.article.id, words: payload }),
        });
        const savedSet = new Set(ReadingState.article.vocab_saved || []);
        payload.forEach(x => savedSet.add(x.word));
        ReadingState.article.vocab_saved = [...savedSet];
        showToast(data.skipped > 0
            ? `已存入生词（新增 ${data.added}，词书中已有 ${data.skipped}）`
            : `已存入「${data.book_name || "精读生词"}」`);
    } catch (err) {
        showToast(err.message || "生词保存失败", "error");
    }
}

async function saveAllReadingVocab() {
    const savedSet = new Set(ReadingState.article.vocab_saved || []);
    const fresh = collectReadingWords().filter(w => !savedSet.has((w.surface || "").trim()));
    if (!fresh.length) {
        showToast("本文生词都已存入词书");
        return;
    }
    await saveReadingVocab(fresh);
}

function openReadingGrammarModal(g) {
    ReadingState.pendingGrammarKey = gramKey(g);
    $("#reading-grammar-title").textContent = g.textbook_point || g.pattern || "语法点";
    const metaParts = [];
    if (g.level) metaParts.push(`<span class="rd-level-badge">${escapeHtml(g.level)}</span>`);
    metaParts.push(g.matched
        ? `<span class="rd-match-badge is-ok">教材库</span>`
        : `<span class="rd-match-badge">未匹配教材库</span>`);
    $("#reading-grammar-meta").innerHTML = metaParts.join(" ");
    $("#reading-grammar-note").textContent = g.note || "";
    const basketBtn = $("#btn-reading-grammar-basket");
    if (g.matched) {
        basketBtn.style.display = "";
        const inBasket = ReadingState.basket.includes(gramKey(g));
        basketBtn.textContent = inBasket ? "移出清单" : "加入清单";
    } else {
        basketBtn.style.display = "none";
    }
    show($("#modal-reading-grammar"));
}

function toggleReadingBasketFromModal() {
    const key = ReadingState.pendingGrammarKey;
    if (!key) return;
    hide($("#modal-reading-grammar"));
    toggleReadingBasket(key);
}

// ---------- 练这些（M3：迷你配置 → 统一出题） ----------
function openReadingPracticeModal() {
    if (!ReadingState.basket.length) {
        showToast("语法清单为空，先点击文中语法高亮加入语法点", "error");
        return;
    }
    $("#reading-practice-points").textContent = "本次出题：" + ReadingState.basket.join("、");
    show($("#modal-reading-practice"));
}

async function confirmReadingPractice() {
    const qtype = ReadingState.practiceQtype || "translation";
    const levelSel = $("#reading-practice-level").value;
    const includeVocab = $("#reading-practice-vocab").checked;
    hide($("#modal-reading-practice"));
    AppState.questionType = qtype;
    if (levelSel) AppState.config.level = levelSel;
    // M4.5 P2：清单超过 12 点时截断（请求只带前 12 个）
    const patterns = ReadingState.basket.slice(0, MAX_FOCUS_TAGS);
    if (ReadingState.basket.length > MAX_FOCUS_TAGS) {
        showToast(`语法清单较多，本次聚焦前 ${MAX_FOCUS_TAGS} 个`, "info");
    }
    try {
        await beginPractice({
            notes: "",
            sessionNotes: "精读联动：" + patterns.join("、"),
            request: {
                url: "/api/reading/practice",
                body: {
                    article_id: ReadingState.article.id,
                    patterns: patterns,
                    level: levelSel || AppState.config.level || "N4",
                    question_type: qtype,
                    include_vocab: includeVocab,
                },
            },
        });
    } catch (err) {
        showToast(err.message || "出题失败，请重试", "error");
    }
}

// 更多设置：清单内语法点带去练习页（focus chips 预填），由用户在练习页继续配置
function goToPracticeWithBasket() {
    // 清单键本身已是 textbook_point 优先（B1），直接作为 focus tag
    const focusTags = ReadingState.basket.slice();
    AppState.selectedGrammarPoints = focusTags.map(t => ({ point: t, explanation: "" }));
    showMainScreen();
}

// ============================================================
// 主题管理
// ============================================================
function getTheme() { return localStorage.getItem('kotoba-theme') || 'auto'; }
function setTheme(theme) { localStorage.setItem('kotoba-theme', theme); applyTheme(); }
function applyTheme() {
    const theme = getTheme();
    // 自动模式跟随系统：系统深色时同样打 data-theme="dark"，让
    // [data-theme="dark"] 组件级深色覆盖与 CSS 变量翻转同时生效，
    // 保证「自动深色」与「手动深色」视觉完全一致（修复部分模块不深色）
    const prefersDark = typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.removeAttribute('data-theme');
    if (theme === 'dark' || (theme === 'auto' && prefersDark)) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    // 标题栏 DWM 配色跟随（后端无 hwnd 时静默空转，loaded 后补应用）
    const _dark = document.documentElement.getAttribute('data-theme') === 'dark';
    api('/api/window_theme', { dark: _dark }).catch(() => {});
}
applyTheme(); // 页面加载时立即应用
// 自动模式下系统主题切换 → 实时跟随（无需重启/刷新）
if (typeof window.matchMedia === "function") {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (getTheme() === "auto") applyTheme();
    });
}

// 页面加载完成后启动
document.addEventListener("DOMContentLoaded", () => {
    if (typeof lucide !== "undefined") lucide.createIcons();
    init();
    // 自绘下拉组件：替换原生 select 为统一样式的自定义下拉
    initCustomSelect($("#textbook-select"));
    initCustomSelect($("#vocab-source-select"));
    // Dock 导航
    if (typeof initDock === 'function') initDock();
    // 延迟确保 DOM 就绪
    setTimeout(() => {
        // BorderGlow — 给带 data-glow 的卡片加边缘发光
        if (typeof initBorderGlowCards === 'function') {
            initBorderGlowCards();
        }
    }, 600);

    // 关闭页面时自动退出 Flask（区分页面内跳转 vs 真正关闭）
    let _navTimestamp = 0;
    const _origShowScreen = showScreen;
    showScreen = function(name) {
        _navTimestamp = Date.now();
        // 切页兜底：取消活跃流式批改，并复位提交按钮（防流式态残留「批改中...」）
        cancelGradeStream();
        if (typeof cancelReadingAnnotate === "function") cancelReadingAnnotate();  // 精读标注流兜底取消
        // M4.5：切走练习流程（main/quiz 除外）时清除笔记 >12 聚焦提示
        if (name !== "main" && name !== "quiz") clearNotesFocusHint();
        const sb = $("#btn-submit"); if (sb) { sb.disabled = false; sb.textContent = "提交"; }
        const eb = $("#btn-essay-submit"); if (eb) { eb.disabled = false; eb.textContent = "提交作文"; }
        return _origShowScreen(name);
    };
    window.addEventListener("beforeunload", () => {
        // 500ms 内有页面跳转 → 是应用内导航，不杀进程
        if (Date.now() - _navTimestamp < 500) return;
        // 桥模式：关窗即退出进程（webview.start() 返回），无需 sendBeacon；
        // 浏览器 dev 模式仍需通知后端退出
        if (window.pywebview && window.pywebview.api) return;
        navigator.sendBeacon("/api/shutdown");
    });
});
