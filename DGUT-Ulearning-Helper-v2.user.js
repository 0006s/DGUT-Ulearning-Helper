// ==UserScript==
// @name                      优学院DGUT版 v2.0优化版
// @version                   2.3
// @description               适配DGUT优学院（自动静音播放、自动做练习题、自动翻页、修改播放速率、浅色/深色主题切换）- 重构优化版
// @author                    Linus
// @match                     https://ua.dgut.edu.cn/learnCourse/learnCourse.html*
// @icon                      https://lms.dgut.edu.cn/ulearning/favicon.ico
// @grant                     GM_xmlhttpRequest
// @license                   MIT
// @namespace                 https://greasyfork.org/users/1540778/v2
// @website                   https://soujiaoben.org/#/s?id=556678&host=greasyfork
// ==/UserScript==



(function () {
    'use strict';

    /*  ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
     *  优学院自动静音播放、自动做练习题、自动翻页、修改播放速率脚本（适配东莞理工学院）
     *  重要提醒：使用风险自负，避免高倍速/长时间挂机，建议非核心课程使用，仅限个人学习使用，禁止商用
     *  基于作者Brush-JIM的脚本"优学院自动静音播放、自动做练习题、自动翻页、修改播放速率（改）"
     *  和作者 luluzzy. 的脚本"DGUT Ulearning Tool"（MIT协议）二次开发重构
     *  原脚本链接：https://greasyfork.org/zh-CN/scripts/555722-dgut-ulearning-tool
     *  v2.1: UI全面改版 - 深色主题、卡片布局、Toggle开关、状态指示、日志分色
     *  ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
     */

    // ===================== 工具函数 =====================

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // ===================== 配置键白名单 =====================

    const CONFIG_KEYS = [
        'playbackRate', 'autoPlay', 'autoMute', 'autoAdjustRate',
        'autoFillAnswers', 'showAnswers', 'autoAnswerSingle',
        'autoAnswerMulti', 'autoAnswerJudge', 'autoAnswerBlank', 'lightTheme'
    ];

    const STORAGE_PREFIX = 'ulearn_';

    // ===================== 配置管理中心 =====================

    const AppConfig = {
        playbackRate: 1.5,
        autoPlay: true,
        autoMute: true,
        autoAdjustRate: true,
        autoFillAnswers: true,
        showAnswers: true,
        autoAnswerSingle: true,
        autoAnswerMulti: true,
        autoAnswerJudge: true,
        autoAnswerBlank: true,
        lightTheme: false,
        maxRetryCount: 7,

        load() {
            CONFIG_KEYS.forEach(key => {
                const stored = localStorage.getItem(STORAGE_PREFIX + key);
                if (stored === null) return;

                if (key === 'playbackRate') {
                    // [P0修复] playbackRate 需 parseFloat，避免变成字符串
                    this[key] = parseFloat(stored) || this[key];
                } else {
                    this[key] = stored === 'true' || (stored !== 'false' && stored);
                }
            });
        },

        save() {
            // [P0修复] 只保存白名单中的键，避免误存其他属性
            CONFIG_KEYS.forEach(key => {
                localStorage.setItem(STORAGE_PREFIX + key, this[key]);
            });
        }
    };

    // ===================== 状态管理 =====================

    const AppState = {
        isPaused: false,
        isRestarting: false,
        isNavigating: false,
        answerInProgress: false,
        modalChecking: false,
        nextPageRetry: 0,
        // [P1修复] 标记已绑定 ended 监听器的 video 元素，防止堆叠
        boundVideos: new WeakSet(),
        // [P1修复] controlPlayback 递归守卫
        playbackTimerId: null,
        reset() {
            this.nextPageRetry = 0;
            this.isNavigating = false;
        }
    };

    // ===================== 日志工具 =====================

    const Logger = {
        element: null,
        init(el) {
            this.element = el;
        },
        log(message, type = '') {
            const timestamp = new Date().toLocaleTimeString();
            const logMsg = `[${timestamp}] ${message}`;
            console.log(`DGUT助手: ${logMsg}`);
            if (this.element) {
                const typeClass = type === 'success' ? 'log-success' :
                                  type === 'info' ? 'log-info' :
                                  type === 'warn' ? 'log-warn' :
                                  type === 'error' ? 'log-error' : '';
                this.element.innerHTML += `<span class="log-time">[${timestamp}]</span> <span class="${typeClass}">${message}</span><br>`;
                this.element.scrollTop = this.element.scrollHeight;
            }
        }
    };

    // ===================== 答案处理服务 =====================

    class AnswerService {
        getQuestionType(questionEl) {
            const typeTag = questionEl.querySelector('.question-type-tag');
            if (!typeTag) return null;

            const typeText = typeTag.textContent.trim();
            if (typeText.includes('单选题')) return 'single';
            if (typeText.includes('多选题')) return 'multiple';
            if (typeText.includes('判断题')) return 'judge';
            if (typeText.includes('填空题')) return 'blank';
            return null;
        }

        processQuestion(questionId, answers) {
            if (AppState.isPaused || AppState.isRestarting) return;

            const questionEl = document.querySelector(`#question${questionId}`);
            if (!questionEl) {
                Logger.log(`未找到问题容器: ${questionId}`);
                return;
            }

            const type = this.getQuestionType(questionEl);
            if (!type) {
                Logger.log(`无法识别题型: ${questionId}`);
                return;
            }

            const handlers = {
                single: () => this.handleSingleChoice(questionEl, answers),
                multiple: () => this.handleMultiChoice(questionEl, answers),
                judge: () => this.handleJudge(questionEl, answers),
                blank: () => this.handleBlank(questionEl, answers)
            };

            if (handlers[type]) {
                handlers[type]();
            } else {
                Logger.log(`不支持的题型: ${type}`);
            }
        }

        // [P0修复] 单选题拆分出来，使用精确匹配
        handleSingleChoice(questionEl, answers) {
            if (!AppConfig.autoAnswerSingle) return;
            const targetAnswer = answers[0];
            if (!targetAnswer) return;

            const options = questionEl.querySelectorAll('.choice-item, .option-item, .question-option');
            if (!options.length) {
                Logger.log(`单选题选项未找到: ${questionEl.id}`);
                return;
            }

            options.forEach(option => {
                const optionLabel = this.getOptionLabel(option);
                if (optionLabel === targetAnswer) {
                    this.clickOption(option);
                }
            });
        }

        // [P0修复] 多选题拆分出来，使用精确匹配
        handleMultiChoice(questionEl, answers) {
            if (!AppConfig.autoAnswerMulti) return;

            const options = questionEl.querySelectorAll('.choice-item, .option-item, .question-option');
            if (!options.length) {
                Logger.log(`多选题选项未找到: ${questionEl.id}`);
                return;
            }

            options.forEach(option => {
                const optionLabel = this.getOptionLabel(option);
                // 精确匹配：optionLabel 必须是 answers 数组中的某一项
                if (optionLabel && answers.some(a => a === optionLabel)) {
                    this.clickOption(option);
                }
            });
        }

        // 兼容旧接口：选择题通用入口
        handleChoice(questionEl, answers) {
            const type = this.getQuestionType(questionEl);
            if (type === 'single') {
                this.handleSingleChoice(questionEl, answers);
            } else if (type === 'multiple') {
                this.handleMultiChoice(questionEl, answers);
            }
        }

        getOptionLabel(option) {
            return option.querySelector('.option')?.textContent?.trim().replace('.', '') ||
                   option.querySelector('.option-letter')?.textContent?.trim() ||
                   option.querySelector('span:first-child')?.textContent?.trim().replace('.', '') ||
                   '';
        }

        clickOption(option) {
            const selector = option.querySelector('.checkbox, .option-checkbox, .radio');
            if (selector && !selector.classList.contains('selected')) {
                option.click();
                if (!selector.classList.contains('selected')) {
                    selector.click();
                }
                Logger.log(`选中选项: ${this.getOptionLabel(option)}`);
            }
        }

        handleJudge(questionEl, answers) {
            if (!AppConfig.autoAnswerJudge) return;
            const isCorrect = String(answers) === 'true';
            const btnSelector = isCorrect ? '.right-btn' : '.wrong-btn';
            const judgeBtn = questionEl.querySelector(btnSelector);

            if (judgeBtn && !judgeBtn.classList.contains('selected')) {
                judgeBtn.click();
                Logger.log(`判断题选择: ${isCorrect ? '正确' : '错误'}`);
            }
        }

        handleBlank(questionEl, answers) {
            if (!AppConfig.autoAnswerBlank) return;
            const inputs = questionEl.querySelectorAll('textarea, .blank-input');
            answers.forEach((ans, idx) => {
                if (inputs[idx]) {
                    const cleanedAns = this.cleanHtml(this.escapeHtml(ans));
                    inputs[idx].value = cleanedAns;
                    $(inputs[idx]).trigger('change');
                }
            });
            Logger.log(`填空题已填充: ${answers.join('; ')}`);
        }

        escapeHtml(str) {
            const entities = { 'lt': '<', 'gt': '>', 'nbsp': ' ', 'amp': '&', 'quot': '"' };
            return str.replace(/&(lt|gt|nbsp|amp|quot);/ig, (_, key) => entities[key]);
        }

        cleanHtml(str) {
            return str.replace(/(<[^>]+>|\\n|\\r)/g, ' ');
        }
    }

    // ===================== 视频控制服务 =====================

    class VideoController {
        constructor() {
            this.observer = null;
            // [P1] 防抖定时器
            this._debounceTimer = null;
        }

        init() {
            this.setupVideoMonitoring();
        }

        // [P1修复] MutationObserver 添加防抖
        setupVideoMonitoring() {
            this.observer = new MutationObserver(() => {
                clearTimeout(this._debounceTimer);
                this._debounceTimer = setTimeout(() => {
                    if (!AppState.isPaused && !AppState.isRestarting) {
                        this.processVideos();
                        this.checkModals();
                    }
                }, 200);
            });
            this.observer.observe(document.body, { childList: true, subtree: true });
        }

        // [P3修复] 消除 slept 反模式，改用 async/await
        async processVideos() {
            if (AppState.isPaused || AppState.isRestarting || !AppConfig.autoPlay) return;

            if (AppState.answerInProgress) {
                await delay(1000);
                return this.processVideos();
            }

            // 等待 DOM 稳定
            await delay(3000);

            const video = document.querySelector("video, mediaelementwrapper video:first-child");
            if (video) {
                video.playbackRate = AppConfig.playbackRate;
                if (AppConfig.autoMute && !video.muted) {
                    video.muted = true;
                    Logger.log("视频已静音", 'success');
                }
            }

            const videoWrappers = $('mediaelementwrapper video:first-child');
            const statusIndicators = $('.video-bottom span:first-child');

            if (videoWrappers.length === 0 || videoWrappers.length !== statusIndicators.length) {
                PageNavigator.goNext();
                return;
            }

            const videoStates = [];
            $(videoWrappers).each((idx, el) => {
                const state = $(statusIndicators[idx]).attr('data-bind');
                videoStates.push({
                    element: el,
                    completed: state === 'text: $root.i18nMessageText().finished',
                    currentTime: 0
                });
            });

            // [P0修复] 防止 ended 事件监听器堆叠
            videoStates.forEach((state, idx) => {
                if (!AppState.boundVideos.has(state.element)) {
                    AppState.boundVideos.add(state.element);
                    state.element.addEventListener('ended', () => {
                        videoStates[idx].completed = true;
                        AppState.boundVideos.delete(state.element);
                        Logger.log("视频播放完成", 'success');
                        PageNavigator.goNext();
                    }, { once: true });
                }
            });

            this.controlPlayback(videoStates);
        }

        // [P1修复] 添加递归守卫，防止多个 setTimeout 链同时运行
        controlPlayback(videoStates) {
            if (AppState.isPaused || AppState.isRestarting) return;

            // 清除上一个未执行的定时器
            if (AppState.playbackTimerId) {
                clearTimeout(AppState.playbackTimerId);
                AppState.playbackTimerId = null;
            }

            if (videoStates.length !== $('mediaelementwrapper video:first-child').length) {
                this.processVideos();
                return;
            }

            videoStates.forEach(state => {
                state.element.playbackRate = AppConfig.playbackRate;
            });

            for (let i = 0; i < videoStates.length; i++) {
                if (videoStates[i].element !== $('mediaelementwrapper video:first-child')[i]) {
                    this.processVideos();
                    return;
                }

                if (!videoStates[i].completed) {
                    const targetVideo = (i > 0 && !videoStates[i - 1].completed) ? videoStates[i - 1] : videoStates[i];

                    if (targetVideo.element.paused || targetVideo.currentTime === targetVideo.element.currentTime) {
                        targetVideo.element.currentTime = Math.max(0, targetVideo.element.currentTime - 3);
                        targetVideo.element.play().catch(err => {
                            Logger.log(`播放失败: ${err.message}`, 'error');
                            AppRestarter.restart();
                        });
                    }

                    targetVideo.currentTime = targetVideo.element.currentTime;

                    if (AppConfig.autoMute && !targetVideo.element.muted) {
                        targetVideo.element.muted = true;
                    }

                    if (AppConfig.autoAdjustRate && targetVideo.element.playbackRate !== AppConfig.playbackRate) {
                        targetVideo.element.playbackRate = AppConfig.playbackRate;
                    }

                    AppState.playbackTimerId = setTimeout(() => this.controlPlayback(videoStates), 500);
                    return;
                }
            }

            PageNavigator.goNext();
        }

        // [P3修复] 消除 slept 反模式
        async checkModals() {
            if (AppState.isPaused || AppState.isRestarting || AppState.answerInProgress) return;

            // 等待弹窗渲染
            await delay(2000);

            AppState.modalChecking = true;

            const questionPanel = $('.question-wrapper');
            if (questionPanel.length > 0 && AppConfig.autoFillAnswers) {
                answerProcessor.processQuiz();
                AppState.modalChecking = false;
                return;
            }

            const statModal = $('#statModal');
            if (statModal.length > 0) {
                const buttons = statModal[0].getElementsByTagName('button');
                if (buttons.length >= 2) buttons[1].click();
            }

            const errorIndicator = $('.mobile-video-error');
            if (errorIndicator && errorIndicator.css('display') !== 'none') {
                $('.try-again').click();
                Logger.log("检测到视频错误，已尝试重试", 'warn');
            }

            const alertModal = document.getElementById('alertModal');
            if (alertModal && alertModal.className.includes('in')) {
                const operations = $('.modal-operation').children();
                if (operations.length >= 2) {
                    operations[AppConfig.autoFillAnswers ? 0 : 1].click();
                } else {
                    const continueBtn = $('.btn-submit');
                    continueBtn.each((_, btn) => {
                        if ($(btn).text() !== '提交') $(btn).click();
                    });
                }
                if (AppConfig.autoFillAnswers) answerProcessor.processQuiz();
            }

            AppState.modalChecking = false;
        }
    }

    // ===================== 页面导航器 =====================

    const PageNavigator = {
        goNext() {
            if (AppState.isNavigating || AppState.isPaused || AppState.isRestarting ||
                AppState.answerInProgress || !AppConfig.autoPlay || AppState.modalChecking) {
                return;
            }

            Logger.log("尝试导航至下一页");
            const nextButtons = $('.mobile-next-page-btn, .next-btn, .btn-next, .nextVideoBtn');

            if (nextButtons.length === 0) {
                AppState.nextPageRetry++;
                Logger.log(`未找到下一页按钮（${AppState.nextPageRetry}/${AppConfig.maxRetryCount}）`, 'warn');

                if (AppState.nextPageRetry >= AppConfig.maxRetryCount) {
                    AppState.isPaused = true;
                    const toggleBtn = document.getElementById('toggleScript');
                    if (toggleBtn) {
                        toggleBtn.innerText = '▶️ 继续运行';
                        toggleBtn.style.backgroundColor = 'rgba(46, 204, 113, 0.5)';
                    }
                    Logger.log(`连续${AppConfig.maxRetryCount}次未找到下一页，已暂停`, 'error');
                }
                return;
            }

            AppState.nextPageRetry = 0;
            AppState.isNavigating = true;
            Logger.log("锁定导航状态，防止重复操作");

            nextButtons.each((_, btn) => {
                if (!$(btn).hasClass('disabled')) {
                    btn.click();
                    Logger.log("已点击下一页按钮", 'info');
                }
            });

            setTimeout(() => {
                Logger.log("导航完成，解除锁定");
                AppState.isNavigating = false;

                setTimeout(() => {
                    if (!AppState.isPaused && !AppState.isRestarting) {
                        videoController.processVideos();
                        videoController.checkModals();
                    }
                }, 1000);
            }, 3000);
        }
    };

    // ===================== 答案处理器（class 化） =====================

    class AnswerProcessor {
        constructor() {
            this.answerService = new AnswerService();
        }

        processQuiz() {
            if (AppState.isPaused || AppState.isRestarting || AppState.answerInProgress || !AppConfig.autoFillAnswers) {
                return;
            }

            AppState.answerInProgress = true;
            Logger.log("检测到测验页面，开始处理答案");

            let questionIds = [];
            const checkInterval = setInterval(async () => {
                const currentPanels = $('.question-wrapper');
                if (currentPanels.length > 0) {
                    clearInterval(checkInterval);

                    currentPanels.each((_, panel) => {
                        const id = $(panel).attr('id');
                        if (id && id.startsWith('question')) {
                            questionIds.push(id.replace('question', ''));
                        } else {
                            Logger.log("发现无效问题ID，已跳过");
                        }
                    });

                    questionIds = [...new Set(questionIds)];
                    Logger.log(`共检测到 ${questionIds.length} 道题目`);

                    let pageId = '';
                    let found = false;
                    const pageItems = $('.page-item');
                    pageItems.each((_, item) => {
                        if (found) return;
                        const pageName = $(item).find('.page-name');
                        if (pageName.length > 0 && pageName[0].className.includes('active')) {
                            const idAttr = $(item).attr('id');
                            pageId = idAttr.slice(idAttr.search(/\d/g));
                            found = true;
                        }
                    });

                    if (!found || questionIds.length === 0) {
                        if (questionIds.length === 0) {
                            Logger.log("未发现有效题目，跳转至下一页");
                        }
                        AppState.answerInProgress = false;
                        PageNavigator.goNext();
                        return;
                    }

                    const total = questionIds.length;
                    let processed = 0;

                    const processNext = (index) => {
                        if (index >= total) {
                            Logger.log(`所有 ${total} 道题目处理完毕`);
                            setTimeout(() => {
                                if (AppConfig.autoPlay) {
                                    $('textarea, .blank-input').trigger('change');
                                    const submitBtn = $('.btn-submit');
                                    if (submitBtn.length > 0) {
                                        submitBtn.click();
                                        Logger.log("已提交答案", 'success');
                                    }

                                    const videos = $('video').filter((_, v) => v.src !== "");
                                    if (videos.length === 0) {
                                        AppState.answerInProgress = false;
                                        PageNavigator.goNext();
                                        return;
                                    }
                                }
                                AppState.answerInProgress = false;
                            }, 1000);
                            return;
                        }

                        const qId = questionIds[index];
                        Logger.log(`处理第 ${index + 1}/${total} 题 (ID: ${qId})`);
                        this.fetchAnswer(qId, pageId, () => {
                            processed++;
                            Logger.log(`第 ${index + 1} 题处理完成 (${processed}/${total})`);
                            processNext(index + 1);
                        });
                    };

                    processNext(0);
                }
            }, 500);

            setTimeout(() => {
                clearInterval(checkInterval);
                if (questionIds.length === 0) {
                    Logger.log("超时未检测到题目，跳转至下一页");
                    AppState.answerInProgress = false;
                    PageNavigator.goNext();
                }
            }, 5000);
        }

        // [P2修复] API 请求添加重试机制
        fetchAnswer(questionId, parentId, callback, retryCount = 0) {
            if (AppState.isPaused || AppState.isRestarting) {
                callback();
                return;
            }

            const auth = this.getAuthorization();
            if (!auth) {
                Logger.log("获取认证信息失败，无法请求答案", 'error');
                callback();
                return;
            }

            GM_xmlhttpRequest({
                method: "GET",
                url: `https://ua.dgut.edu.cn/uaapi/questionAnswer/${questionId}?parentId=${parentId}`,
                headers: {
                    "UA-AUTHORIZATION": auth,
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": window.location.href
                },
                onload: (res) => {
                    try {
                        const data = JSON.parse(res.responseText);
                        const answers = data.correctAnswerList || data.answer || [];
                        Logger.log(`题目 ${questionId} 答案: ${answers}`);

                        if (answers.length > 0) {
                            this.answerService.processQuestion(questionId, answers);
                        } else {
                            Logger.log(`题目 ${questionId} 未找到答案`);
                        }
                    } catch (err) {
                        Logger.log(`解析答案失败: ${err.message}`);
                        console.error("答案解析错误:", err);
                    } finally {
                        callback();
                    }
                },
                onerror: (err) => {
                    // [P2] 指数退避重试，最多 3 次
                    if (retryCount < 3) {
                        const retryDelay = Math.pow(2, retryCount) * 1000;
                        Logger.log(`请求答案失败，${retryDelay / 1000}秒后重试 (${retryCount + 1}/3): ${err.message}`, 'warn');
                        setTimeout(() => {
                            this.fetchAnswer(questionId, parentId, callback, retryCount + 1);
                        }, retryDelay);
                    } else {
                        Logger.log(`题目 ${questionId} 请求答案失败（已重试3次）`, 'error');
                        callback();
                    }
                }
            });
        }

        // [P2修复] Cookie 解析更健壮
        getAuthorization() {
            const match = document.cookie.match(/(?:^|;\s*)AUTHORIZATION=([^;]*)/);
            return match ? decodeURIComponent(match[1]) : "";
        }
    }

    // ===================== 应用重启器 =====================

    const AppRestarter = {
        restart() {
            if (AppState.isRestarting) return;

            AppState.isRestarting = true;
            Logger.log("检测到异常，尝试重启服务...");

            const toggleBtn = document.getElementById('toggleScript');
            if (!AppState.isPaused && toggleBtn) {
                toggleBtn.click();
            }

            setTimeout(() => {
                Logger.log("重启中，恢复服务...");
                if (toggleBtn) toggleBtn.click();

                setTimeout(() => {
                    AppState.isRestarting = false;
                    Logger.log("服务重启完成");
                }, 1000);
            }, 2000);
        }
    };

    // ===================== UI组件 =====================

    class UIController {
        constructor() {
            this.panel = null;
            this.isCollapsed = false;
        }

        render() {
            this.loadStyles();
            this.createPanel();
            this.bindEvents();
            AppConfig.load();
            this.syncConfigToUI();
        }

        loadStyles() {
            const style = document.createElement('style');
            style.textContent = `
                .ulearn-panel {
                    position:fixed;top:80px;right:30px;z-index:999999;
                    background:#1e1e2e;color:#cdd6f4;padding:0;
                    border-radius:14px;font-size:13px;width:310px;
                    border:0.5px solid rgba(255,255,255,0.08);
                    box-shadow:0 8px 32px rgba(0,0,0,0.5);
                    cursor:move;overflow:hidden;
                    transition:height 0.3s ease;
                    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
                }
                .ulearn-panel:hover {opacity:1}
                .ulearn-header {
                    background:#181825;padding:10px 14px;
                    display:flex;justify-content:space-between;align-items:center;
                    user-select:none;
                }
                .ulearn-header-title {font-size:13px;font-weight:600;color:#cdd6f4}
                .ulearn-header-btns {display:flex;gap:6px}
                .ulearn-header-btn {
                    width:24px;height:24px;border-radius:6px;
                    background:rgba(255,255,255,0.06);border:0.5px solid rgba(255,255,255,0.08);
                    color:#9399b2;cursor:pointer;font-size:11px;
                    display:flex;align-items:center;justify-content:center;
                    transition:background 0.15s;
                }
                .ulearn-header-btn:hover {background:rgba(255,255,255,0.12);color:#cdd6f4}
                .ulearn-body {padding:10px 14px 14px}
                .ulearn-body.hidden {display:none}

                .ulearn-status {
                    display:flex;align-items:center;justify-content:space-between;
                    padding:8px 12px;border-radius:8px;margin-bottom:10px;
                    background:rgba(166,227,161,0.1);transition:background 0.3s;
                }
                .ulearn-status.paused {background:rgba(243,139,168,0.1)}
                .ulearn-status-left {display:flex;align-items:center;gap:8px}
                .ulearn-status-dot {
                    width:8px;height:8px;border-radius:50%;
                    background:#a6e3a1;transition:background 0.3s;
                    box-shadow:0 0 6px rgba(166,227,161,0.4);
                }
                .ulearn-status.paused .ulearn-status-dot {
                    background:#f38ba8;
                    box-shadow:0 0 6px rgba(243,139,168,0.4);
                }
                .ulearn-status-text {font-size:12px;font-weight:500;color:#a6e3a1;transition:color 0.3s}
                .ulearn-status.paused .ulearn-status-text {color:#f38ba8}
                .ulearn-toggle-btn {
                    padding:4px 14px;border-radius:6px;border:0.5px solid rgba(255,255,255,0.08);
                    background:rgba(255,255,255,0.05);color:#9399b2;font-size:11px;cursor:pointer;
                    transition:all 0.15s;
                }
                .ulearn-toggle-btn:hover {background:rgba(255,255,255,0.1);color:#cdd6f4}

                .ulearn-progress {margin-bottom:10px}
                .ulearn-progress-bar {
                    height:4px;border-radius:2px;
                    background:rgba(255,255,255,0.06);overflow:hidden;margin-bottom:4px;
                }
                .ulearn-progress-fill {
                    height:100%;border-radius:2px;
                    background:linear-gradient(90deg,#89b4fa,#b4befe);
                    transition:width 0.5s ease;
                }
                .ulearn-progress-text {
                    display:flex;justify-content:space-between;
                    font-size:10px;color:#585b70;
                }

                .ulearn-card {
                    background:#313244;
                    border:0.5px solid rgba(255,255,255,0.04);
                    border-radius:10px;padding:10px 12px;margin-bottom:8px;
                }
                .ulearn-card-title {
                    font-size:10px;font-weight:600;color:#585b70;
                    text-transform:uppercase;letter-spacing:0.5px;
                    margin-bottom:8px;
                }
                .ulearn-card-row {
                    display:flex;justify-content:space-between;align-items:center;
                    padding:4px 0;
                }
                .ulearn-card-row + .ulearn-card-row {border-top:0.5px solid rgba(255,255,255,0.04)}

                .ulearn-rate-value {
                    font-size:26px;font-weight:600;color:#cdd6f4;line-height:1;
                }
                .ulearn-rate-unit {font-size:13px;color:#585b70;margin-left:2px}
                .ulearn-rate-controls {display:flex;gap:6px;margin-left:auto}
                .ulearn-rate-btn {
                    width:30px;height:30px;border-radius:8px;border:none;
                    cursor:pointer;font-size:16px;
                    display:flex;align-items:center;justify-content:center;
                    transition:background 0.15s;
                }
                .ulearn-rate-btn.minus {
                    background:rgba(255,255,255,0.05);color:#9399b2;
                }
                .ulearn-rate-btn.minus:hover {background:rgba(255,255,255,0.1);color:#cdd6f4}
                .ulearn-rate-btn.plus {
                    background:rgba(137,180,250,0.15);color:#89b4fa;
                }
                .ulearn-rate-btn.plus:hover {background:rgba(137,180,250,0.3)}

                .ulearn-toggle {
                    position:relative;width:34px;height:18px;border-radius:9px;
                    background:#45475a;cursor:pointer;transition:background 0.2s;
                    flex-shrink:0;
                }
                .ulearn-toggle.active {background:#a6e3a1}
                .ulearn-toggle-knob {
                    position:absolute;top:2px;left:2px;
                    width:14px;height:14px;border-radius:50%;
                    background:#cdd6f4;transition:transform 0.2s;
                }
                .ulearn-toggle.active .ulearn-toggle-knob {transform:translateX(16px)}

                .ulearn-save-btn {
                    width:100%;padding:9px 0;border-radius:8px;border:none;
                    background:#89b4fa;color:#1e1e2e;font-size:13px;font-weight:600;
                    cursor:pointer;transition:background 0.15s;margin-top:4px;
                }
                .ulearn-save-btn:hover {background:#74c7ec}

                .ulearn-log-header {
                    display:flex;justify-content:space-between;align-items:center;
                    margin-top:10px;margin-bottom:6px;
                }
                .ulearn-log-title {font-size:10px;font-weight:600;color:#585b70;text-transform:uppercase;letter-spacing:0.5px}
                .ulearn-clear-btn {
                    background:rgba(255,255,255,0.05);border:0.5px solid rgba(255,255,255,0.06);
                    color:#585b70;font-size:10px;padding:2px 8px;border-radius:4px;cursor:pointer;
                }
                .ulearn-clear-btn:hover {background:rgba(255,255,255,0.1);color:#9399b2}
                .ulearn-log {
                    height:110px;overflow:auto;
                    background:#181825;border-radius:8px;
                    padding:6px 8px;font-size:11px;line-height:1.6;
                    font-family:"SF Mono","Cascadia Code",Consolas,monospace;
                }
                .ulearn-log::-webkit-scrollbar {width:4px}
                .ulearn-log::-webkit-scrollbar-track {background:transparent}
                .ulearn-log::-webkit-scrollbar-thumb {background:rgba(255,255,255,0.08);border-radius:2px}
                .log-time {color:#585b70}
                .log-success {color:#a6e3a1}
                .log-info {color:#89b4fa}
                .log-warn {color:#f9e2af}
                .log-error {color:#f38ba8}

                /* ========== 浅色主题 ========== */
                .ulearn-panel.light {
                    background:#ffffff;color:#4c4f69;
                    border:0.5px solid rgba(0,0,0,0.08);
                    box-shadow:0 8px 32px rgba(0,0,0,0.08);
                }
                .ulearn-panel.light .ulearn-header {background:#e6e9ef}
                .ulearn-panel.light .ulearn-header-title {color:#4c4f69}
                .ulearn-panel.light .ulearn-header-btn {background:rgba(0,0,0,0.04);border-color:rgba(0,0,0,0.06);color:#6c6f85}
                .ulearn-panel.light .ulearn-header-btn:hover {background:rgba(0,0,0,0.08);color:#4c4f69}
                .ulearn-panel.light .ulearn-status {background:rgba(166,227,161,0.25)}
                .ulearn-panel.light .ulearn-status.paused {background:rgba(243,139,168,0.15)}
                .ulearn-panel.light .ulearn-card {background:#eff1f5;border-color:rgba(0,0,0,0.04)}
                .ulearn-panel.light .ulearn-card-row + .ulearn-card-row {border-top:0.5px solid rgba(0,0,0,0.04)}
                .ulearn-panel.light .ulearn-card-title {color:#8c8fa1}
                .ulearn-panel.light .ulearn-rate-value {color:#4c4f69}
                .ulearn-panel.light .ulearn-rate-unit {color:#8c8fa1}
                .ulearn-panel.light .ulearn-rate-btn.minus {background:rgba(0,0,0,0.04);color:#6c6f85}
                .ulearn-panel.light .ulearn-rate-btn.minus:hover {background:rgba(0,0,0,0.08);color:#4c4f69}
                .ulearn-panel.light .ulearn-progress-bar {background:rgba(0,0,0,0.06)}
                .ulearn-panel.light .ulearn-progress-text {color:#8c8fa1}
                .ulearn-panel.light .ulearn-toggle {background:#ccd0da}
                .ulearn-panel.light .ulearn-toggle.active {background:#a6e3a1}
                .ulearn-panel.light .ulearn-toggle-knob {background:#ffffff}
                .ulearn-panel.light .ulearn-toggle-btn {background:rgba(0,0,0,0.04);border-color:rgba(0,0,0,0.06);color:#6c6f85}
                .ulearn-panel.light .ulearn-toggle-btn:hover {background:rgba(0,0,0,0.08);color:#4c4f69}
                .ulearn-panel.light .ulearn-log {background:#e6e9ef}
                .ulearn-panel.light .ulearn-log::-webkit-scrollbar-thumb {background:rgba(0,0,0,0.12)}
                .ulearn-panel.light .log-time {color:#8c8fa1}
                .ulearn-panel.light .ulearn-save-btn {background:#89b4fa;color:#1e1e2e}
                .ulearn-panel.light .ulearn-save-btn:hover {background:#74c7ec}
                .ulearn-panel.light .ulearn-clear-btn {background:rgba(0,0,0,0.04);border-color:rgba(0,0,0,0.06);color:#8c8fa1}
                .ulearn-panel.light .ulearn-clear-btn:hover {background:rgba(0,0,0,0.08);color:#6c6f85}
            `;
            document.head.appendChild(style);
        }

        createPanel() {
            const panel = document.createElement('div');
            panel.className = 'ulearn-panel';
            panel.innerHTML = `
                <div class="ulearn-header">
                    <span class="ulearn-header-title">DGUT 优学院助手 v2.3</span>
                    <div class="ulearn-header-btns">
                        <div class="ulearn-header-btn" id="themeBtn" title="切换主题">🌓</div>
                        <div class="ulearn-header-btn" id="collapseBtn" title="折叠">▼</div>
                    </div>
                </div>

                <div class="ulearn-body" id="panelBody">
                    <div class="ulearn-status" id="statusBar">
                        <div class="ulearn-status-left">
                            <div class="ulearn-status-dot"></div>
                            <span class="ulearn-status-text" id="statusText">运行中</span>
                        </div>
                        <button class="ulearn-toggle-btn" id="toggleScript">暂停</button>
                    </div>

                    <div class="ulearn-progress">
                        <div class="ulearn-progress-bar">
                            <div class="ulearn-progress-fill" id="progressFill" style="width:0%"></div>
                        </div>
                        <div class="ulearn-progress-text">
                            <span id="progressLabel">检测中...</span>
                            <span id="progressPct">0%</span>
                        </div>
                    </div>

                    <div class="ulearn-card">
                        <div class="ulearn-card-title">播放速率</div>
                        <div class="ulearn-card-row">
                            <div>
                                <span class="ulearn-rate-value" id="rateDisplay">${AppConfig.playbackRate}</span>
                                <span class="ulearn-rate-unit">x</span>
                            </div>
                            <div class="ulearn-rate-controls">
                                <button class="ulearn-rate-btn minus" id="speedDown">−</button>
                                <button class="ulearn-rate-btn plus" id="speedUp">+</button>
                            </div>
                        </div>
                    </div>

                    <div class="ulearn-card">
                        <div class="ulearn-card-title">视频设置</div>
                        <div class="ulearn-card-row">
                            <span>自动播放</span>
                            <div class="ulearn-toggle active" data-key="autoPlay"><div class="ulearn-toggle-knob"></div></div>
                        </div>
                        <div class="ulearn-card-row">
                            <span>自动静音</span>
                            <div class="ulearn-toggle active" data-key="autoMute"><div class="ulearn-toggle-knob"></div></div>
                        </div>
                        <div class="ulearn-card-row">
                            <span>自动调整速率</span>
                            <div class="ulearn-toggle active" data-key="autoAdjustRate"><div class="ulearn-toggle-knob"></div></div>
                        </div>
                    </div>

                    <div class="ulearn-card">
                        <div class="ulearn-card-title">自动作答</div>
                        <div class="ulearn-card-row">
                            <span>自动填答</span>
                            <div class="ulearn-toggle active" data-key="autoFillAnswers"><div class="ulearn-toggle-knob"></div></div>
                        </div>
                        <div class="ulearn-card-row">
                            <span>显示答案</span>
                            <div class="ulearn-toggle active" data-key="showAnswers"><div class="ulearn-toggle-knob"></div></div>
                        </div>
                        <div class="ulearn-card-row">
                            <span>答选择题</span>
                            <div class="ulearn-toggle active" data-key="autoAnswerSingle"><div class="ulearn-toggle-knob"></div></div>
                        </div>
                        <div class="ulearn-card-row">
                            <span>答判断题</span>
                            <div class="ulearn-toggle active" data-key="autoAnswerJudge"><div class="ulearn-toggle-knob"></div></div>
                        </div>
                        <div class="ulearn-card-row">
                            <span>答填空题</span>
                            <div class="ulearn-toggle active" data-key="autoAnswerBlank"><div class="ulearn-toggle-knob"></div></div>
                        </div>
                    </div>

                    <button class="ulearn-save-btn" id="saveSettings">保存设置</button>

                    <div class="ulearn-log-header">
                        <span class="ulearn-log-title">运行日志</span>
                        <button class="ulearn-clear-btn" id="clearLog">清空</button>
                    </div>
                    <div id="logContainer" class="ulearn-log"></div>
                </div>

                <input type="hidden" id="rateInput" value="${AppConfig.playbackRate}">
            `;
            document.body.appendChild(panel);
            this.panel = panel;
            Logger.init(document.getElementById('logContainer'));

            this.restorePanelPosition();
            this.startProgressUpdate();
        }

        savePanelPosition() {
            const rect = this.panel.getBoundingClientRect();
            localStorage.setItem(STORAGE_PREFIX + 'panelPos', JSON.stringify({
                left: rect.left,
                top: rect.top
            }));
        }

        restorePanelPosition() {
            const saved = localStorage.getItem(STORAGE_PREFIX + 'panelPos');
            if (saved) {
                try {
                    const pos = JSON.parse(saved);
                    if (pos.left && pos.top) {
                        this.panel.style.left = pos.left + 'px';
                        this.panel.style.top = pos.top + 'px';
                        this.panel.style.right = 'auto';
                    }
                } catch (e) { /* 忽略无效数据 */ }
            }
        }

        startProgressUpdate() {
            setInterval(() => {
                const pageItems = $('.page-item');
                const total = pageItems.length;
                if (total === 0) return;

                let activeIdx = 0;
                pageItems.each((idx, item) => {
                    const pageName = $(item).find('.page-name');
                    if (pageName.length > 0 && pageName[0].className.includes('active')) {
                        activeIdx = idx;
                    }
                });

                const progress = Math.round(((activeIdx + 1) / total) * 100);
                const fill = document.getElementById('progressFill');
                const label = document.getElementById('progressLabel');
                const pct = document.getElementById('progressPct');
                if (fill) fill.style.width = progress + '%';
                if (label) label.textContent = `第 ${activeIdx + 1}/${total} 页`;
                if (pct) pct.textContent = progress + '%';
            }, 3000);
        }

        // 获取 toggle 状态
        isToggleActive(key) {
            const el = this.panel.querySelector(`.ulearn-toggle[data-key="${key}"]`);
            return el ? el.classList.contains('active') : false;
        }

        // 设置 toggle 状态
        setToggleActive(key, active) {
            const el = this.panel.querySelector(`.ulearn-toggle[data-key="${key}"]`);
            if (el) {
                if (active) el.classList.add('active');
                else el.classList.remove('active');
            }
        }

        bindEvents() {
            // 拖动
            this.panel.onmousedown = (e) => {
                if (e.target.closest('.ulearn-header-btn') || e.target.closest('.ulearn-toggle') ||
                    e.target.closest('.ulearn-toggle-btn') || e.target.closest('.ulearn-save-btn') ||
                    e.target.closest('.ulearn-clear-btn') || e.target.closest('.ulearn-rate-btn')) return;

                const offsetX = e.clientX - this.panel.offsetLeft;
                const offsetY = e.clientY - this.panel.offsetTop;

                const moveHandler = (e) => {
                    const maxTop = window.innerHeight - this.panel.offsetHeight - 10;
                    const newTop = Math.max(10, Math.min(maxTop, e.clientY - offsetY));
                    this.panel.style.left = `${e.clientX - offsetX}px`;
                    this.panel.style.top = `${newTop}px`;
                    this.panel.style.right = 'auto';
                };

                const upHandler = () => {
                    document.removeEventListener('mousemove', moveHandler);
                    document.removeEventListener('mouseup', upHandler);
                    this.savePanelPosition();
                };

                document.addEventListener('mousemove', moveHandler);
                document.addEventListener('mouseup', upHandler);
            };

            // 主题切换
            document.getElementById('themeBtn').addEventListener('click', () => {
                AppConfig.lightTheme = !AppConfig.lightTheme;
                this.applyTheme(AppConfig.lightTheme);
                AppConfig.save();
                Logger.log(`已切换为${AppConfig.lightTheme ? '浅色' : '深色'}主题`, 'info');
            });

            // 折叠/展开
            document.getElementById('collapseBtn').addEventListener('click', () => {
                this.isCollapsed = !this.isCollapsed;
                const body = document.getElementById('panelBody');
                const btn = document.getElementById('collapseBtn');
                if (this.isCollapsed) {
                    body.classList.add('hidden');
                    btn.textContent = '▶';
                } else {
                    body.classList.remove('hidden');
                    btn.textContent = '▼';
                }
            });

            // 清空日志
            document.getElementById('clearLog').addEventListener('click', () => {
                if (Logger.element) {
                    Logger.element.innerHTML = '';
                    Logger.log("日志已清空");
                }
            });

            // 速率控制
            document.getElementById('speedUp').addEventListener('click', () => {
                if (AppState.isRestarting) return;
                AppConfig.playbackRate = Math.min(15, AppConfig.playbackRate + 1);
                this.updateRateDisplay();
            });

            document.getElementById('speedDown').addEventListener('click', () => {
                if (AppState.isRestarting) return;
                AppConfig.playbackRate = Math.max(1, AppConfig.playbackRate - 1);
                this.updateRateDisplay();
            });

            // 暂停/继续
            document.getElementById('toggleScript').addEventListener('click', () => {
                if (AppState.isRestarting) {
                    Logger.log("重启中，暂不支持操作");
                    return;
                }

                AppState.isPaused = !AppState.isPaused;
                const statusBar = document.getElementById('statusBar');
                const statusText = document.getElementById('statusText');
                const toggleBtn = document.getElementById('toggleScript');

                if (AppState.isPaused) {
                    statusBar.classList.add('paused');
                    statusText.textContent = '已暂停';
                    toggleBtn.textContent = '继续';
                    Logger.log("脚本已暂停");
                } else {
                    statusBar.classList.remove('paused');
                    statusText.textContent = '运行中';
                    toggleBtn.textContent = '暂停';
                    Logger.log("脚本已恢复运行");
                    videoController.processVideos();
                    videoController.checkModals();
                }
            });

            // Toggle 开关点击
            this.panel.addEventListener('click', (e) => {
                const toggle = e.target.closest('.ulearn-toggle');
                if (!toggle) return;
                if (AppState.isRestarting) return;

                const key = toggle.dataset.key;
                toggle.classList.toggle('active');

                // 联动逻辑
                if (key === 'autoPlay') {
                    const active = toggle.classList.contains('active');
                    this.setToggleActive('autoMute', active);
                    this.setToggleActive('autoAdjustRate', active);
                }
                if (key === 'autoFillAnswers') {
                    const active = toggle.classList.contains('active');
                    this.setToggleActive('showAnswers', active);
                    this.setToggleActive('autoAnswerSingle', active);
                    this.setToggleActive('autoAnswerJudge', active);
                    this.setToggleActive('autoAnswerBlank', active);
                }
            });

            // 保存设置
            document.getElementById('saveSettings').addEventListener('click', () => {
                if (AppState.isRestarting) {
                    Logger.log("重启中，暂不支持保存");
                    return;
                }

                AppConfig.autoPlay = this.isToggleActive('autoPlay');
                AppConfig.autoMute = this.isToggleActive('autoMute');
                AppConfig.autoAdjustRate = this.isToggleActive('autoAdjustRate');
                AppConfig.autoFillAnswers = this.isToggleActive('autoFillAnswers');
                AppConfig.showAnswers = this.isToggleActive('showAnswers');
                AppConfig.autoAnswerSingle = this.isToggleActive('autoAnswerSingle');
                AppConfig.autoAnswerJudge = this.isToggleActive('autoAnswerJudge');
                AppConfig.autoAnswerBlank = this.isToggleActive('autoAnswerBlank');
                AppConfig.playbackRate = parseFloat(document.getElementById('rateInput').value);

                AppConfig.save();
                localStorage.setItem(STORAGE_PREFIX + 'paused', AppState.isPaused);
                localStorage.setItem(STORAGE_PREFIX + 'retryCount', AppState.nextPageRetry);

                this.updateRateDisplay();
                Logger.log("设置已保存", 'success');

                if (!AppState.isPaused) {
                    videoController.processVideos();
                    videoController.checkModals();
                }
            });
        }

        applyTheme(isLight) {
            if (isLight) {
                this.panel.classList.add('light');
            } else {
                this.panel.classList.remove('light');
            }
        }

        syncConfigToUI() {
            this.setToggleActive('autoPlay', AppConfig.autoPlay);
            this.setToggleActive('autoMute', AppConfig.autoMute);
            this.setToggleActive('autoAdjustRate', AppConfig.autoAdjustRate);
            this.setToggleActive('autoFillAnswers', AppConfig.autoFillAnswers);
            this.setToggleActive('showAnswers', AppConfig.showAnswers);
            this.setToggleActive('autoAnswerSingle', AppConfig.autoAnswerSingle);
            this.setToggleActive('autoAnswerJudge', AppConfig.autoAnswerJudge);
            this.setToggleActive('autoAnswerBlank', AppConfig.autoAnswerBlank);
            this.applyTheme(AppConfig.lightTheme);
            document.getElementById('rateInput').value = AppConfig.playbackRate;

            AppState.isPaused = localStorage.getItem(STORAGE_PREFIX + 'paused') === 'true';
            AppState.nextPageRetry = parseInt(localStorage.getItem(STORAGE_PREFIX + 'retryCount') || '0');

            const statusBar = document.getElementById('statusBar');
            const statusText = document.getElementById('statusText');
            const toggleBtn = document.getElementById('toggleScript');
            if (AppState.isPaused) {
                statusBar.classList.add('paused');
                statusText.textContent = '已暂停';
                toggleBtn.textContent = '继续';
            } else {
                statusBar.classList.remove('paused');
                statusText.textContent = '运行中';
                toggleBtn.textContent = '暂停';
            }
        }

        updateRateDisplay() {
            const display = document.getElementById('rateDisplay');
            const input = document.getElementById('rateInput');
            display.innerText = AppConfig.playbackRate;
            input.value = AppConfig.playbackRate;

            const video = document.querySelector("video, mediaelementwrapper video:first-child");
            if (video) video.playbackRate = AppConfig.playbackRate;

            Logger.log(`播放速率已调整为 ${AppConfig.playbackRate}x`, 'info');
        }
    }

    // ===================== 防检测处理 =====================

    function setupAntiDetection() {
        // [P1修复] 删除过时的 UA 伪装（Chrome 83 太老反而可疑）
        // [P1修复] 替换废弃的 __defineGetter__ 为 Object.defineProperty
        // 如果平台检测 playbackRate，劫持 getter 隐藏真实倍速
        try {
            const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
            if (originalDescriptor) {
                Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
                    get: function () {
                        // 当外部查询 playbackRate 时，返回 1 倍速
                        return this._displayRate || 1;
                    },
                    set: function (val) {
                        this._displayRate = 1;          // 对外始终显示 1x
                        this._actualRate = val;          // 内部记录真实倍速
                        if (originalDescriptor.set) {
                            originalDescriptor.set.call(this, val);  // 实际设置倍速
                        }
                    },
                    configurable: true
                });
            }
        } catch (e) {
            Logger.log(`playbackRate 劫持失败: ${e.message}`);
        }

        // [P1修复] 鼠标模拟随机化（3-8秒随机间隔）
        function simulateActivity() {
            if (AppState.isPaused || AppState.isRestarting) {
                setTimeout(simulateActivity, 5000);
                return;
            }
            document.dispatchEvent(new MouseEvent('mousemove', {
                clientX: Math.random() * window.innerWidth,
                clientY: Math.random() * window.innerHeight
            }));
            const nextDelay = 3000 + Math.random() * 5000;
            setTimeout(simulateActivity, nextDelay);
        }
        setTimeout(simulateActivity, 5000);
    }

    // ===================== 全局错误边界 =====================

    // [P2修复] 捕获未处理异常，防止脚本静默崩溃
    window.addEventListener('error', (e) => {
        Logger.log(`全局错误: ${e.message}`);
        // 非严重错误不重启，避免频繁重启
        if (e.message && !e.message.includes('Script error')) {
            AppRestarter.restart();
        }
    });

    window.addEventListener('unhandledrejection', (e) => {
        Logger.log(`未处理的Promise异常: ${e.reason}`);
    });

    // ===================== jQuery 加载检查 =====================

    // [P2修复] 确保 jQuery 已加载
    function waitForjQuery(callback, maxWait = 10000) {
        if (typeof $ !== 'undefined' && typeof $.fn !== 'undefined') {
            callback();
            return;
        }
        const startTime = Date.now();
        const check = setInterval(() => {
            if (typeof $ !== 'undefined' && typeof $.fn !== 'undefined') {
                clearInterval(check);
                callback();
            } else if (Date.now() - startTime > maxWait) {
                clearInterval(check);
                console.error('DGUT助手: jQuery 加载超时，脚本无法启动');
            }
        }, 200);
    }

    // ===================== 初始化应用 =====================

    const uiController = new UIController();
    const videoController = new VideoController();
    const answerProcessor = new AnswerProcessor();

    function initApp() {
        uiController.render();
        videoController.init();
        setupAntiDetection();

        if (!AppState.isPaused && !AppState.isRestarting) {
            videoController.processVideos();
            videoController.checkModals();
        }
    }

    // [P2修复] 先等 jQuery，再初始化
    waitForjQuery(() => {
        setTimeout(initApp, 3000);
    });
})();
