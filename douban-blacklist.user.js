// ==UserScript==
// @name         豆瓣小组一键拉黑
// @namespace    https://github.com/Olivia-Graham/douban-blacklist
// @version      2.2.0
// @description  在豆瓣贴子的评论、点赞、转发页面及小组成员页面一键拉黑；在黑名单页面一键解除所有拉黑
// @author       user
// @license      GPL 3.0
// @match        *://*.douban.com/*
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

    /**
     * 访问用户主页，获取真实的数字 ID，并精准检测是否为“已关注”用户
     */
    async function checkUser(href, knownId = null) {
        let id = knownId;
        if (!id && href) {
            let m = href.match(/people\/([^/]+)/);
            if (m) id = m[1];
        }

        let isFollowed = false;
        let isCaptcha = false;

        // 格式化主页 URL
        let profileUrl = href;
        if (!profileUrl) {
            if (id) profileUrl = `https://www.douban.com/people/${id}/`;
            else return { id: null, isFollowed: false };
        } else if (profileUrl.startsWith('/')) {
            profileUrl = window.location.origin + profileUrl;
        }

        try {
            // 【核心修复】：必须带上 credentials: 'include'
            // 否则豆瓣会认为这是未登录的游客访问，永远看不到“已关注”按钮
            let res = await fetch(profileUrl, { credentials: 'include' });
            let text = await res.text();

            // 检查是否因为请求过快触发了验证码
            if (text.includes('sec.douban.com') || res.url.includes('sec.douban.com')) {
                return { id, isFollowed: false, captcha: true };
            }

            // 1. 提取真实数字 ID（如果传进来的只是用户的英文名/个性后缀）
            if (!knownId) {
                let m = text.match(/id["']?:\s*["']?(\d{5,})["']?/)
                     || text.match(/douban_id\s*=\s*['"](\d+)['"]/);
                if (m) id = m[1];
            }

            // 2. 精准匹配关注状态的 UI 特征
            // 匹配类名包含 j-contact-remove、直接出现 >取消关注< 或者 class="user-cs" 的已关注字样
            const followedRegex = /class="[^"]*j-contact-remove[^"]*"|>取消关注<|user-cs[^>]*>\s*(已关注|互相关注)\s*</;
            if (followedRegex.test(text)) {
                isFollowed = true;
            }

        } catch (e) {
            console.error('[豆瓣拉黑] 检查关注状态失败:', profileUrl, e);
        }

        return { id, isFollowed, isCaptcha };
    }

    async function postBan(realId, ck) {
        try {
            let res = await fetch(URL_BAN, {
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
    async function banItems(items, ck, btn, pageLabel) {
        let seen = new Set(), deduped = [];
        for (let item of items) {
            let key = item.id || item.href;
            if (!seen.has(key)) { seen.add(key); deduped.push(item); }
        }

        let success = 0;
        for (let i = 0; i < deduped.length; i++) {
            let { href, id, name } = deduped[i];
            
            // 阶段 1：先检查用户信息与关注状态
            btn.textContent = `${pageLabel} ${i + 1}/${deduped.length}: 正在检查 ${name || ''}...`;
            
            let userInfo = await checkUser(href || `https://www.douban.com/people/${id}/`, id);
            
            if (userInfo.captcha) {
                return -1; // 触发了验证码拦截
            }
            
            let realId = userInfo.id;
            if (!realId) { console.warn('[豆瓣拉黑] 无法解析 ID:', href); continue; }

            // 遇到已关注用户，触发弹窗拦截
            if (userInfo.isFollowed) {
                let confirmMsg = `⚠️ 发现用户【${name || realId}】在您的关注列表中！\n\n点击【确定】：继续强制拉黑（将会自动取关）\n点击【取消】：跳过该用户`;
                if (!window.confirm(confirmMsg)) {
                    console.log(`⏩ 跳过已关注用户: ${name || realId}`);
                    btn.textContent = `⏩ 已跳过 ${name || realId}`;
                    await sleep(800);
                    continue; 
                }
            }

            // 稍微停顿一下，防止由于连续发送 checkUser 和 postBan 导致请求过于频繁
            await sleep(300);

            // 阶段 2：执行拉黑
            btn.textContent = `${pageLabel} ${i + 1}/${deduped.length}: 拉黑 ${name || ''}`;
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
                alert('⚠️ 触发豆瓣验证码机制！在访问用户主页或尝试拉黑时被拦截。\n\n脚本已暂停，请您手动刷新页面，完成一次操作输入验证码后，再重新点击按钮。');
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

    function likeReshareLinks(doc) {
        let result = [], seen = new Set();
        const HEADER_SELS = [
            '.article-title', '.status-saying', '.note-header',
            '.topic-content', '.status-author', '#topic-content',
            '.status-item .status-saying', '.topic-doc'
        ];
        let listEl = doc.querySelector(
            'ul.list-items, ul.listing, .mod-bd > ul, #content > div > ul, #content > ul'
        );
        let candidates = listEl
            ? listEl.querySelectorAll('li')
            : doc.querySelectorAll('#content li');

        candidates.forEach(li => {
            for (let sel of HEADER_SELS) {
                if (li.closest(sel)) return;
            }
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

    // ===================== 小组帖子评论 =====================
    async function banGroupComments(btn) {
        let ck = getCK();
        if (!ck) { alert('❌ 无法获取 ck'); return; }
        lockBtn(btn);

        let items = [], seen = new Set();
        document.querySelectorAll('div.operation-div[id]').forEach(div => {
            let id = div.id;
            if (!/^\d{5,}$/.test(id) || seen.has(id)) return;
            seen.add(id);
            
            // 精确抓取用户链接
            let nameEl = div.closest('.reply-item, .comment-item, li')?.querySelector('a[href*="/people/"]');
            let href = nameEl ? nameEl.href : `https://www.douban.com/people/${id}/`;
            let name = nameEl?.textContent.trim() || id;

            items.push({ id, name, href });
        });

        let total = 0;
        for (let i = 0; i < items.length; i++) {
            let { id, name, href } = items[i];
            
            // 加入检查环节
            btn.textContent = `正在检查 ${i + 1}/${items.length}: ${name}...`;
            let userInfo = await checkUser(href, id);

            if (userInfo.captcha) {
                alert('⚠️ 触发豆瓣验证码！在访问用户主页时被拦截，脚本已暂停。');
                btn.textContent = '⚠️ 验证码中断';
                return;
            }

            if (userInfo.isFollowed) {
                let confirmMsg = `⚠️ 发现用户【${name}】在您的关注列表中！\n\n点击【确定】：继续强制拉黑\n点击【取消】：跳过该用户`;
                if (!window.confirm(confirmMsg)) {
                    console.log(`⏩ 跳过已关注用户: ${name}`);
                    btn.textContent = `⏩ 已跳过 ${name}`;
                    await sleep(800);
                    continue;
                }
            }

            await sleep(300);

            btn.textContent = `处理评论 ${i + 1}/${items.length}: ${name}`;
            let r = await postBan(id, ck);
            if (r === 'ok') { total++; console.log(`✅ 拉黑: ${name}`); }
            else if (r === 'captcha') {
                alert('⚠️ 触发验证码！尝试拉黑时被拦截。');
                btn.textContent = '⚠️ 验证码中断';
                return;
            }
            await sleep(rand());
        }
        btn.textContent = `🎉 完成！拉黑 ${total} 人`;
    }

    // ===================== 大赦天下 =====================
    // ===================== 大赦天下 =====================
    async function amnesty(btn) {
        let ck = getCK();
        if (!ck) { alert('❌ 无法获取 ck'); return; }
        lockBtn(btn);

        let total = 0, currentDoc = document;

        for (let p = 1; p <= MAX_PAGES; p++) {
            let items = [], seen = new Set();
            currentDoc.querySelectorAll('a[href*="remove="]').forEach(a => {
                let m = a.href.match(/remove=(\d+)/);
                if (!m || seen.has(m[1])) return;
                seen.add(m[1]);
                let li = a.closest('li, .item, .gact-item')?.parentElement;
                let nameA = li?.querySelector('a[href*="/people/"]');
                items.push({ id: m[1], name: nameA?.textContent.trim() || m[1] });
            });

            // 如果当前页面抓不到人了，说明黑名单已经彻底空了
            if (!items.length) {
                btn.textContent = `✅ 黑名单已清空，结束（共解除 ${total} 人）`;
                break;
            }

            for (let i = 0; i < items.length; i++) {
                let { id, name } = items[i];
                btn.textContent = `解除中... 第 ${total + 1} 人: ${name}`;
                try {
                    await fetch(
                        `https://www.douban.com/contacts/blacklist?remove=${id}&ck=${ck}`,
                        { credentials: 'include' }
                    );
                    total++;
                    console.log(`✅ 解除: ${name}`);
                } catch (e) {
                    console.warn(`❌ 解除失败: ${name}`, e);
                }
                await sleep(rand());
            }

            if (p < MAX_PAGES) {
                btn.textContent = `⏳ 当前批次完成，正在重新获取黑名单…`;
                await sleep(PAGE_SLEEP);
                try {
                    // 【核心修复】：不再根据 nextUrl 翻页。
                    // 直接强制拉取黑名单首页，因为没解除的人会自动补位到第一页。
                    let html = await fetch("https://www.douban.com/contacts/blacklist", { credentials: 'include' }).then(r => r.text());
                    currentDoc = new DOMParser().parseFromString(html, 'text/html');
                } catch { break; }
            }
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

        // 大赦天下
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

        // 小组成员页
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

        // 帖子 / 广播 / 日志
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
