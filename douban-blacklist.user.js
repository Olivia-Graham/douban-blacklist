// ==UserScript==
// @name         豆瓣一键拉黑增强版（含大赦天下）
// @namespace    https://github.com/user/douban-blacklist
// @version      2.1.0
// @description  在豆瓣帖子/广播/日志的评论、点赞、转发页面及小组成员页面一键拉黑；在黑名单页面一键解除所有拉黑
// @author       user
// @license      GPL 3.0
// @match        https://www.douban.com/**
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ===================== 配置 =====================
    const SLEEP_MIN  = 2000;
    const SLEEP_MAX  = 4000;
    const PAGE_SLEEP = 3500;
    const MAX_PAGES  = 100;

    const URL_BAN = "https://www.douban.com/j/contact/addtoblacklist";

    // ===================== 工具 =====================
    function getCookie(name) {
        let m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
        return m ? decodeURIComponent(m[2]) : "";
    }
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rand  = () => Math.floor(Math.random() * (SLEEP_MAX - SLEEP_MIN)) + SLEEP_MIN;

    function getCK() {
        return document.getElementsByName('ck')[0]?.value
            || getCookie('ck')
            || (typeof DOUBAN !== "undefined" && DOUBAN.ck)
            || "";
    }

    async function getRealUserId(href) {
        let slug = href.replace(/\/$/, "").split('/').pop();
        if (/^\d{5,}$/.test(slug)) return slug;
        try {
            let text = await fetch(href).then(r => r.text());
            let m = text.match(/id["']?:\s*["']?(\d{5,})["']?/)
                 || text.match(/douban_id\s*=\s*['"](\d+)['"]/)
                 || text.match(/people\/(\d+)\//);
            return m ? m[1] : null;
        } catch { return null; }
    }

    async function postBan(realId, ck) {
        try {
            let res  = await fetch(URL_BAN, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-Requested-With": "XMLHttpRequest"
                },
                body: `people=${realId}&ck=${ck}`
            });
            let json = await res.json();
            if (json.result === true || json.result === "true" || json.r === 0) return 'ok';
            if (json.msg === "Duplicate entry") return 'dup';
            if (json.error === 'captcha_required') return 'captcha';
            return 'fail';
        } catch { return 'fail'; }
    }

    // ===================== 按钮工厂 =====================
    function makeBtn(label, color) {
        color = color || '#e86b47';
        let btn = document.createElement('a');
        btn.textContent = label;
        btn.className   = 'db-bl-btn';
        Object.assign(btn.style, {
            display: 'inline-block', margin: '6px 0 6px 10px',
            padding: '4px 11px', background: color,
            color: '#fff', borderRadius: '4px', fontSize: '13px',
            cursor: 'pointer', userSelect: 'none',
            textDecoration: 'none', lineHeight: '1.7',
            transition: 'opacity .15s'
        });
        btn.onmouseenter = () => btn.style.opacity = '.8';
        btn.onmouseleave = () => btn.style.opacity = '1';
        return btn;
    }

    function lockBtn(btn) {
        btn.style.background = '#999';
        btn.onmouseenter = null;
        btn.onmouseleave = null;
        btn.onclick = e => e.preventDefault();
    }

    // ===================== 核心批量拉黑 =====================
    // 先去重再遍历，计数器用去重后的下标，不会跳跃
    async function banItems(items, ck, btn, pageLabel) {
        let seen = new Set(), deduped = [];
        for (let item of items) {
            let key = item.id || item.href;
            if (!seen.has(key)) { seen.add(key); deduped.push(item); }
        }

        let success = 0;
        for (let i = 0; i < deduped.length; i++) {
            let { href, id, name } = deduped[i];
            btn.textContent = `${pageLabel} ${i + 1}/${deduped.length}: ${name || ''}`;

            let realId = id || await getRealUserId(href);
            if (!realId) { console.warn('[豆瓣拉黑] 无法解析 ID:', href); continue; }

            let r = await postBan(realId, ck);
            if      (r === 'ok')      { success++; console.log(`✅ 拉黑成功: ${name}`); }
            else if (r === 'dup')     { console.log(`🆗 已在黑名单: ${name}`); }
            else if (r === 'captcha') { return -1; }
            else                      { console.warn(`❌ 失败: ${name}`); }

            await sleep(rand());
        }
        return success;
    }

    async function runPaginated(btn, getItems, getNextUrl) {
        let ck = getCK();
        if (!ck) { alert('❌ 无法获取 ck，请刷新页面重新登录。'); return; }
        lockBtn(btn);

        let currentDoc = document, total = 0;
        for (let p = 1; p <= MAX_PAGES; p++) {
            let items = getItems(currentDoc);
            if (!items.length) { btn.textContent = `✅ 第${p}页无内容，结束（共 ${total} 人）`; break; }

            let r = await banItems(items, ck, btn, `第${p}页`);
            if (r === -1) {
                alert('⚠️ 触发验证码！脚本已暂停，请手动验证后重新点击按钮。');
                btn.textContent = '⚠️ 验证码中断';
                return;
            }
            total += r;

            let nextUrl = getNextUrl(currentDoc);
            if (nextUrl && p < MAX_PAGES) {
                btn.textContent = `⏳ 第${p}页完成，加载下一页…`;
                await sleep(PAGE_SLEEP);
                try {
                    let html = await fetch(nextUrl).then(r => r.text());
                    currentDoc = new DOMParser().parseFromString(html, 'text/html');
                } catch { break; }
            } else { break; }
        }
        btn.textContent = `🎉 完成！共拉黑 ${total} 人`;
    }

    // ===================== 翻页 =====================
    function getNextUrl(doc) {
        let n = doc.querySelector('span.next a, link[rel="next"]');
        return n ? n.href : null;
    }

    // ===================== 各场景取用户列表 =====================

    // 广播/日志 评论
    function commentLinks(doc) {
        let result = [], seen = new Set();
        doc.querySelectorAll(
            'div.item .meta-header a[href*="/people/"], div.reply-item .meta-header a[href*="/people/"]'
        ).forEach(a => {
            let href = (a.href || '').split('?')[0];
            if (!href.includes('/people/') || seen.has(href)) return;
            seen.add(href);
            result.push({ href, name: a.textContent.trim() });
        });
        return result;
    }

    // 点赞/转发/收藏/赞赏列表页
    // 核心修复：只取列表 li 里的第一个用户链接，且排除帖子头部区域
    function likeReshareLinks(doc) {
        let result = [], seen = new Set();

        // 头部区域选择器（帖子作者、广播原文作者等），这些区域内的链接一律跳过
        const HEADER_SELS = [
            '.article-title', '.status-saying', '.note-header',
            '.topic-content', '.status-author', '#topic-content',
            '.status-item .status-saying', '.topic-doc'
        ];

        // 找到列表主容器
        // 豆瓣列表页通常是 #content 下的某个 ul，每个 li 是一个用户条目
        let listEl = doc.querySelector(
            'ul.list-items, ul.listing, .mod-bd > ul, #content > div > ul, #content > ul'
        );

        let candidates = listEl
            ? listEl.querySelectorAll('li')
            : doc.querySelectorAll('#content li');

        candidates.forEach(li => {
            // 跳过在头部区域内的 li
            for (let sel of HEADER_SELS) {
                if (li.closest(sel)) return;
            }
            // 每个 li 只取第一个 /people/ 链接（头像和名字指向同一人，不重复抓）
            let a = li.querySelector('a[href*="/people/"]');
            if (!a) return;
            let href = (a.href || '').split('?')[0];
            if (!href.includes('/people/') || href.includes('accounts/login')) return;
            if (seen.has(href)) return;
            seen.add(href);
            result.push({ href, name: a.textContent.trim() });
        });
        return result;
    }

    // 小组成员页
    function memberLinks(doc) {
        let result = [], seen = new Set();
        doc.querySelectorAll(
            '.member-list .name a[href*="/people/"], .obs .name a[href*="/people/"]'
        ).forEach(a => {
            let href = (a.href || '').split('?')[0];
            if (seen.has(href)) return;
            seen.add(href);
            result.push({ href, name: a.textContent.trim() });
        });
        return result;
    }

    // ===================== 小组帖子评论（ID 在 operation-div.id） =====================
    async function banGroupComments(btn) {
        let ck = getCK();
        if (!ck) { alert('❌ 无法获取 ck'); return; }
        lockBtn(btn);

        let items = [], seen = new Set();
        document.querySelectorAll('div.operation-div[id]').forEach(div => {
            let id = div.id;
            if (!/^\d{5,}$/.test(id) || seen.has(id)) return;
            seen.add(id);
            let nameEl = div.closest('.reply-item, .comment-item, li')
                           ?.querySelector('a[href*="/people/"]');
            items.push({ id, name: nameEl?.textContent.trim() || id });
        });

        let total = 0;
        for (let i = 0; i < items.length; i++) {
            let { id, name } = items[i];
            btn.textContent = `处理评论 ${i + 1}/${items.length}: ${name}`;
            let r = await postBan(id, ck);
            if (r === 'ok') { total++; console.log(`✅ 拉黑: ${name}`); }
            else if (r === 'captcha') {
                alert('⚠️ 触发验证码！脚本已暂停。');
                btn.textContent = '⚠️ 验证码中断';
                return;
            }
            await sleep(rand());
        }
        btn.textContent = `🎉 完成！拉黑 ${total} 人`;
    }

    // ===================== 大赦天下 =====================
    // 豆瓣解除拉黑：GET /contacts/blacklist?remove=用户slug&ck=xxx
    // remove 参数可以是纯数字 ID 也可以是字母 slug，直接用不需要转换

    // 滚动到页面底部，触发懒加载
    async function scrollToBottom() {
        return new Promise(resolve => {
            let last = 0;
            let timer = setInterval(() => {
                window.scrollTo(0, document.body.scrollHeight);
                if (document.body.scrollHeight === last) {
                    clearInterval(timer);
                    window.scrollTo(0, 0);
                    resolve();
                }
                last = document.body.scrollHeight;
            }, 400);
        });
    }

    // 从 document 中收集所有 remove 链接（slug 可以是字母或数字）
    function collectRemoveItems(doc) {
        let items = [], seen = new Set();
        doc.querySelectorAll('a[href*="remove="]').forEach(a => {
            let m = a.href.match(/remove=([^&]+)/);
            if (!m || seen.has(m[1])) return;
            seen.add(m[1]);
            let container = a.closest('li, .item, .gact-item, div');
            let nameA = container?.querySelector('a[href*="/people/"]');
            let name = nameA?.textContent.trim() || ('用户' + m[1]);
            items.push({ slug: m[1], name });
        });
        return items;
    }

    async function amnesty(btn) {
        let ck = getCK();
        if (!ck) { alert('❌ 无法获取 ck'); return; }
        lockBtn(btn);

        let total = 0, currentDoc = document;

        for (let p = 1; p <= MAX_PAGES; p++) {
            // 第一页先滚动到底部，确保懒加载的条目全部渲染出来
            if (p === 1) {
                btn.textContent = '⏳ 滚动页面加载全部数据…';
                await scrollToBottom();
                await sleep(600);
            }

            let items = collectRemoveItems(currentDoc);

            if (!items.length) {
                btn.textContent = `✅ 第${p}页无黑名单，结束（共解除 ${total} 人）`;
                break;
            }

            console.log(`[大赦天下] 第${p}页 ${items.length} 人`);

            for (let i = 0; i < items.length; i++) {
                let { slug, name } = items[i];
                btn.textContent = `第${p}页 解除 ${i + 1}/${items.length}: ${name}`;
                try {
                    await fetch(
                        `https://www.douban.com/contacts/blacklist?remove=${slug}&ck=${ck}`,
                        { credentials: 'include' }
                    );
                    total++;
                    console.log(`✅ 解除: ${name}`);
                } catch (e) {
                    console.warn(`❌ 解除失败: ${name}`, e);
                }
                await sleep(rand());
            }

            // 翻页
            let nextUrl = getNextUrl(currentDoc);
            if (nextUrl && p < MAX_PAGES) {
                btn.textContent = `⏳ 第${p}页完成，加载下一页…`;
                await sleep(PAGE_SLEEP);
                try {
                    let html = await fetch(nextUrl, { credentials: 'include' }).then(r => r.text());
                    currentDoc = new DOMParser().parseFromString(html, 'text/html');
                } catch { break; }
            } else { break; }
        }

        btn.textContent = `☀️ 大赦完成！共解除 ${total} 人`;
        setTimeout(() => location.reload(), 2000);
    }

    // ===================== 插入按钮 =====================
    function tryInsert(btn, selectors, asChild) {
        for (let sel of selectors) {
            let el = document.querySelector(sel);
            if (!el || document.querySelector('.db-bl-btn')) continue;
            if (asChild) el.appendChild(btn);
            else el.parentNode.insertBefore(btn, el.nextSibling);
            return true;
        }
        return false;
    }

    // ===================== 主逻辑 =====================
    function init() {
        let path   = window.location.pathname;
        let search = window.location.search + window.location.hash;

        // -------- 大赦天下 --------
        if (path.includes('/contacts/blacklist')) {
            setTimeout(() => {
                if (document.querySelector('.db-bl-btn')) return;
                let btn = makeBtn('☀️ 大赦天下（一键解除所有拉黑）', '#4a944a');
                btn.onclick = e => { e.preventDefault(); amnesty(btn); };
                if (!tryInsert(btn, ['#content h2', '.article-title', 'h1'], true)) {
                    document.body.prepend(btn);
                }
            }, 600);
            return;
        }

        // -------- 小组成员页 --------
        if (/\/group\/[^\/]+\/members/.test(path)) {
            setTimeout(() => {
                if (document.querySelector('.db-bl-btn')) return;
                let btn = makeBtn('🚫 一键拉黑所有小组成员');
                btn.onclick = e => { e.preventDefault(); runPaginated(btn, memberLinks, getNextUrl); };
                if (!tryInsert(btn, ['.group-member h2', '#content h2', 'h1'], true)) {
                    document.body.prepend(btn);
                }
            }, 600);
            return;
        }

        // -------- 帖子 / 广播 / 日志 --------
        const isStatus = /\/people\/[^\/]+\/status\/\d+/.test(path);
        const isNote   = /\/note\/\d+/.test(path);
        const isGroup  = /\/group\/topic\/\d+/.test(path);
        if (!isStatus && !isNote && !isGroup) return;

        let tabMode = 'comment';
        if      (search.includes('tab=like')    || search.includes('type=like'))    tabMode = 'like';
        else if (search.includes('tab=reshare') || search.includes('type=rec'))     tabMode = 'reshare';
        else if (search.includes('tab=collect') || search.includes('type=collect')) tabMode = 'collect';
        else if (search.includes('type=donate'))                                     tabMode = 'donate';

        setTimeout(() => {
            if (document.querySelector('.db-bl-btn')) return;
            let btn;

            if (tabMode === 'comment') {
                btn = makeBtn('🚫 一键拉黑所有评论者');
                btn.onclick = e => {
                    e.preventDefault();
                    if (isGroup) banGroupComments(btn);
                    else runPaginated(btn, commentLinks, getNextUrl);
                };
            } else if (tabMode === 'like') {
                btn = makeBtn('🚫 一键拉黑所有点赞的人');
                btn.onclick = e => { e.preventDefault(); runPaginated(btn, likeReshareLinks, getNextUrl); };
            } else if (tabMode === 'reshare') {
                btn = makeBtn('🚫 一键拉黑所有转发/推荐的人');
                btn.onclick = e => { e.preventDefault(); runPaginated(btn, likeReshareLinks, getNextUrl); };
            } else if (tabMode === 'collect') {
                btn = makeBtn('🚫 一键拉黑所有收藏的人');
                btn.onclick = e => { e.preventDefault(); runPaginated(btn, likeReshareLinks, getNextUrl); };
            } else if (tabMode === 'donate') {
                btn = makeBtn('🚫 一键拉黑所有赞赏的人');
                btn.onclick = e => { e.preventDefault(); runPaginated(btn, likeReshareLinks, getNextUrl); };
            }

            if (!btn) return;

            let tabs = document.querySelector('div.tabs');
            if (tabs) {
                btn.style.float = 'right';
                if (!tabs.querySelector('.db-bl-btn')) tabs.appendChild(btn);
            } else {
                // 小组帖子没有 tabs，插到标题后
                tryInsert(btn,
                    ['.topic-content h1', '#wrapper h1', '.article-title',
                     '#content h1', '#content h2', '#content'],
                    false
                );
            }
        }, 800);
    }

    init();

})();
