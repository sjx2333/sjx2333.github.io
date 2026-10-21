const state = { level: "N3", wrongBook: false, questions: [], index: 0, score: 0, answered: false };
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>\"]/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;",
    }[char]));
}

let bridgePromise;
function waitBridge() {
    if (window.pywebview?.api?.fetch_api) return Promise.resolve(true);
    if (!bridgePromise) bridgePromise = new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (window.pywebview?.api?.fetch_api) {
                clearInterval(timer); resolve(true);
            } else if (Date.now() - started > 1500) {
                clearInterval(timer); resolve(false);
            }
        }, 20);
    });
    return bridgePromise;
}

async function api(url, options = {}) {
    if (await waitBridge()) {
        const result = await window.pywebview.api.fetch_api(
            (options.method || "GET").toUpperCase(), url, options.body || null,
        );
        if (!result?.ok) throw new Error(result?.data?.error || `请求失败 (${result?.status || "未知"})`);
        return result.data;
    }
    if (location.protocol === "file:") return localApi(url, options);
    try {
        const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
        if (response.ok) return await response.json();
        if (!url.startsWith("/api/question_bank/")) throw new Error("请求失败");
    } catch (error) {
        if (!url.startsWith("/api/question_bank/")) throw error;
    }
    return localApi(url, options);
}

function showView(id) {
    ["home-view", "quiz-view", "summary-view"].forEach((name) => { $(`#${name}`).hidden = name !== id; });
}

const localBankCache = {};
const LOCAL_PROGRESS_KEY = "kotoba-question-bank-progress-v1";

function localToday() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function readLocalProgress() {
    try { return JSON.parse(localStorage.getItem(LOCAL_PROGRESS_KEY) || '{"levels":{}}'); }
    catch { return { levels: {} }; }
}

function writeLocalProgress(progress) {
    localStorage.setItem(LOCAL_PROGRESS_KEY, JSON.stringify(progress));
}

function localQuestionView(item, index) {
    const options = item.options && !Array.isArray(item.options)
        ? ["1", "2", "3", "4"].filter((key) => key in item.options).map((key) => item.options[key])
        : (item.options || []);
    const answerIndex = Number(item.answer_index) - 1;
    if (!item.question || options.length < 2 || answerIndex < 0 || answerIndex >= options.length) return null;
    const detail = item.explanation || {};
    const correctExplanation = typeof detail === "object" ? String(detail.correct || "") : String(detail);
    let targetText = "";
    if (item.category === "文字") {
        const match = correctExplanation.match(/[一-鿿]/);
        if (match) {
            const start = item.question.indexOf(match[0]);
            if (start >= 0) {
                let end = start + 1;
                while (end < item.question.length && /[一-鿿]/.test(item.question[end])) end += 1;
                while (end < item.question.length && /[ぁ-ゖァ-ヺー]/.test(item.question[end])) end += 1;
                targetText = item.question.slice(start, end);
            }
        }
    }
    return {
        id: `bank-${item.id ?? index}`, question_type: "fill_blank", stem: item.question,
        target_text: targetText, options: options.map(String), correct_option: answerIndex,
        explanation: correctExplanation || String(item.translation_detail || ""),
        grammar_point: item.category || item._unit || "", scene: item._unit || "",
        chinese: item.translation || "", question_bank: true,
        bank_source_id: String(item.id ?? index), bank_translation: item.translation || "",
        bank_detail: detail,
    };
}

async function loadLocalBank(level) {
    if (localBankCache[level]) return localBankCache[level];
    const response = await fetch(`question_banks/${level.toLowerCase()}.json`);
    if (!response.ok) throw new Error(`${level} 题库尚未导入`);
    const raw = await response.json();
    const questions = [];
    (raw.groups || []).forEach((group) => {
        const data = group.data || {};
        (data.questions || []).forEach((item) => {
            questions.push(localQuestionView({ ...item, _unit: data.unit || "", _title: data.title || "" }, questions.length));
        });
    });
    localBankCache[level] = questions.filter(Boolean).sort((a, b) => Number(a.bank_source_id) - Number(b.bank_source_id));
    return localBankCache[level];
}

