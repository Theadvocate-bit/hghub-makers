/**
 * HGhub · 短剧  前端逻辑
 *
 * 结构：常量 -> 工具 -> 图标 -> 状态 -> 网络 -> 视图 -> feed -> 详情 -> 播放
 *       -> 评论/分享 -> 分类/榜单/搜索/我的 -> 事件绑定 -> 启动
 *
 * 约定：
 *   - 所有点击走一个文档级委托（bindGlobal），不再有内联 onclick，避免同一动作触发 2~3 次。
 *   - 所有分页请求用「状态对象快照 + gen」隔离，慢请求回来不会刷掉新列表。
 *   - 所有上游字段读取都过 vidOf()，兼容列表（id）与榜单（video_id）两种形状。
 */
(function () {
  'use strict';

  /* ============================== 常量 ============================== */

  var APP_VERSION = '1.3.1';
  /* 分享面板里的「下载 App」地址：发新版只改这里 */
  var APK_URL = 'https://github.com/vps1986/hghub-clone/releases/download/v1.2.0.8/HGhub-1.2.0.8.apk';
  /* 本机没带 hls.js 时的兜底 CDN（原版是内联 script 加载，这里改成运行时按需加载） */
  var HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
  var EP_PAGE = 30; /* 选集分页：每段 30 集 */

  /* 分享链接基于当前站点，而不是写死上游的 sp1.45678.eu.org */
  var SITE_BASE = (function () {
    return location.origin + location.pathname.replace(/[^/]*$/, '');
  })();

  /* ============================== 工具 ============================== */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtN(n) {
    n = +n || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }

  function fmtDur(s) {
    s = Math.max(0, Math.floor(+s || 0));
    var m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function fmtTime(t) {
    if (!t) return '';
    var d = new Date(t);
    if (isNaN(d.getTime())) return String(t);
    return d.toLocaleString();
  }

  var toastTimer = null;
  function toast(text) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = text;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, 2200);
  }

  var store = {
    get: function (key, def) {
      try {
        var raw = localStorage.getItem(key);
        if (raw === null || raw === undefined) return def;
        var v = JSON.parse(raw);
        return v === null || v === undefined ? def : v;
      } catch (e) { return def; }
    },
    set: function (key, value) {
      try {
        if (value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
      } catch (e) { /* 隐私模式/配额满：忽略，不影响播放 */ }
    }
  };

  function copyText(text) {
    if (!text) { toast('暂无可复制的内容'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制'); }, function () { fallbackCopy(text); });
      return;
    }
    fallbackCopy(text);
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      toast(ok ? '已复制' : text);
    } catch (e) { toast(text); }
  }

  function vidOf(v) { return +((v && (v.video_id || v.id)) || 0); }

  function ic(name, filled) {
    var icons = {
      star: '<path d="M12 2.8l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.6l-5.8 3.1 1.1-6.5L2.6 9.6l6.5-.9L12 2.8z"/>',
      comment: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
      share: '<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
      vol: '<path d="M11 5 6.5 9H3v6h3.5L11 19V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/>',
      volx: '<path d="M11 5 6.5 9H3v6h3.5L11 19V5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'
    };
    return '<svg class="ic-svg" width="14" height="14" viewBox="0 0 24 24" fill="' + (filled ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (icons[name] || '') + '</svg>';
  }

  /* ============================== 状态 ============================== */

  var state = {
    view: 'home',
    videoId: 0,
    ep: 1,
    detail: null,
    streams: null,
    epRange: 0,
    playerOpen: false,
    hls: null,
    slideId: 0
  };

  var feed = { items: [], page: 0, pages: 1, total: 0, loading: false, done: false, retries: 0, gen: 0, booted: false };
  var catItems = [], searchItems = [];
  var catState = null, searchState = null, rankGen = 0;

  var slideHls = {};
  var slideObserver = null;

  var playCache = {}, playInflight = {};
  var PLAY_CACHE_MAX = 60;

  var _likes = null, _favs = null;
  function likes() { if (!_likes) _likes = store.get('hg_likes', {}); return _likes; }
  function favs() { if (!_favs) _favs = store.get('hg_fav', []); return _favs; }

  /* ============================== 网络 ============================== */

  function fetchJson(url, opts, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs || 15000);
    var init = { signal: ctrl.signal, headers: { Accept: 'application/json' }, cache: 'no-store' };
    if (opts) for (var k in opts) init[k] = opts[k];

    return fetch(url, init).then(function (res) {
      return res.text().then(function (text) {
        clearTimeout(timer);
        var data;
        try { data = text ? JSON.parse(text) : {}; }
        catch (e) { throw new Error('返回不是 JSON（HTTP ' + res.status + '）'); }
        if (!res.ok) throw new Error((data && (data.msg || data.error)) || ('HTTP ' + res.status));
        return data;
      });
    }, function (err) {
      clearTimeout(timer);
      throw err && err.name === 'AbortError' ? new Error('请求超时') : err;
    });
  }

  /** 上游 API：先走本站同源反代，失败再走 /api/up/*（都是同源，不跨域直连上游）。 */
  function api(path) {
    return fetchJson(path).catch(function (firstErr) {
      if (path.indexOf('/api/up/') === 0) throw firstErr;
      return fetchJson('/api/up/' + path.replace(/^\/api\//, '')).catch(function () { throw firstErr; });
    }).then(function (j) {
      return j && j.data !== undefined ? j : { data: j };
    });
  }

  function itemsOf(j) {
    if (!j) return [];
    var d = j.data !== undefined ? j.data : j;
    if (Array.isArray(d)) return d;
    if (!d || typeof d !== 'object') return [];
    if (Array.isArray(d.items)) return d.items;
    if (Array.isArray(d.list)) return d.list;
    if (Array.isArray(d.videos)) return d.videos;
    return [];
  }

  function pagOf(j) {
    var d = j && j.data !== undefined ? j.data : j;
    var p = (d && d.pagination) || {};
    return { page: p.page || 1, pages: p.pages || 1, size: p.size || 20, total: p.total || 0 };
  }

  /** 取某集播放地址：带缓存 + 合并并发（滑到同一集不会再发两次请求）。 */
  function getStreams(id, ep) {
    var key = id + ':' + ep;
    if (playCache[key]) return Promise.resolve(playCache[key]);
    if (playInflight[key]) return playInflight[key];

    var p = fetchJson('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, ep: ep })
    }, 20000).then(function (j) {
      delete playInflight[key];
      var st = (j.data && j.data.streams) || j.streams || {};
      if (!st.main && !st.hevc && !st.preview) throw new Error('该集暂无播放源');
      playCache[key] = st;
      var keys = Object.keys(playCache);
      if (keys.length > PLAY_CACHE_MAX) delete playCache[keys[0]];
      return st;
    }, function (err) {
      delete playInflight[key];
      throw err;
    });

    playInflight[key] = p;
    return p;
  }

  /** 预加载下一集：只取播放地址（走代理线路时顺带把清单拉热）。 */
  function preload(id, ep) {
    if (!id || !ep || ep < 1) return;
    var key = id + ':' + ep;
    if (playCache[key]) return;
    getStreams(id, ep).then(function (st) {
      var src = st.main || st.hevc || st.preview;
      if (src && store.get('hg_line', 'direct') === 'proxy') {
        fetch('/proxy/m3u8?url=' + encodeURIComponent(src)).catch(function () {});
      }
    }).catch(function () {});
  }

  /* ============================== 封面 ============================== */

  function coverSrc(url) {
    if (!url) return '';
    if (url.indexOf('/proxy/img?url=') === 0) return url;
    return '/proxy/img?url=' + encodeURIComponent(url);
  }

  function placeholder(title) {
    var t = esc(String(title || 'HGhub').slice(0, 10));
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='800'>" +
      "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
      "<stop offset='0' stop-color='#2b2b35'/><stop offset='1' stop-color='#141419'/></linearGradient></defs>" +
      "<rect width='600' height='800' fill='url(#g)'/>" +
      "<text x='300' y='390' font-size='44' fill='#ff2d55' text-anchor='middle' font-family='sans-serif'>HGhub</text>" +
      "<text x='300' y='440' font-size='22' fill='#9a9aa3' text-anchor='middle' font-family='sans-serif'>" + t + "</text></svg>";
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /** 三级兜底：/proxy/img 解密图 -> 直连原地址 -> 占位图。 */
  function coverErr(img) {
    if (!img) return;
    if (!img.dataset.fb && img.dataset.raw) {
      img.dataset.fb = '1';
      img.src = img.dataset.raw;
      return;
    }
    if (!img.dataset.fb2) {
      img.dataset.fb2 = '1';
      img.onerror = null;
      img.src = placeholder(img.dataset.title || '');
    }
  }

  function coverImg(url, cls, title, eager) {
    return '<img class="' + (cls || '') + '" alt="" ' +
      'src="' + esc(coverSrc(url)) + '" ' +
      'data-raw="' + esc(url || '') + '" data-title="' + esc(title || '') + '" ' +
      'loading="' + (eager ? 'eager' : 'lazy') + '"' + (eager ? ' fetchpriority="high"' : '') +
      ' decoding="async" referrerpolicy="no-referrer">';
  }

  /* ============================== 视图路由 ============================== */

  function showView(name) {
    if (state.view === name) {
      closeModal();
      if (name === 'home') reactivateCurrentSlide();
      window.scrollTo(0, 0);
      return;
    }
    stopSlides();
    state.view = name;
    document.body.setAttribute('data-view', name);
    $$('#bottomNav button').forEach(function (b) {
      var on = b.getAttribute('data-view') === name;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    ['home', 'cat', 'rank', 'me', 'search'].forEach(function (v) {
      var el = $('#view-' + v);
      if (el) el.hidden = v !== name;
    });

    closeModal();

    /* 回到首页：closeModal 会把 feed 当前那条重新激活（接着播） */
    if (name === 'home') { if (!feed.booted) { feed.booted = true; resetFeed(); } }
    else if (name === 'cat') loadCats();
    else if (name === 'rank') loadRank('hot');
    else if (name === 'me') renderMe();
    else if (name === 'search') loadHotTags();

    window.scrollTo(0, 0);
    if (name === 'home') reactivateCurrentSlide(); /* 从别的页回来接着播当前那条 */
  }

  function goHome() {
    closeSheets();
    showView('home');
    var box = $('#feed');
    if (box) box.scrollTo({ top: 0, behavior: 'smooth' });
    window.scrollTo(0, 0);
  }

  /* ============================== 竖屏 feed ============================== */

  function slideHtml(v, i) {
    var id = vidOf(v);
    var fav = isFav(id);
    var collectN = +v.collect_count || 0;
    var favN = collectOf(v) + (fav ? 1 : 0);
    var cmtN = +v.comment_count || 0;
    var eps = v.episode_count || v.total_episodes || '';
    var eager = i < 3;

    return '<div class="slide" data-id="' + id + '" data-i="' + i + '">' +
      coverImg(v.cover, 'cover', v.title, eager) +
      '<video class="bgvid" muted playsinline preload="none" aria-hidden="true"></video>' +
      '<div class="shade"></div>' +
      '<div class="centerflash"></div>' +
      '<button class="mutebtn" type="button" data-mute aria-label="静音切换">' + ic('volx') + '</button>' +
      '<div class="sfooter">' +
        '<div class="info">' +
          '<h3><button type="button" class="titlebtn" data-detail="' + id + '">' + esc(v.title || '') + '</button></h3>' +
          '<p class="syn" data-syn="' + id + '">' + esc(v.description || '') + '</p>' +
          '<div class="meta">' +
            '<span>' + esc((v.author && v.author.name) || '') + '</span>' +
            (eps ? '<span>· ' + esc(eps) + '集</span>' : '') +
            '<span>· ' + ic('star') + ' ' + fmtN(collectN) + '</span>' +
          '</div>' +
          (eps ? '<button type="button" class="watchall" data-detail="' + id + '">▶ 看全集 · ' + esc(eps) + '集</button>' : '') +
        '</div>' +
        '<div class="acts">' +
          '<div class="act"><button type="button" data-comment="' + id + '" aria-label="评论">' + ic('comment') + '</button><span>' + fmtN(cmtN) + '</span></div>' +
          '<div class="act"><button type="button" data-fav="' + id + '" aria-label="收藏" aria-pressed="' + fav + '" class="' + (fav ? 'faved' : '') + '">' + ic('star', fav) + '</button><span data-favcount="' + id + '">' + fmtN(favN) + '</span></div>' +
          '<div class="act"><button type="button" data-share="' + id + '" aria-label="分享">' + ic('share') + '</button></div>' +
        '</div>' +
      '</div>' +
      '<div class="prog"><div class="progfill"></div></div>' +
    '</div>';
  }

  function resetFeed() {
    var box = $('#feed');
    if (!box) return;
    feed.gen++;
    feed.items = [];
    feed.page = 0;
    feed.pages = 1;
    feed.total = 0;
    feed.loading = false;
    feed.done = false;
    feed.retries = 0;
    state.slideId = 0;
    destroyAllSlides();
    if (slideObserver) { slideObserver.disconnect(); slideObserver = null; }
    box.innerHTML = '<div class="empty">加载中…</div>';
    box.scrollTop = 0;
    loadFeedPage(feed.gen, true);
  }

  function loadFeedPage(gen, first) {
    if (gen !== feed.gen || feed.loading || feed.done) return;
    feed.loading = true;
    var box = $('#feed');
    var page = feed.page + 1;

    api('/api/videos?page=' + page).then(function (j) {
      if (gen !== feed.gen) return;
      var items = itemsOf(j);
      var pg = pagOf(j);

      feed.page = pg.page || page;
      feed.pages = pg.pages || 1;
      feed.total = pg.total || feed.total;
      feed.retries = 0;

      var rb = box.querySelector('.feedretry');
      if (rb) rb.remove();
      var endEl = box.querySelector('.feedend');
      if (endEl) endEl.remove();

      if (first) box.innerHTML = '';

      var start = feed.items.length;
      var added = dedupe(feed.items, items);
      if (added.length) {
        box.insertAdjacentHTML('beforeend', added.map(function (v, k) { return slideHtml(v, start + k); }).join(''));
        wireSlides(box);
      }

      if (first && !feed.items.length) {
        box.innerHTML = '<div class="empty">暂无内容，请稍后重试</div>';
        feed.done = true;
        return;
      }

      if (first) {
        ensureSlideObserver(box);
        var firstSlide = box.querySelector('.slide');
        if (firstSlide) setActiveSlide(firstSlide);
        feed.items.slice(0, 3).forEach(function (v) { preload(vidOf(v), 1); });
      } else if (!items.length) {
        feed.done = true;
      }

      if (feed.page >= feed.pages && !feed.done) {
        feed.done = true;
        box.insertAdjacentHTML('beforeend', '<div class="feedend">已加载全部 ' + (feed.total || feed.items.length) + ' 部</div>');
      }
    }).catch(function (err) {
      if (gen !== feed.gen) return;
      feed.retries++;
      var msg = (err && err.message) || '网络错误';
      if (first) {
        box.innerHTML = '<div class="empty">加载失败：' + esc(msg) +
          '<br><br><button class="btn" type="button" data-retry-feed>点击重试</button></div>';
        return;
      }
      if (feed.retries <= 2) {
        toast('加载更多失败，正在重试…');
        setTimeout(function () { loadFeedPage(gen, false); }, 3000);
      } else if (!box.querySelector('.feedretry')) {
        box.insertAdjacentHTML('beforeend', '<div class="feedretry" data-retry-feed>加载失败，点击重试</div>');
      }
    }).then(function () {
      /* 只有当前这一代请求才允许清 loading：被 resetFeed 换代后，旧请求回来
         不能把新请求的 loading 提前置 false，否则会并发拉同一页。 */
      if (gen === feed.gen) feed.loading = false;
    });
  }

  function dedupe(target, items) {
    var seen = Object.create(null);
    target.forEach(function (v) { seen[vidOf(v)] = 1; });
    var added = [];
    items.forEach(function (v) {
      var id = vidOf(v);
      if (!id || seen[id]) return;
      seen[id] = 1;
      target.push(v);
      added.push(v);
    });
    return added;
  }

  function ensureSlideObserver(box) {
    if (slideObserver) return;
    if (!('IntersectionObserver' in window)) return;
    slideObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        setActiveSlide(en.target);
      });
    }, { root: box, threshold: 0.6 });
    $$('.slide', box).forEach(observeSlide);
  }

  function observeSlide(el) {
    if (!slideObserver || el.dataset.observed) return;
    el.dataset.observed = '1';
    slideObserver.observe(el);
  }

  function wireSlides(box) {
    $$('.slide', box).forEach(function (el) {
      if (!el.dataset.wired) {
        el.dataset.wired = '1';
        var v = el.querySelector('video.bgvid');
        if (v) {
          v.addEventListener('timeupdate', function () {
            if (!v.duration) return;
            var f = el.querySelector('.progfill');
            if (f) f.style.width = Math.min(100, (v.currentTime / v.duration) * 100) + '%';
          });
          v.addEventListener('ended', function () {
            var next = box.querySelector('.slide[data-i="' + (+el.dataset.i + 1) + '"]');
            if (next) next.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        }
      }
      observeSlide(el);
    });
  }

  function setActiveSlide(el) {
    var box = $('#feed');
    $$('.slide', box).forEach(function (s) { s.classList.toggle('active', s === el); });
    activateSlide(el);
    var idx = +el.dataset.i;
    destroyFarSlides(idx);
    var next = feed.items[idx + 1];
    if (next) preload(vidOf(next), 1);
  }

  function activateSlide(el) {
    if (!el) return;
    var id = +el.dataset.id;
    if (!id) return;
    var video = el.querySelector('video.bgvid');
    if (!video) return;
    if (state.slideId === id && video.dataset.ready === '1') return;

    state.slideId = id;
    pauseOtherSlides(id);
    video.muted = store.get('hg_muted', true) !== false;
    clearSlideError(el);
    el.classList.add('waiting');

    /* hls.js 只在需要时才加载（本机文件缺失时会走 CDN 兜底），
       所以起播前先等它就绪，否则会误判成「浏览器不支持 HLS」。 */
    ensureHls().then(function () {
      return getStreams(id, 1);
    }).then(function (st) {
      if (state.slideId !== id) return;
      el.classList.remove('waiting');
      attachSlide(el, id, pickStream(st));
    }).catch(function (err) {
      if (state.slideId !== id) return;
      el.classList.remove('waiting');
      showSlideError(el, (err && err.message) || '加载失败');
    });
  }
  function pickStream(st) {
    if (!st) return '';
    return st.main || st.hevc || st.preview || '';
  }

  function attachSlide(el, id, src) {
    if (!src) { showSlideError(el, '该集暂无播放源'); return; }
    var video = el.querySelector('video.bgvid');
    if (!video) return;

    if (slideHls[id]) {
      try { slideHls[id].destroy(); } catch (e) {}
      delete slideHls[id];
    }

    var line = store.get('hg_line', 'direct');
    var url = line === 'proxy' ? '/proxy/m3u8?url=' + encodeURIComponent(src) : src;
    video.dataset.ready = '1';

    if (window.Hls && window.Hls.isSupported()) {
      var hls = new window.Hls({ maxBufferLength: 20, capLevelToPlayerSize: true });
      slideHls[id] = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, function (evt, data) {
        if (!data || !data.fatal) return;
        try { hls.destroy(); } catch (e) {}
        delete slideHls[id];
        // 直连失败 -> 永久切到代理线路再试一次；代理也失败才报错
        if (store.get('hg_line', 'direct') === 'direct') {
          store.set('hg_line', 'proxy');
          if (state.slideId === id) attachSlide(el, id, src);
        } else {
          showSlideError(el, '播放失败');
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
    } else {
      showSlideError(el, '当前浏览器不支持 HLS');
      return;
    }

    var p = video.play();
    if (p && p.catch) p.catch(function () { /* 自动播放被拦截：等用户点一下 */ });
  }

  function pauseOtherSlides(exceptId) {
    $$('#feed .slide').forEach(function (s) {
      if (+s.dataset.id === exceptId) return;
      var v = s.querySelector('video.bgvid');
      if (v && !v.paused) { try { v.pause(); } catch (e) {} }
    });
  }

  function destroyFarSlides(keepIdx) {
    $$('#feed .slide').forEach(function (s) {
      if (Math.abs(+s.dataset.i - keepIdx) <= 2) return;
      var id = +s.dataset.id;
      var v = s.querySelector('video.bgvid');
      if (v) {
        try { v.pause(); } catch (e) {}
        v.removeAttribute('src');
        try { v.load(); } catch (e) {}
        delete v.dataset.ready;
      }
      if (slideHls[id]) {
        try { slideHls[id].destroy(); } catch (e) {}
        delete slideHls[id];
      }
    });
  }

  function destroyAllSlides() {
    Object.keys(slideHls).forEach(function (id) {
      try { slideHls[id].destroy(); } catch (e) {}
      delete slideHls[id];
    });
    $$('#feed .slide video.bgvid').forEach(function (v) {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
    });
  }

  function stopSlides() {
    state.slideId = 0;
    pauseOtherSlides(0);
  }

  function showSlideError(el, msg) {
    clearSlideError(el);
    var div = document.createElement('div');
    div.className = 'slideerr';
    div.innerHTML = '<div>' + esc(msg || '加载失败') + '</div><button type="button" data-retry-slide>点击重试</button>';
    el.appendChild(div);
    var v = el.querySelector('video.bgvid');
    if (v) delete v.dataset.ready;
  }

  function clearSlideError(el) {
    var box = el.querySelector('.slideerr');
    if (box) box.remove();
  }

  function toggleSlidePlay(el) {
    var v = el.querySelector('video.bgvid');
    if (!v) return;
    if (!v.currentSrc && !v.getAttribute('src')) { state.slideId = 0; activateSlide(el); return; }
    if (v.paused) {
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
      // 首次点击画面 = 用户手势，顺手开声音（浏览器只在手势里允许有声播放）
      if (store.get('hg_muted', true)) { store.set('hg_muted', false); v.muted = false; updateMuteBtns(); }
      flash(el, '▶');
    } else {
      v.pause();
      flash(el, '❚❚');
    }
  }

  function flash(el, text) {
    var f = el.querySelector('.centerflash');
    if (!f) return;
    f.textContent = text;
    f.classList.remove('flashshow');
    void f.offsetWidth;
    f.classList.add('flashshow');
  }

  function popHeart(el) {
    var h = document.createElement('div');
    h.className = 'heartpop';
    h.textContent = '♥';
    el.appendChild(h);
    setTimeout(function () { h.remove(); }, 800);
  }

  function toggleMute() {
    var muted = !store.get('hg_muted', true);
    store.set('hg_muted', muted);
    var cur = document.querySelector('#feed .slide.active video.bgvid');
    if (cur) cur.muted = muted;
    updateMuteBtns();
    toast(muted ? '已静音' : '声音已开');
  }

  function updateMuteBtns() {
    var muted = store.get('hg_muted', true) !== false;
    $$('[data-mute]').forEach(function (b) { b.innerHTML = ic(muted ? 'volx' : 'vol'); });
  }

  /* ============================== 播放进度 / 收藏 ============================== */

  function getProgress(id) {
    var all = store.get('hg_progress', {});
    return all[id] || null;
  }

  var lastProgressSave = 0;
  function saveProgress(force) {
    var now = Date.now();
    if (!force && now - lastProgressSave < 4000) return;
    var v = $('#video');
    if (!v || !state.videoId) return;
    if (!v.duration || v.currentTime < 10) return;
    lastProgressSave = now;
    var all = store.get('hg_progress', {});
    all[state.videoId] = {
      ep: state.ep,
      t: Math.floor(v.currentTime),
      dur: Math.floor(v.duration),
      at: now
    };
    store.set('hg_progress', all);
  }

  function getWatched(id) {
    var w = store.get('hg_watched', {});
    return w[id] || [];
  }

  function markWatched(id, ep) {
    var w = store.get('hg_watched', {});
    var list = w[id] || [];
    if (list.indexOf(ep) === -1) {
      list.push(ep);
      list.sort(function (a, b) { return a - b; });
      w[id] = list;
      store.set('hg_watched', w);
    }
  }

  function addHistory(v, ep) {
    if (!v) return;
    var id = vidOf(v);
    if (!id) return;
    var h = store.get('hg_history', []).filter(function (x) { return +x.id !== id; });
    h.unshift({ id: id, title: v.title || '', cover: v.cover || '', ep: ep || 1, at: Date.now() });
    store.set('hg_history', h.slice(0, 50));
  }

  function isFav(id) {
    id = +id;
    return favs().some(function (x) { return +x.id === id; });
  }

  function collectOf(v) {
    if (!v) return 0;
    if (state.detail && vidOf(state.detail) === vidOf(v)) {
      return +(((state.detail.counts || {}).collect) || state.detail.collect_count || 0);
    }
    return +(((v.counts || {}).collect) || v.collect_count || 0);
  }

  function toggleFav(v) {
    if (!v) return;
    var id = vidOf(v);
    if (!id) return;
    var list = favs().slice();
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (+list[i].id === id) { idx = i; break; }

    if (idx >= 0) {
      list.splice(idx, 1);
      toast('已取消收藏');
    } else {
      list.unshift({ id: id, title: v.title || '', cover: v.cover || '' });
      toast('已收藏');
    }
    _favs = list;
    store.set('hg_fav', list);
    syncFavUI(id);
    if (state.view === 'me') renderMe();
  }

  function syncFavUI(id) {
    var on = isFav(id);
    $$('[data-fav="' + id + '"]').forEach(function (b) {
      b.classList.toggle('faved', on);
      b.setAttribute('aria-pressed', String(on));
      b.innerHTML = ic('star', on);
    });
    var base = collectOf(findVideo(id));
    $$('[data-favcount="' + id + '"]').forEach(function (s) {
      s.textContent = fmtN(base + (on ? 1 : 0));
    });
    var railFav = $('#dRailFav');
    if (railFav && railFav.dataset.vid === String(id)) {
      railFav.classList.toggle('faved', on);
      railFav.innerHTML = ic('star', on);
      railFav.setAttribute('aria-pressed', String(on));
    }
    if (state.videoId === +id) updateFavButtons();
  }

  function updateFavButtons() {
    var on = isFav(state.videoId);
    var texts = [$('#btnDFavText'), $('#btnFavText')];
    texts.forEach(function (t) { if (t) t.textContent = on ? '已收藏' : '收藏'; });
    [$('#btnDFav'), $('#btnFav')].forEach(function (b) { if (b) b.classList.toggle('faved', on); });
  }

  function isLiked(id) { return !!likes()[id]; }

  function setLiked(id, on) {
    var map = likes();
    if (on) map[id] = 1; else delete map[id];
    _likes = map;
    store.set('hg_likes', map);
  }

  function findVideo(id) {
    id = +id;
    var all = feed.items.concat(catItems, searchItems);
    for (var i = 0; i < all.length; i++) if (vidOf(all[i]) === id) return all[i];
    if (state.detail && vidOf(state.detail) === id) return state.detail;
    var fav = favs().filter(function (x) { return +x.id === id; })[0];
    if (fav) return fav;
    return { id: id, title: '', cover: '' };
  }

  /* ============================== 弹窗 / 面板 ============================== */

  var navPushed = false, navSuppress = false, lastFocus = null;

  function buildModalUrl() {
    var q = '?v=' + state.videoId + (state.ep > 1 ? '&ep=' + state.ep : '');
    return location.pathname + q;
  }

  function pushModalState() {
    if (navPushed) return;
    navPushed = true;
    try { history.pushState({ hgModal: 1 }, '', buildModalUrl()); } catch (e) {}
  }

  function popModalState() {
    if (!navPushed) return;
    navPushed = false;
    navSuppress = true;
    try { history.back(); } catch (e) { navSuppress = false; }
    /* history.back() 在某些情况下不会触发 popstate（没有上一条记录），
       定期清掉抑制标志，避免把用户真正的返回操作吃掉。 */
    setTimeout(function () { navSuppress = false; }, 600);
  }

  function syncModalUrl() {
    if (!navPushed) return;
    try { history.replaceState({ hgModal: 1 }, '', buildModalUrl()); } catch (e) {}
  }

  function openModal() {
    lastFocus = document.activeElement;
    $('#player').hidden = false;
    document.body.classList.add('modal-open');
    state.playerOpen = true;
  }

  function closeModal(fromPop) {
    var modal = $('#player');
    if (!modal) return;
    if (modal.hidden) { navPushed = false; return; }

    destroyPlayer();
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    state.playerOpen = false;
    state.streams = null;

    if (state.view === 'home' && feed.items.length) reactivateCurrentSlide();

    if (fromPop) navPushed = false;
    else popModalState();

    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  function reactivateCurrentSlide() {
    var box = $('#feed');
    if (!box) return;
    var idx = Math.round(box.scrollTop / Math.max(1, box.clientHeight));
    var el = box.querySelector('.slide[data-i="' + idx + '"]');
    if (!el) return;

    /* 已经在播就直接返回，避免重复 destroy/recreate hls */
    var v = el.querySelector('video.bgvid');
    if (state.slideId === +el.dataset.id && v && v.dataset.ready === '1') {
      if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      return;
    }

    state.slideId = 0;
    setActiveSlide(el);
  }

  function showDetailPane() {
    $('#detailPane').hidden = false;
    $('#playerPane').hidden = true;
    destroyPlayer();
  }

  function showPlayerPane() {
    $('#detailPane').hidden = true;
    $('#playerPane').hidden = false;
  }

  function destroyPlayer() {
    if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
    var v = $('#video');
    if (!v) return;
    try { v.pause(); } catch (e) {}
    v.removeAttribute('src');
    try { v.load(); } catch (e) {}
  }

  function openSheet(which) {
    if (which === 'comment') {
      $('#shareSheet').hidden = true;
      $('#commentSheet').hidden = false;
    } else {
      $('#commentSheet').hidden = true;
      $('#shareSheet').hidden = false;
    }
  }

  function closeSheets() {
    $('#commentSheet').hidden = true;
    $('#shareSheet').hidden = true;
  }

  /* ============================== 详情 ============================== */

  function setDetailLoading() {
    $('#pTitle').textContent = '加载中…';
    $('#pMeta').textContent = '';
    $('#pDesc').textContent = '';
    $('#pDesc').classList.add('clamped');
    $('#btnMoreDesc').textContent = '展开介绍';
    $('#dStats').innerHTML = '';
    $('#dTags').innerHTML = '';
    $('#pEps').innerHTML = '';
    $('#dEpRanges').innerHTML = '';
    $('#dEpTotal').textContent = '';
    $('#btnPlayDetail').textContent = '▶ 看全集';
    var img = $('#dCoverImg');
    img.removeAttribute('src');
    img.dataset.raw = '';
    img.dataset.title = '';
    delete img.dataset.fb;
    delete img.dataset.fb2;
  }

  function openDetail(id, ep) {
    id = +id || 0;
    if (!id) return Promise.resolve();

    state.videoId = id;
    state.detail = null;
    state.streams = null;
    state.epRange = 0;
    state.ep = +ep || (getProgress(id) || {}).ep || 1;

    stopSlides();
    openModal();
    showDetailPane();
    setDetailLoading();
    pushModalState();

    return api('/api/videos/' + id).then(function (j) {
      var d = j.data || j;
      if (!d || !vidOf(d)) throw new Error('数据为空');
      state.detail = d;

      var total = (d.episodes && d.episodes.length) || (+d.episode_count || 0);
      if (total && state.ep > total) state.ep = 1;

      renderDetail(d);
      renderEpisodes(true);
      syncModalUrl();
      addHistory({ id: id, title: d.title, cover: d.cover }, state.ep);
    }).catch(function (err) {
      $('#pTitle').textContent = '加载失败';
      $('#pMeta').textContent = (err && err.message) || '';
      $('#pEps').innerHTML = '<button class="btn" type="button" data-retry-detail="' + id + '">点击重试</button>';
    });
  }

  function renderDetail(d) {
    var img = $('#dCoverImg');
    delete img.dataset.fb;
    delete img.dataset.fb2;
    img.dataset.raw = d.cover || '';
    img.dataset.title = d.title || '';
    img.alt = '《' + (d.title || '') + '》封面';
    if (d.cover) img.src = coverSrc(d.cover);
    else img.removeAttribute('src');

    $('#pTitle').textContent = d.title || '';

    var cat = (d.breadcrumb && d.breadcrumb[0] && d.breadcrumb[0].name) ||
      (d.tracking && d.tracking.drama_type_name) || '';
    var status = d.is_finished ? '已完结' : '连载中';
    var total = (d.episodes && d.episodes.length) || d.episode_count || d.total_episodes || '';
    var meta = [];
    if ((d.author && d.author.name)) meta.push(d.author.name);
    if (cat) meta.push(cat);
    meta.push(status);
    if (total) meta.push(total + '集');
    $('#pMeta').innerHTML = (d.score ? '<span class="score-badge">' + esc(d.score) + ' 分</span>' : '') + esc(meta.join(' · '));

    var counts = d.counts || {};
    var fav = +counts.collect || +d.collect_count || 0;
    var cmt = +counts.comment || +d.comment_count || 0;
    var hot = +counts.hot || 0;
    $('#dStats').innerHTML =
      '<span>' + ic('star') + ' <b>' + fmtN(fav) + '</b></span>' +
      '<span>' + ic('comment') + ' <b>' + fmtN(cmt) + '</b></span>' +
      (hot ? '<span>热度 <b>' + fmtN(hot) + '</b></span>' : '') +
      (d.duration ? '<span>时长 <b>' + fmtDur(d.duration) + '</b></span>' : '');

    $('#dRailCommentN').textContent = fmtN(cmt);
    var railFavN = $('#dRailFavN');
    railFavN.textContent = fmtN(fav);
    railFavN.dataset.favcount = String(state.videoId);

    var railFav = $('#dRailFav');
    /* 注意用 data-vid 而不是 data-fav：data-fav 会被文档级委托接管，
       这里再绑一次直接监听就会一次点击切两次收藏。 */
    railFav.dataset.vid = String(state.videoId);
    railFav.classList.toggle('faved', isFav(state.videoId));
    railFav.setAttribute('aria-pressed', String(isFav(state.videoId)));
    railFav.innerHTML = ic('star', isFav(state.videoId));

    $('#pDesc').textContent = d.description || d.synopsis || d.title || '';
    $('#pDesc').classList.add('clamped');
    $('#btnMoreDesc').textContent = '展开介绍';

    var tags = d.tags || [];
    $('#dTags').innerHTML = tags.map(function (t) {
      var name = typeof t === 'string' ? t : (t && t.name);
      return name ? '<button type="button" class="chip" data-dtag="' + esc(name) + '">' + esc(name) + '</button>' : '';
    }).join('');

    var progress = getProgress(state.videoId);
    $('#btnPlayDetail').textContent = '▶ 看全集' +
      (progress && progress.ep > 1 ? '（续看第 ' + progress.ep + ' 集）' : '');
  }

  function totalEpisodes() {
    var d = state.detail;
    if (!d) return 0;
    return (d.episodes && d.episodes.length) || +d.episode_count || +d.total_episodes || 0;
  }

  /**
   * @param {boolean} syncRange true 时把分段自动跳到当前集所在区间
   *   （旧版固定从第 1 集开始分段，看到第 150 集打开详情只显示 1-30，且没有一集高亮）
   */
  function renderEpisodes(syncRange) {
    var d = state.detail;
    if (!d) return;

    var eps = d.episodes || [];
    var total = totalEpisodes();
    if (!total) { $('#pEps').innerHTML = '<span class="hint">暂无剧集</span>'; $('#dEpTotal').textContent = ''; return; }

    if (syncRange) state.epRange = Math.floor((Math.max(1, state.ep) - 1) / EP_PAGE) * EP_PAGE;
    if (state.epRange >= total) state.epRange = 0;

    var rangeBox = $('#dEpRanges');
    if (total > EP_PAGE) {
      var html = '';
      for (var st = 0; st < total; st += EP_PAGE) {
        var en = Math.min(total, st + EP_PAGE);
        html += '<button type="button" data-range="' + st + '" class="' + (state.epRange === st ? 'on' : '') + '">' +
          (st + 1) + '-' + en + '集</button>';
      }
      rangeBox.innerHTML = html;
    } else {
      rangeBox.innerHTML = '';
    }

    var watched = getWatched(state.videoId);
    var slice = eps.length ? eps.slice(state.epRange, state.epRange + EP_PAGE) : [];
    if (!slice.length) {
      for (var n = state.epRange + 1; n <= Math.min(total, state.epRange + EP_PAGE); n++) slice.push({ ep_num: n });
    }

    $('#pEps').innerHTML = slice.map(function (e) {
      var num = +e.ep_num || 0;
      if (!num) return '';
      var cls = [];
      if (num === state.ep) cls.push('on');
      if (watched.indexOf(num) !== -1) cls.push('watched');
      return '<button type="button" data-ep="' + num + '" class="' + cls.join(' ') + '">第' + num + '集' +
        (e.duration ? ' · ' + fmtDur(e.duration) : '') + '</button>';
    }).join('') || '<span class="hint">暂无剧集</span>';

    $('#dEpTotal').textContent = '共 ' + total + ' 集' + (d.is_finished ? ' · 已完结' : ' · 连载中');
    updateEpLabel();
  }

  function updateEpLabel() {
    var label = $('#epLabel');
    if (!label) return;
    var total = totalEpisodes();
    var title = (state.detail && state.detail.title) || '';
    label.textContent = title + ' · 第 ' + state.ep + ' 集' + (total ? ' / 共 ' + total + ' 集' : '');

    var prev = $('#btnPrevEp'), next = $('#btnNextEp');
    if (prev) prev.disabled = state.ep <= 1;
    if (next) next.disabled = !!total && state.ep >= total;
  }

  /* ============================== 播放 ============================== */

  function setStatus(text, isError) {
    var el = $('#playerStatus');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; el.classList.remove('err'); return; }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle('err', !!isError);
  }

  function playEpisode(id, ep) {
    id = +id || state.videoId;
    ep = Math.max(1, +ep || 1);
    if (!id) return Promise.resolve();

    var total = totalEpisodes();
    if (total && ep > total) { toast('已经是最后一集了'); return Promise.resolve(); }

    state.videoId = id;
    state.ep = ep;
    state.streams = null;
    showPlayerPane();
    updateEpLabel();
    renderEpisodes(true);
    markWatched(id, ep);
    syncModalUrl();
    setStatus('正在获取播放地址…');

    var video = $('#video');
    video.playbackRate = parseFloat($('#speedSel').value) || 1;

    return ensureHls().then(function () {
      return getStreams(id, ep);
    }).then(function (st) {
      if (state.videoId !== id || state.ep !== ep) return;
      state.streams = st;
      var want = $('#streamSel').value || 'main';
      var src = st[want] || st.main || st.hevc || st.preview;
      if (!src) throw new Error('该集暂无播放源');
      setPlayerSource(src);
      setStatus('');
      var d = state.detail || {};
      addHistory({ id: id, title: d.title, cover: d.cover }, ep);
      preload(id, ep + 1);
      applyResume(video, id, ep);
    }).catch(function (err) {
      if (state.videoId !== id || state.ep !== ep) return;
      setStatus('播放失败：' + ((err && err.message) || err), true);
    });
  }

  function setPlayerSource(src, tried) {
    var v = $('#video');
    if (!v || !src) return;
    var line = store.get('hg_line', 'direct');
    var url = line === 'proxy' ? '/proxy/m3u8?url=' + encodeURIComponent(src) : src;

    if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }

    if (window.Hls && window.Hls.isSupported()) {
      var hls = new window.Hls({ maxBufferLength: 30, capLevelToPlayerSize: true });
      state.hls = hls;
      hls.loadSource(url);
      hls.attachMedia(v);
      hls.on(window.Hls.Events.ERROR, function (evt, data) {
        if (!data || !data.fatal || tried) return;
        var next = line === 'direct' ? 'proxy' : 'direct';
        toast((line === 'direct' ? '直连' : '代理') + '线路失败，切换' + (next === 'direct' ? '直连' : '代理') + '…');
        store.set('hg_line', next);
        setPlayerSource(src, true);
      });
      var p1 = v.play();
      if (p1 && p1.catch) p1.catch(function () {});
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url;
      var p2 = v.play();
      if (p2 && p2.catch) p2.catch(function () {});
      v.addEventListener('error', function onErr() {
        v.removeEventListener('error', onErr);
        if (tried) return;
        store.set('hg_line', line === 'direct' ? 'proxy' : 'direct');
        setPlayerSource(src, true);
      });
    } else {
      v.src = url;
      toast('当前浏览器不支持 HLS 播放');
    }
  }

  function applyResume(video, id, ep) {
    var progress = getProgress(id);
    if (!progress || progress.ep !== ep || !progress.t || !progress.dur) return;
    if (progress.t < 10 || progress.t >= progress.dur - 10) return;

    var seek = function () {
      /* 用户可能已经自己拖过进度，只在还停在前几秒时才自动续播 */
      if (video.currentTime > 3) return;
      try { video.currentTime = progress.t; } catch (e) {}
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener('loadedmetadata', seek, { once: true });
    setTimeout(seek, 1200); /* 兜底：个别浏览器 loadedmetadata 已错过 */
    toast('已续播到 ' + fmtDur(progress.t));
  }

  /* ============================== 评论 ============================== */

  function openComments(id) {
    id = +id || state.videoId;
    if (!id) return;
    openSheet('comment');
    $('#commentTitle').textContent = '评论 · ' + (findVideo(id).title || '');
    $('#commentSheet').dataset.vid = String(id);
    $('#commentInput').value = '';
    loadComments(id);
  }

  function loadComments(id) {
    var box = $('#commentList');
    box.innerHTML = '<div class="empty">加载评论中…</div>';

    api('/api/videos/' + id + '/comments?page=1').then(function (j) {
      var d = (j && j.data) || {};
      return d.items || d.list || [];
    }).catch(function () {
      return [];
    }).then(function (items) {
      var local = store.get('hg_comments_' + id, []);
      var html = '';

      items.forEach(function (c) {
        var name = c.nickname || c.user_name || '网友';
        var text = c.content || c.text || '';
        html += commentHtml(name, c.time || c.created_at || '', text, +c.like_count || 0, false);
      });
      local.forEach(function (c) {
        html += commentHtml(c.name, c.time, c.text, 0, true);
      });

      box.innerHTML = html || '<div class="empty">暂无评论，来发第一条吧</div>';
    });
  }

  function commentHtml(name, time, text, likes, mine) {
    return '<div class="comment">' +
      '<div class="cav">' + esc(String(name || '网').slice(0, 1)) + '</div>' +
      '<div class="cbody"><b>' + esc(name || '网友') + '</b> <span class="cmeta">' + esc(time || '') + '</span>' +
      '<p>' + esc(text || '') + '</p>' +
      '<span class="cmeta">' + (likes || 0) + ' 赞' + (mine ? ' · 仅本地可见' : '') + '</span></div></div>';
  }

  function postComment() {
    var input = $('#commentInput');
    var text = (input.value || '').trim();
    if (!text) { toast('先写点什么'); return; }

    var id = +($('#commentSheet').dataset.vid || 0);
    if (!id) { toast('先选一部剧'); return; }

    var user = store.get('hg_user', null);
    var local = store.get('hg_comments_' + id, []);
    local.unshift({ name: (user && user.name) || '我', time: new Date().toLocaleString(), text: text });
    store.set('hg_comments_' + id, local);
    input.value = '';

    fetch('/api/up/videos/' + id + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text })
    }).then(function (r) {
      toast(r.ok ? '评论已发布' : '已保存到本地（上游未接受）');
    }).catch(function () {
      toast('已保存到本地（网络不可用）');
    }).then(function () {
      loadComments(id);
    });
  }

  /* ============================== 分享 ============================== */

  function openShare(id, ep) {
    id = +id || state.videoId;
    if (!id) return;
    openSheet('share');
    var link = SITE_BASE + '?v=' + id + '&ep=' + (ep || 1);
    $('#shareLink').textContent = link;
    $('#shareTitle').textContent = '分享 · ' + (findVideo(id).title || ('视频 ' + id));
  }

  function shareTo(app) {
    copyText($('#shareLink').textContent);
    toast('链接已复制，打开' + app + '粘贴发送');
  }

  function systemShare() {
    var link = $('#shareLink').textContent;
    if (navigator.share) {
      navigator.share({ title: 'HGhub · 短剧', text: $('#shareTitle').textContent, url: link }).catch(function () {});
    } else {
      copyText(link);
    }
  }

  /* ============================== 分类 ============================== */

  function loadCats() {
    var box = $('#catChips');
    api('/api/site/categories/video').then(function (j) {
      var cats = itemsOf(j);
      var html = '<button type="button" class="chip on" data-cat="">全部</button>';
      cats.forEach(function (c) {
        var name = c.name || c.title || c;
        var id = c.id !== undefined ? c.id : name;
        html += '<button type="button" class="chip" data-cat="' + esc(id) + '">' + esc(name) + '</button>';
      });
      box.innerHTML = html;
    }).catch(function () {
      box.innerHTML = '<span class="hint">分类加载失败，点此重试</span>';
    }).then(function () {
      loadCatVideos('');
    });
  }

  function loadCatVideos(cat) {
    catItems = [];
    catState = { cat: cat || '', page: 0, pages: 1, total: 0, loading: false, done: false, gen: (catState ? catState.gen : 0) + 1 };
    var grid = $('#catGrid');
    grid.innerHTML = '<div class="empty">加载中…</div>';
    $('#catEnd').hidden = true;
    $('#catTotal').textContent = '';
    loadCatNext(catState);
  }

  function loadCatNext(st) {
    st = st || catState;
    if (!st || st !== catState || st.loading || st.done) return;
    st.loading = true;

    var grid = $('#catGrid');
    var page = st.page + 1;
    var path = '/api/videos?page=' + page + (st.cat ? '&cate_id=' + encodeURIComponent(st.cat) : '');

    api(path).then(function (j) {
      if (st !== catState) return;
      var items = itemsOf(j);
      var pg = pagOf(j);

      st.page = pg.page || page;
      st.pages = pg.pages || 1;
      st.total = pg.total || 0;

      var added = dedupe(catItems, items);
      var html = added.map(cardHtml).join('');
      if (page === 1) grid.innerHTML = html || '<div class="empty">该分类暂无内容</div>';
      else if (html) grid.insertAdjacentHTML('beforeend', html);

      if (st.page >= st.pages || !items.length) {
        st.done = true;
        $('#catEnd').hidden = !catItems.length;
      }
      updateTotal($('#catTotal'), catItems.length, st.total);
    }).catch(function (err) {
      if (st !== catState) return;
      if (page === 1) grid.innerHTML = '<div class="empty">加载失败：' + esc((err && err.message) || err) + '</div>';
      else toast('加载下一页失败：' + ((err && err.message) || err));
    }).then(function () {
      st.loading = false;
    });
  }

  /* ============================== 榜单 ============================== */

  function loadRank(type) {
    var gen = ++rankGen;
    var box = $('#rankList');
    box.innerHTML = '<div class="empty">加载中…</div>';

    api('/api/ranks/' + type).then(function (j) {
      if (gen !== rankGen) return;
      var items = itemsOf(j);
      if (!items.length) {
        box.innerHTML = '<div class="empty">' + esc((j && j.msg) || '该榜单暂无数据') + '</div>';
        return;
      }
      box.innerHTML = items.map(function (v, i) {
        var id = vidOf(v);
        var eps = v.episode_count || v.total_episodes || '';
        var metric = v.metric_label && v.metric_value != null
          ? v.metric_label + ' ' + fmtN(v.metric_value)
          : (v.metrics ? '赞 ' + fmtN(v.metrics.like) : '');
        return '<div class="rankrow" data-detail="' + id + '" role="button" tabindex="0">' +
          '<div class="no">' + (i + 1) + '</div>' +
          coverImg(v.cover, '', v.title) +
          '<div><h4>' + esc(v.title || '') + '</h4>' +
          '<p>' + (v.cate_name ? esc(v.cate_name) + ' · ' : '') +
          (metric ? esc(metric) + (eps ? ' · ' : '') : '') +
          (eps ? esc(eps) + '集' : '') + '</p></div></div>';
      }).join('');
    }).catch(function (err) {
      if (gen !== rankGen) return;
      box.innerHTML = '<div class="empty">加载失败：' + esc((err && err.message) || err) + '</div>';
    });
  }

  /* ============================== 搜索 ============================== */

  function doSearch(q) {
    q = (q || '').trim();
    if (!q) { toast('请输入关键词'); return; }

    showView('search');
    searchItems = [];
    searchState = { q: q, page: 0, pages: 1, total: 0, loading: false, done: false, gen: (searchState ? searchState.gen : 0) + 1 };

    var grid = $('#searchGrid');
    grid.innerHTML = '<div class="empty">搜索中…</div>';
    $('#searchEmpty').hidden = true;
    $('#searchEnd').hidden = true;
    $('#searchTotal').textContent = '';
    $('#q').value = q;

    loadSearchNext(searchState);
  }

  function loadSearchNext(st) {
    st = st || searchState;
    if (!st || st !== searchState || st.loading || st.done || !st.q) return;
    st.loading = true;

    var grid = $('#searchGrid');
    var page = st.page + 1;

    api('/api/search?q=' + encodeURIComponent(st.q) + '&page=' + page).then(function (j) {
      if (st !== searchState) return;
      var found = itemsOf(j);
      var pg = pagOf(j);

      st.page = pg.page || page;
      st.pages = pg.pages || 1;
      st.total = pg.total || 0;

      var added = dedupe(searchItems, found);
      var html = added.map(cardHtml).join('');
      if (page === 1) grid.innerHTML = html;
      else if (html) grid.insertAdjacentHTML('beforeend', html);

      if (st.page >= st.pages || !found.length) st.done = true;

      var empty = page === 1 && !found.length;
      $('#searchEmpty').hidden = !empty;
      $('#searchEnd').hidden = !(st.done && searchItems.length > 0);
      updateTotal($('#searchTotal'), searchItems.length, st.total);
    }).catch(function (err) {
      if (st !== searchState) return;
      if (page === 1) {
        grid.innerHTML = '<div class="empty">搜索失败：' + esc((err && err.message) || err) +
          '<br><br><button class="btn" type="button" data-retry-search>点击重试</button></div>';
      } else {
        toast('加载下一页失败：' + ((err && err.message) || err));
      }
    }).then(function () {
      st.loading = false;
    });
  }

  function loadHotTags() {
    var box = $('#hotTags');
    if (box.dataset.loaded) return;
    api('/api/search/hot').then(function (j) {
      var tags = itemsOf(j);
      var names = tags.map(function (t) {
        return typeof t === 'string' ? t : (t.word || t.name || t.keyword || t.tag || '');
      }).filter(function (n) { return !!n; });
      box.innerHTML = names.slice(0, 12).map(function (name) {
        return '<button type="button" class="chip" data-tag="' + esc(name) + '">' + esc(name) + '</button>';
      }).join('');
      box.dataset.loaded = '1';
    }).catch(function () {});
  }

  function updateTotal(el, shown, total) {
    if (!el) return;
    el.textContent = total ? ('共 ' + total + ' 部 · 已加载 ' + shown + ' 部') : ('已加载 ' + shown + ' 部');
  }

  function cardHtml(v) {
    var id = vidOf(v);
    var eps = v.episode_count || v.total_episodes || '';
    var collect = +(((v.counts || {}).collect) || v.collect_count || 0);
    /* 收藏/历史里存的是精简对象（没有集数和收藏数），这里不要渲染出「集 · ★ 0」 */
    var meta = [];
    if (eps) meta.push(esc(eps) + '集');
    if (collect) meta.push(ic('star') + ' ' + fmtN(collect));
    return '<div class="card" data-detail="' + id + '" role="button" tabindex="0">' +
      coverImg(v.cover, '', v.title) +
      '<div class="t"><h4>' + esc(v.title || '') + '</h4>' +
      (meta.length ? '<p>' + meta.join(' · ') + '</p>' : '') +
      '</div></div>';
  }

  /* ============================== 我的 ============================== */

  function renderMe() {
    var box = $('#meBox');
    var user = store.get('hg_user', null);
    var favList = favs();
    var hist = store.get('hg_history', []);
    var line = store.get('hg_line', 'direct');
    var html = '';

    if (!user) {
      html += '<div class="mebox"><h3>登录 / 注册</h3>' +
        '<input id="loginUser" placeholder="用户名" autocomplete="username" aria-label="用户名">' +
        '<input id="loginPass" type="password" placeholder="密码（至少 4 位）" autocomplete="current-password" aria-label="密码">' +
        '<div class="rowbtns"><button class="btn" id="btnLogin" type="button">登录</button>' +
        '<button class="btn ghost" id="btnReg" type="button">注册</button></div>' +
        '<p class="hint">本地账号，只保存在这台设备的浏览器里，不会上传。</p></div>';
    } else {
      html += '<div class="mebox"><h3>你好，' + esc(user.name) + '</h3>' +
        '<div class="rowbtns"><button class="btn ghost" id="btnLogout" type="button">退出登录</button></div></div>';
    }

    html += '<div class="mebox"><h3>我的收藏（' + favList.length + '）</h3>' +
      (favList.length
        ? '<div class="grid">' + favList.map(function (v) { return cardHtml(v); }).join('') + '</div>'
        : '<p class="hint">还没有收藏，在播放页点「收藏」试试。</p>') + '</div>';

    html += '<div class="mebox"><h3>观看历史（' + hist.length + '）</h3>' +
      (hist.length
        ? hist.map(function (h) {
            return '<div class="rankrow" data-detail="' + h.id + '" role="button" tabindex="0">' +
              coverImg(h.cover, '', h.title) +
              '<div><h4>' + esc(h.title || '') + '</h4>' +
              '<p>看到第 ' + (h.ep || 1) + ' 集 · ' + esc(fmtTime(h.at)) + '</p></div></div>';
          }).join('')
        : '<p class="hint">还没有观看记录。</p>') + '</div>';

    html += '<div class="mebox"><h3>设置</h3>' +
      '<label class="hint" for="lineSel">播放线路</label>' +
      '<select id="lineSel">' +
        '<option value="direct"' + (line === 'direct' ? ' selected' : '') + '>线路 1：直连 CDN（默认，最快）</option>' +
        '<option value="proxy"' + (line === 'proxy' ? ' selected' : '') + '>线路 2：本站代理（CDN 被墙时用）</option>' +
      '</select>' +
      '<label class="hint" for="prefIpIsp">优选 IP 运营商</label>' +
      '<select id="prefIpIsp">' +
        ['auto', 'ct', 'cu', 'cmcc'].map(function (k) {
          var label = { auto: '自动', ct: '电信', cu: '联通', cmcc: '移动' }[k];
          return '<option value="' + k + '"' + (store.get('hg_pref_isp', 'auto') === k ? ' selected' : '') + '>' + label + '</option>';
        }).join('') +
      '</select>' +
      '<p class="hint" id="prefIpInfo">优选 IP 加载中…</p>' +
      '<div class="rowbtns"><button class="btn ghost" id="btnCopyPrefIp" type="button">复制优选 IP</button>' +
      '<button class="btn ghost" id="btnRefreshPrefIp" type="button">刷新列表</button></div>' +
      '<p class="hint">列表来自 cf.090227.xyz。网页端仅作展示/复制，App 里才会真正用优选 IP 建连。</p>' +
      '<div class="rowbtns"><button class="btn ghost" id="btnClearHist" type="button">清空观看历史</button>' +
      '<button class="btn ghost" id="btnClearFav" type="button">清空收藏</button></div>' +
      '</div>';

    box.innerHTML = html;

    bindMe();
    loadPrefIp();
  }

  function bindMe() {
    var user = $('#loginUser');
    var pass = $('#loginPass');

    var btnLogin = $('#btnLogin');
    if (btnLogin) btnLogin.onclick = function () {
      var name = (user.value || '').trim();
      var pw = pass.value || '';
      var accounts = store.get('hg_accounts', {});
      if (name && accounts[name] === hashPass(pw)) {
        store.set('hg_user', { name: name });
        toast('登录成功');
        renderMe();
      } else {
        toast('账号或密码不正确');
      }
    };

    var btnReg = $('#btnReg');
    if (btnReg) btnReg.onclick = function () {
      var name = (user.value || '').trim();
      var pw = pass.value || '';
      if (!name) { toast('用户名不能为空'); return; }
      if (pw.length < 4) { toast('密码至少 4 位'); return; }
      var accounts = store.get('hg_accounts', {});
      if (accounts[name]) { toast('该用户名已被注册'); return; }
      accounts[name] = hashPass(pw);
      store.set('hg_accounts', accounts);
      store.set('hg_user', { name: name });
      toast('注册并登录成功');
      renderMe();
    };

    var btnLogout = $('#btnLogout');
    if (btnLogout) btnLogout.onclick = function () { store.set('hg_user', null); toast('已退出'); renderMe(); };

    var lineSel = $('#lineSel');
    if (lineSel) lineSel.onchange = function () {
      store.set('hg_line', lineSel.value);
      toast('已切换为' + lineSel.options[lineSel.selectedIndex].text);
    };

    var isp = $('#prefIpIsp');
    if (isp) isp.onchange = function () {
      store.set('hg_pref_isp', isp.value);
      loadPrefIp(true);
    };

    var copyIp = $('#btnCopyPrefIp');
    if (copyIp) copyIp.onclick = function () { copyText(window.HG_PREFIP || ''); };

    var refreshIp = $('#btnRefreshPrefIp');
    if (refreshIp) refreshIp.onclick = function () { loadPrefIp(true); };

    var clearHist = $('#btnClearHist');
    if (clearHist) clearHist.onclick = function () { store.set('hg_history', []); toast('已清空观看历史'); renderMe(); };

    var clearFav = $('#btnClearFav');
    if (clearFav) clearFav.onclick = function () { _favs = []; store.set('hg_fav', []); toast('已清空收藏'); renderMe(); };
  }

  /**
   * 本地账号口令散列：仅用于避免明文落盘，不是安全边界。
   * 旧版跑一遍 31 进制 hash，这里加盐 + 两轮，聊胜于无。
   */
  function hashPass(pw) {
    var s = 'hg$' + String(pw) + '#hub';
    var h1 = 0, h2 = 5381;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (h1 * 31 + c) >>> 0;
      h2 = ((h2 << 5) + h2 + c) >>> 0;
    }
    return h1.toString(36) + '-' + h2.toString(36);
  }

  function loadPrefIp(force) {
    var info = $('#prefIpInfo');
    var isp = store.get('hg_pref_isp', 'auto');
    fetch('/api/prefip?isp=' + encodeURIComponent(isp), { cache: force ? 'no-store' : 'default' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var d = (j && j.data) || {};
        var ips = d.ips || [];
        window.HG_PREFIP = ips[0] || '';
        window.HG_PREFIP_LIST = ips;
        if (info) {
          info.textContent = ips.length
            ? '当前优选 IP：' + ips[0] + '（' + (d.isp || isp) + '，共 ' + ips.length + ' 个）'
            : '暂无优选 IP，走 Cloudflare 默认节点';
        }
      })
      .catch(function () {
        if (info) info.textContent = '优选 IP 拉取失败，走 Cloudflare 默认节点';
      });
  }

  /* ============================== 事件绑定 ============================== */

  function bindGlobal() {
    /* --- 文档级委托：所有按钮/卡片/标签点击都从这里走，避免重复绑定 --- */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var el;

      if ((el = t.closest('#bottomNav [data-view]'))) { onNavClick(el); return; }

      if ((el = t.closest('[data-retry-feed]'))) { feed.booted = true; resetFeed(); return; }
      if ((el = t.closest('[data-retry-slide]'))) {
        var slide = el.closest('.slide');
        if (slide) { state.slideId = 0; clearSlideError(slide); activateSlide(slide); }
        return;
      }
      if ((el = t.closest('[data-retry-detail]'))) { openDetail(+el.getAttribute('data-retry-detail'), state.ep); return; }
      if ((el = t.closest('[data-retry-search]'))) { if (searchState) loadSearchNext(searchState); return; }

      if ((el = t.closest('[data-detail]'))) { openDetail(+el.getAttribute('data-detail'), 0); return; }
      if ((el = t.closest('[data-fav]'))) { toggleFav(findVideo(+el.getAttribute('data-fav'))); return; }
      if ((el = t.closest('[data-comment]'))) { openComments(+el.getAttribute('data-comment')); return; }
      if ((el = t.closest('[data-share]'))) {
        var sid = +el.getAttribute('data-share');
        var ep = sid === state.videoId ? state.ep : ((getProgress(sid) || {}).ep || 1);
        openShare(sid, ep);
        return;
      }
      if ((el = t.closest('[data-mute]'))) { toggleMute(); return; }

      if ((el = t.closest('#hotTags [data-tag]'))) { doSearch(el.getAttribute('data-tag')); return; }
      if ((el = t.closest('#catChips [data-cat]'))) {
        $$('#catChips .chip').forEach(function (x) { x.classList.remove('on'); });
        el.classList.add('on');
        loadCatVideos(el.getAttribute('data-cat'));
        return;
      }
      if ((el = t.closest('#rankTabs [data-type]'))) {
        $$('#rankTabs .chip').forEach(function (x) { x.classList.remove('on'); });
        el.classList.add('on');
        loadRank(el.getAttribute('data-type'));
        return;
      }
      if ((el = t.closest('[data-ep]'))) { playEpisode(state.videoId, +el.getAttribute('data-ep')); return; }
      if ((el = t.closest('[data-range]'))) {
        state.epRange = +el.getAttribute('data-range');
        renderEpisodes(false);
        return;
      }
      if ((el = t.closest('[data-dtag]'))) {
        var tag = el.getAttribute('data-dtag');
        closeModal();
        $('#q').value = tag;
        doSearch(tag);
        return;
      }
    });

    /* 键盘：卡片/榜单行可回车打开；Esc 逐层关闭 */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!$('#commentSheet').hidden || !$('#shareSheet').hidden) { closeSheets(); return; }
        if (!$('#player').hidden) { closeModal(); return; }
      }
      if (e.key === 'Enter' || e.key === ' ') {
        var t = e.target;
        if (t && t.getAttribute && t.getAttribute('data-detail') && t.getAttribute('role') === 'button') {
          e.preventDefault();
          openDetail(+t.getAttribute('data-detail'), 0);
        }
      }
    });

    /* feed 内点击：单击暂停/继续、双击点赞、进度条跳转 */
    var feedBox = $('#feed');
    feedBox.addEventListener('click', function (e) {
      var slide = e.target.closest('.slide');
      if (!slide) return;

      var prog = e.target.closest('.prog');
      if (prog) {
        var v = slide.querySelector('video.bgvid');
        if (v && v.duration) {
          var rect = prog.getBoundingClientRect();
          v.currentTime = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * v.duration;
        }
        return;
      }

      var syn = e.target.closest('[data-syn]');
      if (syn) { syn.classList.toggle('expanded'); return; }

      if (e.target.closest('.sfooter, .mutebtn, .slideerr')) return;

      var now = Date.now();
      var last = +slide.dataset.lastTap || 0;
      if (now - last < 300) {
        slide.dataset.lastTap = '0';
        clearTimeout(+slide.dataset.tapTimer || 0);
        var id = +slide.dataset.id;
        setLiked(id, true);
        popHeart(slide);
        return;
      }
      slide.dataset.lastTap = String(now);
      var timer = setTimeout(function () { toggleSlidePlay(slide); }, 300);
      slide.dataset.tapTimer = String(timer);
    });

    /* feed 滚动：rAF 节流 + 底部预取下一页 */
    var ticking = false;
    feedBox.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var box = $('#feed');
        if (!box || feed.done || feed.loading) return;
        if (box.scrollTop + box.clientHeight >= box.scrollHeight - box.clientHeight) {
          loadFeedPage(feed.gen, false);
        }
      });
    }, { passive: true });

    /* 分类/搜索页是整页滚动 */
    window.addEventListener('scroll', function () {
      if (window.innerHeight + window.scrollY < document.body.scrollHeight - 800) return;
      if (!$('#view-cat').hidden) loadCatNext(catState);
      else if (!$('#view-search').hidden) loadSearchNext(searchState);
    }, { passive: true });

    /* 搜索 */
    $('#searchForm').addEventListener('submit', function (e) {
      e.preventDefault();
      doSearch($('#q').value);
    });

    $('#btnHome').addEventListener('click', goHome);
    $('#btnClosePlayer').addEventListener('click', function () { closeModal(); });
    $('#btnBackFeed').addEventListener('click', function () { closeModal(); });
    $('#btnBackDetail').addEventListener('click', function () { showDetailPane(); });

    $('#btnPlayDetail').addEventListener('click', function () {
      if (state.videoId) playEpisode(state.videoId, state.ep || 1);
    });
    $('#dCover').addEventListener('click', function (e) {
      if (e.target.closest('.detail-rail')) return; /* 右侧操作栏自己有点击逻辑，别顺带播起来 */
      if (state.videoId) playEpisode(state.videoId, state.ep || 1);
    });

    $('#btnMoreDesc').addEventListener('click', function () {
      var d = $('#pDesc');
      var clamped = d.classList.toggle('clamped');
      this.textContent = clamped ? '展开介绍' : '收起介绍';
    });

    $('#dRailFav').addEventListener('click', function () { if (state.videoId) toggleFav(findVideo(state.videoId)); });
    $('#dRailShare').addEventListener('click', function () { if (state.videoId) openShare(state.videoId, state.ep); });
    $('#dRailComment').addEventListener('click', function () { if (state.videoId) openComments(state.videoId); });

    $('#btnDFav').addEventListener('click', function () { if (state.videoId) toggleFav(findVideo(state.videoId)); });
    $('#btnDShare').addEventListener('click', function () { if (state.videoId) openShare(state.videoId, state.ep); });
    $('#btnDComment').addEventListener('click', function () { if (state.videoId) openComments(state.videoId); });

    $('#btnFav').addEventListener('click', function () { if (state.videoId) toggleFav(findVideo(state.videoId)); });
    $('#btnShare').addEventListener('click', function () { if (state.videoId) openShare(state.videoId, state.ep); });

    $('#speedSel').addEventListener('change', function () {
      var v = $('#video');
      if (v) v.playbackRate = parseFloat(this.value) || 1;
    });
    $('#streamSel').addEventListener('change', function () {
      if (!state.streams) return;
      var want = this.value;
      var src = state.streams[want] || state.streams.main;
      if (src) setPlayerSource(src);
    });

    $('#btnPrevEp').addEventListener('click', function () { if (state.videoId && state.ep > 1) playEpisode(state.videoId, state.ep - 1); });
    $('#btnNextEp').addEventListener('click', function () { if (state.videoId) playEpisode(state.videoId, state.ep + 1); });

    var player = $('#video');
    player.addEventListener('timeupdate', function () { saveProgress(false); });
    player.addEventListener('pause', function () { saveProgress(true); });
    player.addEventListener('ended', function () {
      if (!state.videoId) return;
      var total = totalEpisodes();
      if (!total || state.ep < total) playEpisode(state.videoId, state.ep + 1);
    });

    $('#btnCloseComments').addEventListener('click', closeSheets);
    $('#btnCloseShare').addEventListener('click', closeSheets);
    $('#btnSendComment').addEventListener('click', postComment);
    $('#commentInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); postComment(); }
    });

    $('#btnCopyLink').addEventListener('click', function () { copyText($('#shareLink').textContent); });
    $('#btnShareWechat').addEventListener('click', function () { shareTo('微信'); });
    $('#btnShareQQ').addEventListener('click', function () { shareTo('QQ'); });
    $('#btnSysShare').addEventListener('click', systemShare);
    $('#btnDownloadApp').addEventListener('click', function () { location.href = APK_URL; });

    $('#dCoverImg').addEventListener('error', function () { coverErr(this); });

    /* 资源加载失败不冒泡，只能靠捕获阶段统一兜底（原来靠行内 onerror） */
    document.addEventListener('error', function (e) {
      var t = e.target;
      if (t && t.tagName === 'IMG' && t.hasAttribute('data-raw')) coverErr(t);
    }, true);

    /* 浏览器返回键：先关弹窗，而不是直接退出站点 */
    window.addEventListener('popstate', function () {
      if (navSuppress) { navSuppress = false; return; }
      if (!$('#player').hidden) closeModal(true);
    });

    window.addEventListener('pagehide', function () { saveProgress(true); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) saveProgress(true); });
  }

  /* 底部导航：唯一的入口。旧版内联 onclick + 监听器 + 文档委托三处绑定，
     同一次点击会触发 3 次 showView/loadCats，后到的空结果把列表刷掉。 */
  function onNavClick(btn) {
    var name = btn.getAttribute('data-view');
    if (name === 'search') { $('#q').focus(); return; }
    showView(name);
  }

  /* ============================== 启动 ============================== */

  function ensureHls() {
    if (window.Hls) return Promise.resolve();
    if (ensureHls.promise) return ensureHls.promise;
    ensureHls.promise = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = HLS_CDN;
      s.async = true;
      s.onload = resolve;
      s.onerror = resolve;
      document.head.appendChild(s);
    });
    return ensureHls.promise;
  }

  function handleDeepLink() {
    var params = new URLSearchParams(location.search);
    var q = params.get('q');
    if (q) { $('#q').value = q; doSearch(q); return; }

    var id = parseInt(params.get('v'), 10);
    if (!id) return;
    var ep = Math.max(1, parseInt(params.get('ep'), 10) || 1);

    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (!feed.items.length && tries <= 20) return;
      clearInterval(timer);
      openDetail(id, ep).then(function () {
        /* 分享链接直达：ep>=1 都直接开播（旧版 ep=1 只停在详情页，和文案不一致） */
        if (state.detail) playEpisode(id, ep);
      });
    }, 400);
  }

  function init() {
    var footer = $('#appFooter');
    if (footer) footer.textContent = 'HGhub · 短剧 · 复刻版 ' + APP_VERSION + ' · 竖屏自动播放 · 无限滚动 · 每 10 分钟检查更新';

    document.body.setAttribute('data-view', 'home');
    $$('#bottomNav button').forEach(function (b) {
      var on = b.getAttribute('data-view') === 'home';
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });

    bindGlobal();
    updateMuteBtns();

    /* 先挂全局对象再渲染：图片的 error 兜底依赖 window.HG */
    window.HG = {
      coverErr: coverErr,
      version: APP_VERSION,
      openDetail: openDetail,
      play: playEpisode,
      state: state
    };

    ensureHls();

    feed.booted = true;
    resetFeed();
    loadHotTags();
    startAutoRefresh();
    handleDeepLink();
  }

  /* ============================== 自动更新提示 ============================== */

  var refreshTimer = null;

  function saveKnownIds(ids, total) {
    store.set('hg_known_ids', ids.slice(0, 60));
    store.set('hg_known_total', total);
  }

  function checkUpdates(silent) {
    return api('/api/videos?page=1').then(function (j) {
      var items = itemsOf(j);
      var pg = pagOf(j);
      var knownIds = store.get('hg_known_ids', []);
      var knownTotal = store.get('hg_known_total', 0);

      if (!knownIds.length) { saveKnownIds(items.map(vidOf), pg.total); return 0; }

      var old = Object.create(null);
      knownIds.forEach(function (id) { old[id] = 1; });
      var fresh = items.filter(function (v) { return !old[vidOf(v)]; }).length;
      var diff = Math.max(0, pg.total - (knownTotal || pg.total));
      var count = Math.max(fresh, diff);

      saveKnownIds(items.map(vidOf), pg.total);
      if (!count) return 0;

      var banner = $('#newBanner');
      if (banner) {
        banner.textContent = '有 ' + count + ' 部新更新，点击查看';
        banner.hidden = false;
        banner.onclick = function () { banner.hidden = true; resetFeed(); window.scrollTo(0, 0); };
      }
      if (!silent) toast('发现 ' + count + ' 部新更新');
      return count;
    }).catch(function () { return 0; });
  }

  function startAutoRefresh() {
    if (refreshTimer) return;
    checkUpdates(true);
    refreshTimer = setInterval(function () { checkUpdates(true); }, 10 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
