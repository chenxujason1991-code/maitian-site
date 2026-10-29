/* =========================================================
   麦田 · 阅读空间同步层
   ---------------------------------------------------------
   职责：把 pad 上发的记录、回应，存到 Supabase；网站从同一处读。
   两件事写死在这里，避免 pad 端和网站端各写一套而漂移。

   设计原则：连不上就当没有云。所有函数失败都返回 null，
   调用方降级到本地，界面上不报错、不弹窗。

   表：space_posts / space_replies（SQL 见 space-schema.sql）
   ========================================================= */
(function (global) {
  'use strict';

  var CFG = {
    url: 'https://gqzyxxwhnzmqthvmehzt.supabase.co',
    key: 'sb_publishable_P_TEaz0kOHld9rATH13VyA_W2RXUBc_',
    bucket: 'images',
    timeout: 7000
  };

  var REST = CFG.url + '/rest/v1/';
  var STORAGE = CFG.url + '/storage/v1';

  /* ---------- 有哪些空间 ----------
     加一个新学校，就在这里加一行，pad 和网站两边都会跟着变。
     key  ：写进数据库的短名，也是署名的前缀（「小田的读者」）
     full ：网站上显示的全名
  ------------------------------------- */
  var SPACES = [
    { key: '小田',   full: '滑县大寨乡小田小学' },
    { key: '西胡垌', full: '西胡垌小学' }
  ];

  function spaceFull(key) {
    if (!key) return '';
    for (var i = 0; i < SPACES.length; i++) {
      if (SPACES[i].key === key) return SPACES[i].full;
    }
    return key;   // 不在清单里的（比如早期数据）原样显示，不硬套
  }

  function headers(extra) {
    var h = {
      'apikey': CFG.key,
      'Authorization': 'Bearer ' + CFG.key,
      'Content-Type': 'application/json'
    };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  /* 带超时的 fetch —— 网络差的时候不能把页面卡住 */
  function req(path, opt) {
    opt = opt || {};
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, CFG.timeout);
    return fetch(REST + path, {
      method: opt.method || 'GET',
      headers: headers(opt.headers),
      body: opt.body,
      signal: ctrl.signal
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error(r.status + ' ' + String(t).slice(0, 180));
        });
      }
      var ct = r.headers.get('content-type') || '';
      if (ct.indexOf('json') < 0) return null;
      var text = r.text();
      return text.then(function (s) { return s ? JSON.parse(s) : null; });
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  /* ---------- 图片：压缩后的 dataURL → 公开链接 ---------- */
  function dataUrlToBlob(dataUrl) {
    var parts = String(dataUrl).split(',');
    if (parts.length < 2) return null;
    var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    var bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return { blob: new Blob([arr], { type: mime }), mime: mime };
  }

  function uploadOne(dataUrl) {
    if (!dataUrl || dataUrl.indexOf('data:') !== 0) {
      // 已经是链接，直接用
      return Promise.resolve(dataUrl && dataUrl.indexOf('http') === 0 ? dataUrl : null);
    }
    var o = dataUrlToBlob(dataUrl);
    if (!o) return Promise.resolve(null);

    var ext = o.mime === 'image/png' ? 'png' : 'jpg';
    var name = 'space/' + Date.now() + '-' +
               Math.random().toString(36).slice(2, 10) + '.' + ext;

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 20000);

    return fetch(STORAGE + '/object/' + CFG.bucket + '/' + name, {
      method: 'POST',
      headers: {
        'apikey': CFG.key,
        'Authorization': 'Bearer ' + CFG.key,
        'Content-Type': o.mime,
        'x-upsert': 'true'
      },
      body: o.blob,
      signal: ctrl.signal
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('storage ' + r.status);
      return STORAGE + '/object/public/' + CFG.bucket + '/' + name;
    }).catch(function () {
      clearTimeout(timer);
      return null;
    });
  }

  function uploadAll(list) {
    list = list || [];
    return Promise.all(list.map(uploadOne)).then(function (urls) {
      // 任何一张没传上去，整条都不要发到云端——
      // 半截图片发出去，比发不出去更糟
      for (var i = 0; i < urls.length; i++) if (!urls[i]) return null;
      return urls;
    });
  }

  /* ---------- 行 → 前端格式 ---------- */
  function toPost(row) {
    return {
      id: row.id,
      space: row.space || '小田阅读空间',
      text: row.body || '',
      images: Array.isArray(row.images) ? row.images : [],
      signLabel: row.sign_label || '',
      person: row.person || '',
      time: row.created_at || new Date().toISOString(),
      replies: []
    };
  }

  function toReply(row) {
    return {
      id: row.id,
      postId: row.post_id,
      author: row.author || '空间里的人',
      text: row.body || '',
      time: row.created_at,
      from: row.from_outside ? 'outside' : 'inside'
    };
  }

  /* ---------- 对外 ---------- */
  var MTSpace = {

    /* 探活：能不能连上、表在不在。不做任何写入。 */
    ping: function () {
      return req('space_posts?select=id&limit=1')
        .then(function () { return true; })
        .catch(function () { return false; });
    },

    /* 拉最近的记录 + 回应 */
    list: function (limit) {
      var n = limit || 30;
      return req('space_posts?select=*&hidden=eq.false&order=created_at.desc&limit=' + n)
        .then(function (rows) {
          if (!rows) return [];
          var posts = rows.map(toPost);
          if (!posts.length) return posts;

          var ids = posts.map(function (p) { return p.id; }).join(',');
          return req('space_replies?select=*&post_id=in.(' + ids + ')&order=created_at.asc')
            .then(function (rs) {
              var byPost = {};
              (rs || []).forEach(function (r) {
                var rp = toReply(r);
                (byPost[rp.postId] = byPost[rp.postId] || []).push(rp);
              });
              posts.forEach(function (p) { p.replies = byPost[p.id] || []; });
              return posts;
            })
            .catch(function () { return posts; }); // 回应单独失败不影响主列表
        });
    },

    /* 发一条。成功返回云端行（含真实 id），失败返回 null。 */
    publish: function (post) {
      return uploadAll(post.images).then(function (urls) {
        if (urls === null) return null;   // 图没传全，不发
        return req('space_posts', {
          method: 'POST',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify([{
            space: post.space || '小田阅读空间',
            body: post.text || '',
            images: urls,
            sign_label: post.signLabel || '',
            person: post.author || ''
          }])
        });
      }).then(function (rows) {
        if (!rows || !rows.length) return null;
        var p = toPost(rows[0]);
        return p;
      }).catch(function () {
        return null;
      });
    },

    /* 回一句 */
    reply: function (postId, author, text, fromOutside) {
      return req('space_replies', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify([{
          post_id: postId,
          author: author || '',
          body: String(text).slice(0, 60),
          from_outside: !!fromOutside
        }])
      }).then(function (rows) {
        return rows && rows.length ? toReply(rows[0]) : null;
      }).catch(function () {
        return null;
      });
    },

    /* 撤下：不真删，打标记。删了就查不到是谁撤的。 */
    hide: function (postId) {
      return req('space_posts?id=eq.' + postId, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ hidden: true })
      }).then(function () { return true; }).catch(function () { return false; });
    }
  };

  global.MTSpace = MTSpace;
  MTSpace.SPACES = SPACES;
  MTSpace.spaceFull = spaceFull;
})(window);