async function localApi(url, options = {}) {
    const parsed = new URL(url, location.href);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const body = options.body ? JSON.parse(options.body) : {};
    const level = String(body.level || parsed.searchParams.get("level") || "N3").toUpperCase();
    const wrongBook = Boolean(body.wrong_book || parsed.searchParams.get("wrong_book") === "true");
    if (parts.at(-1) === "info") {
        try {
            const bank = await loadLocalBank(level);
            const progress = readLocalProgress().levels[level] || {};
            const wrongCount = bank.filter((q) => progress[q.bank_source_id]?.wrong && !progress[q.bank_source_id]?.removed_from_wrong_book).length;
            return { success: true, level, available: true, total: bank.length, wrong_count: wrongCount, units: [...new Set(bank.map((q) => q.scene).filter(Boolean))] };
        } catch {
            return { success: true, level, available: false, total: 0, units: [] };
        }
    }
    const bank = await loadLocalBank(level);
    const progress = readLocalProgress();
    const levelProgress = progress.levels[level] || {};
    if (parts.at(-1) === "generate") {
        const count = body.count > 0 ? Math.min(Number(body.count), bank.length) : bank.length;
        const questions = wrongBook
            ? bank.filter((question) => levelProgress[question.bank_source_id]?.wrong && !levelProgress[question.bank_source_id]?.removed_from_wrong_book)
            : bank.filter((question) => !levelProgress[question.bank_source_id]?.correct && !levelProgress[question.bank_source_id]?.wrong);
        const selected = questions.slice(0, count);
        return { success: true, data: { questions: selected, total: selected.length, source: wrongBook ? `${level} 错题本` : `${level} 题库`, level, wrong_book: wrongBook, completed: !selected.length } };
    }
    if (parts.at(-1) === "progress") {
        const questionId = String(body.question_id || "");
        if (!questionId) throw new Error("题号无效");
        progress.levels[level] ||= {};
        const item = progress.levels[level][questionId] || { wrong: false, correct: false, attempts: 0 };
        const correct = Boolean(body.correct);
        if (body.action === "remove") {
            item.removed_from_wrong_book = true;
            item.wrong = false;
            item.correct = false;
            item.removed_at = new Date().toISOString();
            progress.levels[level][questionId] = item;
            writeLocalProgress(progress);
            return { success: true, level, question_id: questionId, status: item };
        }
        const now = new Date();
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        item.attempts = Number(item.attempts || 0) + 1;
        item.last_result = correct ? "correct" : "wrong";
        item.wrong = !correct || (Boolean(body.wrong_book) && Boolean(item.wrong));
        item.correct = correct && !Boolean(body.wrong_book); item.revealed = Boolean(body.revealed);
        item.answered_at = now.toISOString();
        item.next_review = null;
        progress.levels[level][questionId] = item;
        writeLocalProgress(progress);
        return { success: true, level, question_id: questionId, status: item };
    }
    throw new Error("离线模式不支持此请求");
}

function saveAnswer(question, correct, revealed) {
    return api("/api/question_bank/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: state.level, question_id: question.bank_source_id, correct, revealed, wrong_book: state.wrongBook }),
    }).catch(() => {});
}

function renderExplanation(question, correct, revealed) {
    const detail = question.bank_detail || {};
    const otherOptions = detail.other_options;
    let distractorHtml = "";
    if (otherOptions && typeof otherOptions === "object" && !Array.isArray(otherOptions)) {
        const items = Object.entries(otherOptions).map(([key, value]) =>
            `<li><strong>选项 ${escapeHtml(key)}：</strong>${escapeHtml(value)}</li>`).join("");
        if (items) distractorHtml = `<div class="explanation-block"><b>错误选项解析</b><ul>${items}</ul></div>`;
    } else if (otherOptions) {
        distractorHtml = `<div class="explanation-block"><b>错误选项解析</b><p>${escapeHtml(otherOptions)}</p></div>`;
    }
    const resultTitle = revealed ? "已查看答案" : (correct ? "回答正确" : "回答错误");
    const resultClass = correct && !revealed ? "good" : "bad";
    const translation = question.bank_translation || question.chinese || "";
    $("#explanation").innerHTML = `
        <div class="explanation-heading"><span class="result-mark ${resultClass}">${correct && !revealed ? "✓" : "!"}</span>
            <div><strong>${resultTitle}</strong><small>正确答案：${escapeHtml(question.options[question.correct_option])}</small></div>
        </div>
        ${translation ? `<div class="explanation-block"><b>中文翻译</b><p>${escapeHtml(translation)}</p></div>` : ""}
        ${question.explanation ? `<div class="explanation-block"><b>正确项解析</b><p>${escapeHtml(question.explanation)}</p></div>` : ""}
        ${detail.grammar_point ? `<div class="explanation-block"><b>语法要点</b><p>${escapeHtml(detail.grammar_point)}</p></div>` : ""}
        ${detail.translation_detail ? `<div class="explanation-block"><b>详细翻译</b><p>${escapeHtml(detail.translation_detail)}</p></div>` : ""}
        ${distractorHtml}`;
    $("#explanation").hidden = false;
}

function renderQuestion() {
    const question = state.questions[state.index];
    state.answered = false;
    $("#progress-label").textContent = `第 ${state.index + 1} / ${state.questions.length} 题`;
    $("#score-label").textContent = `得分 ${state.score}`;
    $("#progress-bar").style.width = `${(state.index / state.questions.length) * 100}%`;
    $("#question-unit").textContent = question.scene || "题库练习";
    $("#question-category").textContent = question.grammar_point || "";
    const target = question.target_text && question.grammar_point === "文字" ? question.target_text : "";
    const targetStart = target ? question.stem.indexOf(target) : -1;
    if (targetStart >= 0) {
        const before = question.stem.slice(0, targetStart);
        const after = question.stem.slice(targetStart + target.length);
        $("#question-text").innerHTML = `${escapeHtml(before)}<span class="question-target">${escapeHtml(target)}</span>${escapeHtml(after)}`;
    } else $("#question-text").textContent = question.stem;
    $("#question-translation").textContent = "";
    $("#question-translation").hidden = true;
    $("#explanation").hidden = true;
    $("#dont-know-button").disabled = false;
    $("#options").innerHTML = question.options.map((option, index) =>
        `<button class="option" data-index="${index}"><span>${String.fromCharCode(65 + index)}</span>${escapeHtml(option)}</button>`).join("");
    document.querySelectorAll(".option").forEach((button) => button.addEventListener("click", () => answer(Number(button.dataset.index))));
}

function answer(selected, revealed = false) {
    if (state.answered) return;
    state.answered = true;
    const question = state.questions[state.index];
    const correct = !revealed && selected === question.correct_option;
    if (correct) state.score += 1;
    document.querySelectorAll(".option").forEach((button) => {
        const index = Number(button.dataset.index);
        button.disabled = true;
        if (index === question.correct_option) button.classList.add("correct");
        else if (!revealed && index === selected) button.classList.add("wrong");
    });
    $("#dont-know-button").disabled = true;
    $("#score-label").textContent = `得分 ${state.score}`;
    const translation = question.bank_translation || question.chinese || "";
    $("#question-translation").textContent = translation;
    $("#question-translation").hidden = !translation;
    renderExplanation(question, correct, revealed);
    saveAnswer(question, correct, revealed);
    if (state.wrongBook) {
        const remove = document.createElement("button");
        remove.className = "text-button remove-wrong-button";
        remove.type = "button";
        remove.textContent = "移出错题本";
        remove.onclick = async () => {
            remove.disabled = true;
            try {
                await api("/api/question_bank/progress", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ level: state.level, question_id: question.bank_source_id, action: "remove" }),
                });
                remove.textContent = "已移出错题本";
            } catch {
                remove.disabled = false;
            }
        };
        $("#explanation").appendChild(remove);
    }
    const next = document.createElement("button");
    next.className = "primary-button next-button";
    next.textContent = state.index + 1 < state.questions.length ? "下一题" : "查看结果";
    next.onclick = () => { next.remove(); state.index += 1; state.index < state.questions.length ? renderQuestion() : renderSummary(); };
    $("#explanation").appendChild(next);
}

async function loadLevels() {
    for (const card of document.querySelectorAll(".level-card")) {
        try {
            const info = await api(`/api/question_bank/info?level=${card.dataset.level}`);
            const wrongBook = card.dataset.wrongBook === "true";
            card.querySelector(".level-status").textContent = info.available
                ? (wrongBook ? `${info.wrong_count || 0} 道错题` : `${info.total} 道题可用`)
                : "题库待导入";
            card.disabled = !info.available || (wrongBook && !info.wrong_count);
            if (card.dataset.level === state.level && card.dataset.wrongBook === String(state.wrongBook) && info.available) {
                $("#bank-count").textContent = card.querySelector(".level-status").textContent;
            }
        } catch { card.querySelector(".level-status").textContent = "读取失败"; }
    }
}

async function startQuiz() {
    $("#home-error").hidden = true;
    $("#start-button").disabled = true;
    try {
        const result = await api("/api/question_bank/generate", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ level: state.level, count: 0, wrong_book: state.wrongBook }),
        });
        if (result.data.completed) {
            $("#summary-title").textContent = "本题库已全部完成";
            $("#summary-detail").textContent = state.wrongBook
                ? `${state.level} 错题本中暂时没有待复习的题目。`
                : `${state.level} 题库中的题目都已答对。`;
            showView("summary-view");
            return;
        }
        state.questions = result.data.questions; state.index = 0; state.score = 0;
        $("#header-level").textContent = state.level;
        showView("quiz-view"); renderQuestion();
    } catch (error) {
        $("#home-error").textContent = error.message; $("#home-error").hidden = false;
    } finally { $("#start-button").disabled = false; }
}

function renderSummary() {
    $("#progress-bar").style.width = "100%";
    $("#summary-title").textContent = state.wrongBook ? "错题本练习完成" : "本轮练习完成";
    $("#summary-score").textContent = state.score;
    $("#summary-detail").textContent = `${state.level}${state.wrongBook ? " 错题本" : " 题库"} · 共 ${state.questions.length} 题，答对 ${state.score} 题`;
    showView("summary-view");
}

document.querySelectorAll(".level-card").forEach((card) => card.addEventListener("click", () => {
    if (card.disabled) return;
    document.querySelectorAll(".level-card").forEach((item) => item.classList.remove("active"));
    card.classList.add("active"); state.level = card.dataset.level;
    state.wrongBook = card.dataset.wrongBook === "true";
    $("#header-level").textContent = state.wrongBook ? `${state.level} 错题本` : state.level;
    $("#bank-count").textContent = card.querySelector(".level-status").textContent;
}));
$("#start-button").onclick = startQuiz;
$("#quit-button").onclick = () => { showView("home-view"); loadLevels(); };
$("#again-button").onclick = startQuiz;
$("#summary-home-button").onclick = () => { showView("home-view"); loadLevels(); };
$("#dont-know-button").onclick = () => answer(null, true);
if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
}
loadLevels();
