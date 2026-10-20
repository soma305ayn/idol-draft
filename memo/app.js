/*
 * Hybrid Memo — Obsidian のリンク／グラフ／ローカルファースト と
 * Notion のスラッシュコマンド／ネストページ／プロパティ／データベースビュー を組み合わせたメモアプリ。
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'hybrid-memo:v1';
  const Md = window.Md;

  // ================================================================ helpers

  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || (k in e && typeof v !== 'string')) e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.append(kid instanceof Node ? kid : String(kid));
    }
    return e;
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function todayStr(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return 'たった今';
    if (diff < 3600) return Math.floor(diff / 60) + '分前';
    if (diff < 86400) return Math.floor(diff / 3600) + '時間前';
    return todayStr(d);
  }

  function download(filename, text, type = 'text/plain') {
    const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeFilename(name) {
    return (name || '無題').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
  }

  function toast(msg) {
    const t = el('div', { class: 'toast' }, msg);
    $('#toasts').append(t);
    setTimeout(() => t.classList.add('hide'), 2200);
    setTimeout(() => t.remove(), 2600);
  }

  /** textarea にテキストを挿入する（可能ならブラウザの Undo 履歴に残す） */
  function insertText(ta, text) {
    ta.focus();
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  /** textarea 内のキャレット位置（textarea 左上からの px） */
  function caretCoords(ta, pos) {
    const cs = getComputedStyle(ta);
    const div = document.createElement('div');
    for (const p of [
      'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight',
      'fontSize', 'lineHeight', 'fontFamily', 'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent',
    ]) div.style[p] = cs[p];
    Object.assign(div.style, {
      position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
      top: '0', left: '-9999px',
    });
    div.textContent = ta.value.slice(0, pos);
    const span = el('span', null, ta.value.slice(pos, pos + 1) || '.');
    div.append(span);
    document.body.append(div);
    const r = { top: span.offsetTop, left: span.offsetLeft, height: parseFloat(cs.lineHeight) || 24 };
    div.remove();
    return r;
  }

  // ================================================================ state

  const DEFAULT_SCHEMA = [
    { key: 'status', name: 'ステータス', type: 'select', options: ['未着手', '進行中', '完了'] },
    { key: 'tags', name: 'タグ', type: 'multi' },
    { key: 'due', name: '期日', type: 'date' },
  ];

  const PROP_TYPES = {
    text: 'テキスト',
    number: '数値',
    date: '日付',
    select: 'セレクト',
    multi: 'マルチセレクト',
    checkbox: 'チェックボックス',
    url: 'URL',
  };

  const ICONS = '📄 📝 📌 📚 📖 💡 ✅ 🎯 🚀 🧠 🗂️ 📅 🗓️ 💼 🏠 ✈️ 🍳 🎵 🎮 🎨 📷 💰 🛒 ❤️ ⭐ 🔥 🌱 ☕ 🐛 🔧 🧪 📊 🔒 🌏 👥 💬'.split(' ');

  let state = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s.notes !== 'object') return null;
      s.schema = Array.isArray(s.schema) ? s.schema : DEFAULT_SCHEMA.slice();
      s.ui = Object.assign(defaultUi(), s.ui || {});
      return s;
    } catch (_) {
      return null;
    }
  }

  function defaultUi() {
    return {
      currentId: null, editorMode: 'split', theme: 'system', expanded: {}, sidebar: true,
      graph: { tags: false, orphans: true }, boardProp: 'status', tableSort: { key: 'updated', dir: -1 },
      recent: [],
    };
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('保存に失敗しました（ストレージ容量を確認してください）');
    }
  }
  window.addEventListener('beforeunload', saveNow);

  function notes() {
    return Object.values(state.notes);
  }

  function getNote(id) {
    return id ? state.notes[id] || null : null;
  }

  function findByTitle(title) {
    const key = Md.normalizeTitle(title);
    if (!key) return null;
    return notes().find((n) => Md.normalizeTitle(n.title) === key) || null;
  }

  function uniqueTitle(title, exceptId) {
    const base = (title || '').trim() || '無題';
    let t = base;
    let i = 2;
    while (notes().some((n) => n.id !== exceptId && Md.normalizeTitle(n.title) === Md.normalizeTitle(t))) t = base + ' ' + i++;
    return t;
  }

  function createNote(opts = {}) {
    const n = {
      id: uid(),
      title: opts.exactTitle ? opts.title : uniqueTitle(opts.title),
      body: opts.body || '',
      icon: opts.icon || '',
      parentId: opts.parentId || null,
      props: opts.props || {},
      pinned: false,
      created: Date.now(),
      updated: Date.now(),
    };
    state.notes[n.id] = n;
    if (n.parentId) state.ui.expanded[n.parentId] = true;
    save();
    return n;
  }

  function touch(note) {
    note.updated = Date.now();
    save();
  }

  function children(id) {
    return notes()
      .filter((n) => (n.parentId || null) === id || (id === null && n.parentId && !state.notes[n.parentId]))
      .sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  }

  function ancestors(note) {
    const out = [];
    const seen = new Set();
    let p = getNote(note.parentId);
    while (p && !seen.has(p.id)) {
      out.unshift(p);
      seen.add(p.id);
      p = getNote(p.parentId);
    }
    return out;
  }

  function isDescendant(id, maybeAncestorId) {
    let p = getNote(id);
    const seen = new Set();
    while (p && !seen.has(p.id)) {
      if (p.id === maybeAncestorId) return true;
      seen.add(p.id);
      p = getNote(p.parentId);
    }
    return false;
  }

  function deleteNote(id) {
    const n = getNote(id);
    if (!n) return;
    const kids = notes().filter((c) => c.parentId === id);
    const msg = '「' + n.title + '」を削除しますか？' + (kids.length ? '\n（子ページ ' + kids.length + ' 件は一つ上の階層に移動します）' : '');
    if (!confirm(msg)) return;
    for (const c of kids) c.parentId = n.parentId || null;
    delete state.notes[id];
    state.ui.recent = state.ui.recent.filter((r) => r !== id);
    save();
    toast('削除しました');
    if (state.ui.currentId === id) {
      const next = getNote(n.parentId) || notes().sort((a, b) => b.updated - a.updated)[0];
      state.ui.currentId = next ? next.id : null;
      navigate(next ? '#/note/' + next.id : '#/');
    } else render();
  }

  const linkCache = new Map();
  function linksOf(note) {
    let c = linkCache.get(note.id);
    if (!c || c.body !== note.body) {
      c = { body: note.body, links: Md.extractLinks(note.body), tags: Md.extractTags(note.body) };
      linkCache.set(note.id, c);
    }
    return c;
  }

  function tagsOf(note) {
    const set = new Set(Array.isArray(note.props.tags) ? note.props.tags : []);
    for (const t of linksOf(note).tags) set.add(t);
    return [...set];
  }

  function allTags() {
    const counts = new Map();
    for (const n of notes()) for (const t of tagsOf(n)) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
  }

  function backlinks(note) {
    const key = Md.normalizeTitle(note.title);
    return notes().filter((n) => n.id !== note.id && linksOf(n).links.some((l) => Md.normalizeTitle(l) === key));
  }

  function unlinkedMentions(note) {
    const title = note.title.trim();
    if (title.length < 2) return [];
    const linked = new Set(backlinks(note).map((n) => n.id));
    const needle = title.toLowerCase();
    return notes().filter((n) => n.id !== note.id && !linked.has(n.id) && n.body.toLowerCase().includes(needle));
  }

  /** タイトル変更時に他ノートの [[旧タイトル]] を書き換える */
  function propagateRename(note, oldTitle) {
    if (!oldTitle || Md.normalizeTitle(oldTitle) === Md.normalizeTitle(note.title)) return;
    let count = 0;
    const key = Md.normalizeTitle(oldTitle);
    for (const n of notes()) {
      if (!linksOf(n).links.some((l) => Md.normalizeTitle(l) === key)) continue;
      n.body = Md.renameLinks(n.body, oldTitle, note.title);
      touch(n);
      count++;
    }
    if (count) toast(count + ' 件のノートのリンクを更新しました');
  }

  function rememberRecent(id) {
    state.ui.recent = [id, ...state.ui.recent.filter((r) => r !== id)].slice(0, 20);
  }

  // ================================================================ seed

  function seed() {
    state = { version: 1, notes: {}, schema: DEFAULT_SCHEMA.map((p) => ({ ...p })), ui: defaultUi() };
    const welcome = createNote({
      title: 'ようこそ',
      icon: '👋',
      body: [
        '# Hybrid Memo へようこそ',
        '',
        '**Obsidian** の「リンクでつながる知識ベース」と、**Notion** の「ブロック感覚の編集とデータベース」をひとつにしたメモアプリです。',
        '',
        '> [!tip] まずはここから',
        '> 本文の空行で `/` を入力するとスラッシュコマンドが開きます。`[[` と入力すると他のノートへのリンク候補が出ます。',
        '',
        '## Obsidian っぽい機能',
        '- [[Markdownの書き方]] — `[[リンク]]`、`#タグ`、`![[埋め込み]]`、コールアウト',
        '- ノート下部の **バックリンク** と **未リンクの言及**',
        '- サイドバーの「グラフ」でノート同士のつながりを可視化',
        '- 「今日のノート」でデイリーノートを作成',
        '- データはブラウザ内に保存（ローカルファースト）。`.md` での入出力に対応',
        '',
        '## Notion っぽい機能',
        '- `/` で見出し・ToDo・表・コールアウトなどを挿入',
        '- ページの中にページ（サイドバーでドラッグして階層を変更）',
        '- アイコンと **プロパティ**（ステータス・タグ・期日など、型付き）',
        '- 「データベース」で全ノートを表として編集、「ボード」でカンバン管理',
        '',
        '## ショートカット',
        '| 操作 | キー |',
        '| --- | --- |',
        '| コマンドパレット / 検索 | `Ctrl/⌘ + K` |',
        '| 新規ノート | `Alt + N` |',
        '| 編集 / 閲覧の切替 | `Ctrl/⌘ + E` |',
        '| 太字 / 斜体 | `Ctrl/⌘ + B` / `Ctrl/⌘ + I` |',
        '',
        '試しに [[プロジェクトA]] を開いてみましょう。 #ガイド',
      ].join('\n'),
    });
    welcome.pinned = true;

    createNote({
      title: 'Markdownの書き方',
      icon: '📖',
      parentId: welcome.id,
      body: [
        '# Markdown の書き方',
        '',
        '**太字**、*斜体*、~~取り消し~~、==ハイライト==、`インラインコード`',
        '',
        '## リンク',
        '- ノートへのリンク: [[ようこそ]]',
        '- 別名つきリンク: [[ようこそ|トップページ]]',
        '- まだ存在しないノート: [[いつか書くノート]]（クリックすると作成されます）',
        '- 外部リンク: [Obsidian](https://obsidian.md)',
        '',
        '## タスク',
        '- [x] 完了したタスク',
        '- [ ] 未完了のタスク（閲覧側でクリックして切替）',
        '  - [ ] ネストもできます',
        '',
        '## コールアウト',
        '> [!note] メモ',
        '> 補足情報を目立たせられます。',
        '',
        '> [!warning]- 折りたたみ',
        '> `[!type]-` と書くと折りたたまれます。',
        '',
        '## コード',
        '```js',
        'console.log("hello");',
        '```',
        '',
        '## 埋め込み',
        '![[プロジェクトA#ゴール]]',
        '',
        '#ガイド',
      ].join('\n'),
    });

    const project = createNote({
      title: 'プロジェクトA',
      icon: '🚀',
      props: { status: '進行中', tags: ['仕事'], due: todayStr(new Date(Date.now() + 7 * 864e5)) },
      body: [
        '# プロジェクトA',
        '',
        '## ゴール',
        '- 新しいメモアプリのプロトタイプを作る',
        '- 社内でフィードバックをもらう',
        '',
        '## タスク',
        '- [x] 要件を整理する',
        '- [ ] [[デザイン案]] を作る',
        '- [ ] 議事録をまとめる',
        '',
        '関連: [[ようこそ]]',
      ].join('\n'),
    });

    createNote({
      title: 'デザイン案',
      icon: '🎨',
      parentId: project.id,
      props: { status: '未着手', tags: ['仕事', 'デザイン'] },
      body: '# デザイン案\n\nサイドバー + ページ + プロパティの構成にする。\n\n親: [[プロジェクトA]]',
    });

    createNote({
      title: '議事録 ' + todayStr(),
      icon: '💬',
      parentId: project.id,
      props: { status: '完了', tags: ['仕事', '会議'] },
      body: '# 議事録\n\n- 参加者: チーム全員\n- 決定事項: [[デザイン案]] を来週までに作成\n\n#会議',
    });

    createNote({
      title: '読みたい本',
      icon: '📚',
      props: { status: '未着手', tags: ['プライベート'] },
      body: '# 読みたい本\n\n- [ ] 本1\n- [ ] 本2\n\n#読書',
    });

    state.ui.currentId = welcome.id;
    return state;
  }

  // ================================================================ routing

  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [path, query] = hash.split('?');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(query || '');
    return { view: parts[0] || 'note', id: parts[1] || null, params };
  }

  function navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function openNote(id) {
    navigate('#/note/' + id);
  }

  function openByTitle(title, heading) {
    let n = findByTitle(title);
    if (!n) {
      n = createNote({ title, exactTitle: true, body: '' });
      toast('「' + title + '」を作成しました');
    }
    pendingHeading = heading || null;
    openNote(n.id);
  }

  let pendingHeading = null;

  window.addEventListener('hashchange', render);

  // ================================================================ render root

  const app = $('#app');
  const sidebarEl = $('#sidebar');
  const mainEl = $('#main');
  let viewCleanup = null;

  function applyTheme() {
    const t = state.ui.theme;
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }

  function render() {
    applyTheme();
    if (viewCleanup) {
      viewCleanup();
      viewCleanup = null;
    }
    hideSuggest();
    const route = parseRoute();
    app.classList.toggle('sidebar-collapsed', !state.ui.sidebar);
    if (route.view === 'note') {
      let note = getNote(route.id) || getNote(state.ui.currentId);
      if (!route.id && note) {
        history.replaceState(null, '', '#/note/' + note.id);
      }
      if (note) {
        state.ui.currentId = note.id;
        rememberRecent(note.id);
      }
      renderSidebar(route);
      renderNoteView(note);
    } else {
      renderSidebar(route);
      if (route.view === 'table') renderTableView(route.params);
      else if (route.view === 'board') renderBoardView();
      else if (route.view === 'graph') renderGraphView();
      else renderNoteView(getNote(state.ui.currentId));
    }
    if (window.matchMedia('(max-width: 800px)').matches) app.classList.remove('sidebar-open');
    save();
  }

  // ================================================================ sidebar

  function renderSidebar(route) {
    const scrollTop = $('.sidebar-scroll', sidebarEl)?.scrollTop || 0;
    sidebarEl.innerHTML = '';

    const navItem = (icon, label, hash, active, extra) =>
      el('a', { class: 'nav-item' + (active ? ' active' : ''), href: hash, onclick: extra }, el('span', { class: 'nav-icon' }, icon), label);

    const header = el('div', { class: 'sidebar-header' },
      el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, '◆'), 'Hybrid Memo'),
      el('button', { class: 'icon-btn', title: 'テーマ切替', onclick: cycleTheme }, themeIcon()),
      el('button', { class: 'icon-btn', title: 'サイドバーを閉じる', onclick: toggleSidebar }, '«'),
    );

    const search = el('button', { class: 'search-btn', onclick: () => openPalette('') },
      el('span', null, '🔍 検索・コマンド'), el('kbd', null, isMac() ? '⌘K' : 'Ctrl K'));

    const nav = el('nav', { class: 'nav' },
      navItem('📅', '今日のノート', '#', false, (e) => { e.preventDefault(); openDailyNote(); }),
      navItem('🗂️', 'データベース', '#/table', route.view === 'table'),
      navItem('📋', 'ボード', '#/board', route.view === 'board'),
      navItem('🕸️', 'グラフ', '#/graph', route.view === 'graph'),
    );

    const scroll = el('div', { class: 'sidebar-scroll' });

    const pinned = notes().filter((n) => n.pinned).sort((a, b) => a.title.localeCompare(b.title, 'ja'));
    if (pinned.length) {
      scroll.append(el('div', { class: 'section-title' }, 'お気に入り'),
        el('div', { class: 'tree' }, pinned.map((n) => treeRow(n, 0, route, false))));
    }

    const pagesHeader = el('div', { class: 'section-title droppable' },
      el('span', null, 'ページ'),
      el('button', { class: 'icon-btn small', title: '新規ページ', onclick: () => newNote() }, '+'));
    pagesHeader.addEventListener('dragover', (e) => { e.preventDefault(); pagesHeader.classList.add('drag-over'); });
    pagesHeader.addEventListener('dragleave', () => pagesHeader.classList.remove('drag-over'));
    pagesHeader.addEventListener('drop', (e) => {
      e.preventDefault();
      pagesHeader.classList.remove('drag-over');
      moveNote(e.dataTransfer.getData('text/x-note-id'), null);
    });
    const tree = el('div', { class: 'tree' });
    const walk = (parentId, depth) => {
      for (const n of children(parentId)) {
        tree.append(treeRow(n, depth, route, true));
        if (state.ui.expanded[n.id]) walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    scroll.append(pagesHeader, tree);

    const tags = allTags();
    if (tags.length) {
      scroll.append(el('div', { class: 'section-title' }, 'タグ'),
        el('div', { class: 'tag-cloud' }, tags.map(([t, c]) =>
          el('a', { class: 'tag-chip', href: '#/table?tag=' + encodeURIComponent(t) }, '#' + t, el('span', { class: 'count' }, c)))));
    }

    const footer = el('div', { class: 'sidebar-footer' },
      el('button', { class: 'text-btn', onclick: () => $('#import-input').click() }, '⬆ インポート'),
      el('button', { class: 'text-btn', onclick: exportAll }, '⬇ バックアップ'),
    );

    sidebarEl.append(header, search, nav, scroll, footer);
    scroll.scrollTop = scrollTop;
  }

  function treeRow(n, depth, route, withChildren) {
    const kids = withChildren ? children(n.id) : [];
    const expanded = !!state.ui.expanded[n.id];
    const active = route.view === 'note' && state.ui.currentId === n.id;
    const row = el('div', {
      class: 'tree-row' + (active ? ' active' : ''),
      style: { paddingLeft: 8 + depth * 14 + 'px' },
      draggable: true,
      onclick: () => openNote(n.id),
    },
      el('button', {
        class: 'twisty' + (kids.length ? '' : ' empty') + (expanded ? ' open' : ''),
        onclick: (e) => {
          e.stopPropagation();
          state.ui.expanded[n.id] = !expanded;
          renderSidebar(parseRoute());
        },
      }, '▸'),
      el('span', { class: 'tree-icon' }, n.icon || '📄'),
      el('span', { class: 'tree-title' }, n.title || '無題'),
      el('button', {
        class: 'icon-btn small row-action', title: '子ページを追加',
        onclick: (e) => { e.stopPropagation(); newNote({ parentId: n.id }); },
      }, '+'),
    );
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-note-id', n.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('drag-over');
      moveNote(e.dataTransfer.getData('text/x-note-id'), n.id);
    });
    return row;
  }

  function moveNote(id, parentId) {
    const n = getNote(id);
    if (!n || id === parentId) return;
    if (parentId && isDescendant(parentId, id)) {
      toast('自分の子孫の中には移動できません');
      return;
    }
    n.parentId = parentId;
    if (parentId) state.ui.expanded[parentId] = true;
    touch(n);
    render();
  }

  function toggleSidebar() {
    if (window.matchMedia('(max-width: 800px)').matches) {
      app.classList.toggle('sidebar-open');
      return;
    }
    state.ui.sidebar = !state.ui.sidebar;
    app.classList.toggle('sidebar-collapsed', !state.ui.sidebar);
    save();
  }

  function themeIcon() {
    return { system: '🌓', light: '☀️', dark: '🌙' }[state.ui.theme];
  }

  function cycleTheme() {
    const order = ['system', 'light', 'dark'];
    state.ui.theme = order[(order.indexOf(state.ui.theme) + 1) % order.length];
    applyTheme();
    toast('テーマ: ' + { system: 'システム', light: 'ライト', dark: 'ダーク' }[state.ui.theme]);
    renderSidebar(parseRoute());
    save();
  }

  const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

  function topbar(titleNodes, actions) {
    return el('div', { class: 'topbar' },
      el('button', { class: 'icon-btn menu-btn', title: 'サイドバー', onclick: toggleSidebar }, '☰'),
      el('div', { class: 'topbar-title' }, titleNodes),
      el('div', { class: 'topbar-actions' }, actions),
    );
  }

  // ================================================================ note view

  function newNote(opts = {}) {
    const n = createNote({ title: opts.title || '無題', parentId: opts.parentId || null, body: opts.body || '', props: opts.props || {} });
    focusTitleNext = true;
    openNote(n.id);
    return n;
  }

  let focusTitleNext = false;

  function openDailyNote() {
    const title = todayStr();
    const n = findByTitle(title);
    if (n) return openNote(n.id);
    const created = createNote({
      title,
      exactTitle: true,
      icon: '📅',
      body: '# ' + title + '\n\n## やること\n- [ ] \n\n## メモ\n\n\n#デイリー',
    });
    openNote(created.id);
  }

  function renderNoteView(note) {
    mainEl.innerHTML = '';
    if (!note) {
      mainEl.append(topbar('ノート'), el('div', { class: 'empty-state' },
        el('div', { class: 'empty-icon' }, '📝'),
        el('p', null, 'ノートがありません'),
        el('button', { class: 'primary-btn', onclick: () => newNote() }, '新しいノートを作成')));
      return;
    }

    const crumbs = [...ancestors(note), note].map((n, i, arr) =>
      el('span', { class: 'crumb' },
        el('a', { href: '#/note/' + n.id }, (n.icon || '📄') + ' ' + (n.title || '無題')),
        i < arr.length - 1 ? el('span', { class: 'crumb-sep' }, '/') : null));

    const modeTabs = el('div', { class: 'seg' }, [['edit', '編集'], ['split', '分割'], ['read', '閲覧']].map(([m, label]) =>
      el('button', { class: state.ui.editorMode === m ? 'active' : '', onclick: () => setEditorMode(m) }, label)));

    const moreMenu = el('details', { class: 'menu' },
      el('summary', { class: 'icon-btn', title: 'その他' }, '⋯'),
      el('div', { class: 'menu-list' },
        el('button', { onclick: () => { note.pinned = !note.pinned; touch(note); render(); } }, note.pinned ? '★ お気に入りから外す' : '☆ お気に入りに追加'),
        el('button', { onclick: () => newNote({ parentId: note.id }) }, '＋ 子ページを追加'),
        el('button', { onclick: () => download(safeFilename(note.title) + '.md', Md.toMarkdownFile(note, state.schema), 'text/markdown') }, '⬇ Markdown で書き出し'),
        el('button', { onclick: () => duplicateNote(note) }, '⧉ 複製'),
        el('button', { class: 'danger', onclick: () => deleteNote(note.id) }, '🗑 削除'),
      ));

    const page = el('div', { class: 'page' });
    mainEl.append(topbar(crumbs, [
      el('span', { class: 'muted small' }, '更新 ' + formatTime(note.updated)),
      modeTabs,
      moreMenu,
    ]), el('div', { class: 'main-scroll' }, page));

    // --- header (icon, title, properties)
    const iconBtn = el('button', { class: 'page-icon', title: 'アイコンを変更', onclick: (e) => openIconPicker(e.currentTarget, note) }, note.icon || '📄');
    const title = el('textarea', { class: 'page-title', rows: 1, placeholder: '無題', value: note.title, spellcheck: false });
    let titleAtFocus = note.title;
    const autosizeTitle = () => { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
    title.addEventListener('focus', () => { titleAtFocus = note.title; });
    title.addEventListener('input', () => {
      note.title = title.value.replace(/\n/g, ' ');
      touch(note);
      autosizeTitle();
      refreshSidebarSoon();
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        source.focus();
        source.setSelectionRange(0, 0);
      }
    });
    title.addEventListener('blur', () => {
      if (!note.title.trim()) note.title = uniqueTitle('無題', note.id);
      const clash = notes().find((n) => n.id !== note.id && Md.normalizeTitle(n.title) === Md.normalizeTitle(note.title));
      if (clash) {
        note.title = uniqueTitle(note.title, note.id);
        toast('同じタイトルのノートがあるため「' + note.title + '」にしました');
      }
      title.value = note.title;
      propagateRename(note, titleAtFocus);
      titleAtFocus = note.title;
      refreshSidebarSoon();
      refreshPreview();
    });

    page.append(el('div', { class: 'page-header' }, iconBtn, title, renderProperties(note)));

    // --- editor
    const body = el('div', { class: 'editor-body mode-' + state.ui.editorMode });
    const source = el('textarea', {
      class: 'source', spellcheck: false, value: note.body,
      placeholder: 'ここに書き始めましょう…  「/」でコマンド、「[[」でリンク',
    });
    const preview = el('div', { class: 'preview markdown' });
    body.append(source, preview);
    page.append(body);

    const backlinksEl = el('section', { class: 'backlinks' });
    page.append(backlinksEl);

    const autosize = () => {
      const scroller = $('.main-scroll', mainEl);
      const top = scroller.scrollTop;
      source.style.height = 'auto';
      source.style.height = Math.max(source.scrollHeight, 240) + 'px';
      scroller.scrollTop = top;
    };

    function refreshPreview() {
      preview.innerHTML = Md.render(note.body, renderCtx(note, 0)) || '<p class="muted">（空のノート）</p>';
    }
    const refreshPreviewSoon = debounce(refreshPreview, 120);
    const refreshBacklinksSoon = debounce(() => renderBacklinks(note, backlinksEl), 600);

    source.addEventListener('input', () => {
      note.body = source.value;
      touch(note);
      autosize();
      refreshPreviewSoon();
      refreshBacklinksSoon();
      refreshSidebarSoon();
      updateSuggest(source, note);
    });
    source.addEventListener('keydown', (e) => onEditorKeydown(e, source, note));
    source.addEventListener('click', () => updateSuggest(source, note));
    source.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== source) hideSuggest(); }, 150));

    preview.addEventListener('click', (e) => onPreviewClick(e, note, source));
    preview.addEventListener('dblclick', (e) => {
      if (state.ui.editorMode === 'read' && !e.target.closest('a,input')) setEditorMode('edit');
    });

    refreshPreview();
    renderBacklinks(note, backlinksEl);
    requestAnimationFrame(() => {
      autosizeTitle();
      autosize();
      if (focusTitleNext) {
        focusTitleNext = false;
        title.focus();
        title.select();
      }
      if (pendingHeading) {
        const target = preview.querySelector('#h-' + CSS.escape(Md.slug(pendingHeading)));
        if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
        pendingHeading = null;
      }
    });
    const ro = new ResizeObserver(() => autosize());
    ro.observe(body);
    viewCleanup = () => ro.disconnect();
  }

  const refreshSidebarSoon = debounce(() => renderSidebar(parseRoute()), 300);

  function setEditorMode(m) {
    state.ui.editorMode = m;
    save();
    render();
    if (m !== 'read') requestAnimationFrame(() => $('.source', mainEl)?.focus());
  }

  function duplicateNote(note) {
    const n = createNote({ title: note.title + ' のコピー', body: note.body, parentId: note.parentId, icon: note.icon, props: JSON.parse(JSON.stringify(note.props)) });
    toast('複製しました');
    openNote(n.id);
  }

  function renderCtx(note, depth) {
    return {
      resolve: (t) => !!findByTitle(t),
      embed: ({ target, heading }) => {
        const t = findByTitle(target) || (target ? null : note);
        if (!t) return '<div class="embed missing">' + Md.renderInline('[[' + target + ']]', { resolve: () => false }) + ' は存在しません</div>';
        if (depth >= 2 || t.id === note.id && !heading) return '<div class="embed missing">（埋め込みが深すぎます）</div>';
        const src = heading ? Md.extractSection(t.body, heading) : t.body;
        return '<div class="embed"><div class="embed-title"><a href="#" class="wikilink" data-target="' + Md.escapeHtml(t.title) +
          '" data-heading="' + Md.escapeHtml(heading) + '">' + Md.escapeHtml((t.icon || '📄') + ' ' + t.title + (heading ? ' › ' + heading : '')) +
          '</a></div>' + Md.render(src, renderCtx(t, depth + 1)) + '</div>';
      },
    };
  }

  function onPreviewClick(e, note, source) {
    const link = e.target.closest('a.wikilink');
    if (link) {
      e.preventDefault();
      const target = link.dataset.target;
      const heading = link.dataset.heading;
      if (!target || Md.normalizeTitle(target) === Md.normalizeTitle(note.title)) {
        if (heading) $('#h-' + CSS.escape(Md.slug(heading)), e.currentTarget)?.scrollIntoView({ behavior: 'smooth' });
        return;
      }
      openByTitle(target, heading);
      return;
    }
    const tag = e.target.closest('a.tag');
    if (tag) {
      e.preventDefault();
      navigate('#/table?tag=' + encodeURIComponent(tag.dataset.tag));
      return;
    }
    const box = e.target.closest('input[type=checkbox][data-line]');
    if (box) {
      if (box.closest('.embed')) {
        e.preventDefault();
        return;
      }
      note.body = Md.toggleTask(note.body, Number(box.dataset.line));
      source.value = note.body;
      touch(note);
      box.closest('li')?.classList.toggle('done', box.checked);
    }
  }

  function renderBacklinks(note, container) {
    container.innerHTML = '';
    const linked = backlinks(note);
    const unlinked = unlinkedMentions(note);
    const item = (n) => {
      const snippet = findSnippet(n.body, note.title);
      return el('a', { class: 'backlink', href: '#/note/' + n.id },
        el('div', { class: 'backlink-title' }, (n.icon || '📄') + ' ' + n.title),
        snippet ? el('div', { class: 'backlink-snippet' }, snippet) : null);
    };
    container.append(
      el('h3', null, 'バックリンク ', el('span', { class: 'count' }, linked.length)),
      linked.length ? el('div', { class: 'backlink-list' }, linked.map(item)) : el('p', { class: 'muted small' }, 'このノートにリンクしているノートはありません'),
    );
    if (unlinked.length) {
      container.append(el('details', { class: 'unlinked' },
        el('summary', null, '未リンクの言及 ', el('span', { class: 'count' }, unlinked.length)),
        el('div', { class: 'backlink-list' }, unlinked.map((n) =>
          el('div', { class: 'backlink-row' }, item(n),
            el('button', {
              class: 'text-btn small',
              title: '最初の言及を [[リンク]] に変換',
              onclick: () => {
                const re = new RegExp(note.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                n.body = n.body.replace(re, (m) => '[[' + m + ']]');
                touch(n);
                renderBacklinks(note, container);
                toast('「' + n.title + '」にリンクを追加しました');
              },
            }, 'リンクする')))),
      ));
    }
  }

  function findSnippet(body, title) {
    const idx = body.toLowerCase().indexOf(title.toLowerCase());
    if (idx < 0) return '';
    const start = Math.max(0, idx - 40);
    return (start > 0 ? '…' : '') + body.slice(start, idx + title.length + 60).replace(/\s+/g, ' ').trim() + '…';
  }

  // ---------------------------------------------------------------- icon picker

  function openIconPicker(anchor, note) {
    closePopover();
    const pop = el('div', { class: 'popover icon-picker' },
      el('div', { class: 'icon-grid' }, ICONS.map((ic) =>
        el('button', { onclick: () => { note.icon = ic; touch(note); closePopover(); render(); } }, ic))),
      el('div', { class: 'icon-picker-footer' },
        el('input', {
          placeholder: '絵文字を入力して Enter', maxlength: 8,
          onkeydown: (e) => {
            if (e.key === 'Enter' && e.target.value.trim()) {
              note.icon = e.target.value.trim();
              touch(note);
              closePopover();
              render();
            }
          },
        }),
        el('button', { class: 'text-btn small', onclick: () => { note.icon = ''; touch(note); closePopover(); render(); } }, '削除')));
    showPopover(pop, anchor);
  }

  let popoverEl = null;
  function showPopover(pop, anchor) {
    popoverEl = pop;
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + 'px';
    pop.style.top = r.bottom + 6 + 'px';
    setTimeout(() => document.addEventListener('mousedown', outsidePopover), 0);
  }
  function outsidePopover(e) {
    if (popoverEl && !popoverEl.contains(e.target)) closePopover();
  }
  function closePopover() {
    document.removeEventListener('mousedown', outsidePopover);
    popoverEl?.remove();
    popoverEl = null;
  }

  // ---------------------------------------------------------------- properties

  function renderProperties(note) {
    const wrap = el('div', { class: 'props' });
    for (const p of state.schema) {
      wrap.append(el('div', { class: 'prop-row' },
        el('button', { class: 'prop-name', title: 'プロパティを編集', onclick: (e) => openPropMenu(e.currentTarget, p) },
          el('span', { class: 'prop-type-icon' }, propIcon(p.type)), p.name),
        el('div', { class: 'prop-value' }, propEditor(note, p, () => {}))));
    }
    wrap.append(el('button', { class: 'text-btn add-prop', onclick: (e) => openAddProp(e.currentTarget) }, '＋ プロパティを追加'));
    return wrap;
  }

  function propIcon(type) {
    return { text: '≡', number: '#', date: '📆', select: '◉', multi: '☰', checkbox: '☑', url: '🔗' }[type] || '≡';
  }

  /** プロパティ1件の編集ウィジェット（ページ・データベース共通） */
  function propEditor(note, p, onChange) {
    const v = note.props[p.key];
    const set = (val) => {
      if (val === '' || val == null || (Array.isArray(val) && !val.length)) delete note.props[p.key];
      else note.props[p.key] = val;
      touch(note);
      onChange();
    };
    switch (p.type) {
      case 'checkbox':
        return el('input', { type: 'checkbox', checked: !!v, onchange: (e) => set(e.target.checked || null) });
      case 'date':
        return el('input', { type: 'date', class: 'prop-input', value: v || '', onchange: (e) => set(e.target.value) });
      case 'number':
        return el('input', { type: 'number', class: 'prop-input', value: v ?? '', placeholder: '空', onchange: (e) => set(e.target.value === '' ? null : Number(e.target.value)) });
      case 'select': {
        const opts = p.options || [];
        const s = el('select', { class: 'prop-select' + (v ? ' has-value' : '') + ' opt-' + Math.max(0, opts.indexOf(v)) % 6 },
          el('option', { value: '' }, '—'),
          opts.map((o) => el('option', { value: o, selected: o === v }, o)),
          el('option', { value: '__new__' }, '＋ 選択肢を追加…'));
        s.addEventListener('change', () => {
          if (s.value === '__new__') {
            const name = prompt('新しい選択肢の名前');
            if (name && name.trim()) {
              p.options = [...opts, name.trim()];
              set(name.trim());
            }
            render();
            return;
          }
          set(s.value);
          s.className = 'prop-select' + (s.value ? ' has-value' : '') + ' opt-' + Math.max(0, opts.indexOf(s.value)) % 6;
          if (p.key === state.ui.boardProp && parseRoute().view === 'board') render();
        });
        return s;
      }
      case 'multi': {
        const box = el('div', { class: 'chips' });
        const draw = () => {
          box.innerHTML = '';
          const cur = Array.isArray(note.props[p.key]) ? note.props[p.key] : [];
          for (const t of cur) {
            box.append(el('span', { class: 'chip' }, t, el('button', {
              title: '外す',
              onclick: () => { set(cur.filter((x) => x !== t)); draw(); refreshSidebarSoon(); },
            }, '×')));
          }
          if (p.key === 'tags') {
            for (const t of linksOf(note).tags.filter((t) => !cur.includes(t))) {
              box.append(el('span', { class: 'chip inline-tag', title: '本文中の #タグ' }, '#' + t));
            }
          }
          const input = el('input', {
            class: 'chip-input', placeholder: cur.length ? '' : '追加…', list: 'dl-' + p.key,
            onkeydown: (e) => {
              if ((e.key === 'Enter' || e.key === ',') && !e.isComposing && input.value.trim()) {
                e.preventDefault();
                const val = input.value.trim().replace(/^#/, '');
                if (!cur.includes(val)) set([...cur, val]);
                draw();
                refreshSidebarSoon();
                box.querySelector('.chip-input')?.focus();
              } else if (e.key === 'Backspace' && !input.value && cur.length) {
                set(cur.slice(0, -1));
                draw();
                box.querySelector('.chip-input')?.focus();
              }
            },
          });
          const known = p.key === 'tags' ? allTags().map(([t]) => t) : [...new Set(notes().flatMap((n) => n.props[p.key] || []))];
          box.append(input, el('datalist', { id: 'dl-' + p.key }, known.map((t) => el('option', { value: t }))));
        };
        draw();
        return box;
      }
      case 'url': {
        const wrap = el('div', { class: 'url-prop' });
        const input = el('input', { type: 'url', class: 'prop-input', value: v || '', placeholder: 'https://…', onchange: (e) => set(e.target.value.trim()) });
        wrap.append(input);
        if (v && /^https?:\/\//.test(v)) wrap.append(el('a', { href: v, target: '_blank', rel: 'noopener noreferrer', class: 'icon-btn small', title: '開く' }, '↗'));
        return wrap;
      }
      default:
        return el('input', { class: 'prop-input', value: v || '', placeholder: '空', onchange: (e) => set(e.target.value) });
    }
  }

  function openAddProp(anchor) {
    closePopover();
    const name = el('input', { placeholder: 'プロパティ名' });
    const type = el('select', null, Object.entries(PROP_TYPES).map(([k, v]) => el('option', { value: k }, v)));
    const submit = () => {
      const n = name.value.trim();
      if (!n) return;
      let key = n.toLowerCase().replace(/\s+/g, '_');
      while (state.schema.some((p) => p.key === key)) key += '_';
      state.schema.push({ key, name: n, type: type.value, options: type.value === 'select' ? ['A', 'B'] : undefined });
      save();
      closePopover();
      render();
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submit(); });
    const pop = el('div', { class: 'popover form-pop' },
      el('label', null, '名前', name), el('label', null, '種類', type),
      el('button', { class: 'primary-btn', onclick: submit }, '追加'));
    showPopover(pop, anchor);
    name.focus();
  }

  function openPropMenu(anchor, p) {
    closePopover();
    const name = el('input', { value: p.name });
    const opts = p.type === 'select'
      ? el('label', null, '選択肢（1行に1つ）', el('textarea', { rows: 4, class: 'opts', value: (p.options || []).join('\n') }))
      : null;
    const pop = el('div', { class: 'popover form-pop' },
      el('label', null, '名前', name),
      el('div', { class: 'muted small' }, '種類: ' + PROP_TYPES[p.type]),
      opts,
      el('div', { class: 'row' },
        el('button', {
          class: 'primary-btn',
          onclick: () => {
            p.name = name.value.trim() || p.name;
            if (opts) p.options = $('.opts', pop).value.split('\n').map((s) => s.trim()).filter(Boolean);
            save();
            closePopover();
            render();
          },
        }, '保存'),
        el('button', {
          class: 'text-btn danger',
          onclick: () => {
            if (!confirm('プロパティ「' + p.name + '」を削除しますか？（全ノートから値が消えます）')) return;
            state.schema = state.schema.filter((x) => x !== p);
            for (const n of notes()) delete n.props[p.key];
            save();
            closePopover();
            render();
          },
        }, '削除')));
    showPopover(pop, anchor);
  }

  // ---------------------------------------------------------------- editor keys & suggestions

  function onEditorKeydown(e, ta, note) {
    if (suggest.open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        suggest.index = (suggest.index + (e.key === 'ArrowDown' ? 1 : -1) + suggest.items.length) % suggest.items.length;
        drawSuggest();
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
        e.preventDefault();
        applySuggest(ta, note, suggest.items[suggest.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideSuggest();
        return;
      }
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'b' || e.key === 'i')) {
      e.preventDefault();
      wrapSelection(ta, e.key === 'b' ? '**' : '*');
      return;
    }
    if (e.key === 'Tab' && !e.isComposing) {
      e.preventDefault();
      indentLines(ta, e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Enter' && !e.isComposing && !e.shiftKey && !mod && ta.selectionStart === ta.selectionEnd) {
      const pos = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
      const line = ta.value.slice(lineStart, pos);
      const m = line.match(/^(\s*)(?:([-*+])|(\d+)([.)]))\s+(\[[ xX]\]\s+)?/);
      const q = !m && line.match(/^(\s*>\s?)/);
      if (m) {
        e.preventDefault();
        if (line.slice(m[0].length).trim() === '' && ta.value.slice(pos, ta.value.indexOf('\n', pos) >>> 0).trim() === '') {
          ta.setSelectionRange(lineStart, pos);
          insertText(ta, '');
          return;
        }
        const marker = m[2] || Number(m[3]) + 1 + m[4];
        insertText(ta, '\n' + m[1] + marker + ' ' + (m[5] ? '[ ] ' : ''));
        return;
      }
      if (q) {
        e.preventDefault();
        if (line.trim() === '>') {
          ta.setSelectionRange(lineStart, pos);
          insertText(ta, '');
          return;
        }
        insertText(ta, '\n' + q[1]);
      }
    }
  }

  function wrapSelection(ta, mark) {
    const { selectionStart: s, selectionEnd: en, value } = ta;
    const sel = value.slice(s, en);
    insertText(ta, mark + sel + mark);
    if (!sel) ta.setSelectionRange(s + mark.length, s + mark.length);
    else ta.setSelectionRange(s + mark.length, en + mark.length);
  }

  function indentLines(ta, dir) {
    const { selectionStart: s, selectionEnd: en, value } = ta;
    const start = value.lastIndexOf('\n', s - 1) + 1;
    const endIdx = value.indexOf('\n', en);
    const end = endIdx < 0 ? value.length : endIdx;
    const block = value.slice(start, end);
    const lines = block.split('\n');
    const out = lines.map((l) => (dir > 0 ? '  ' + l : l.replace(/^( {1,2}|\t)/, ''))).join('\n');
    ta.setSelectionRange(start, end);
    insertText(ta, out);
    const delta = out.length - block.length;
    if (s === en) {
      const firstDelta = (out.split('\n')[0].length - lines[0].length);
      ta.setSelectionRange(Math.max(start, s + firstDelta), Math.max(start, s + firstDelta));
    } else ta.setSelectionRange(start, end + delta);
  }

  const SLASH_COMMANDS = [
    { id: 'h1', label: '見出し1', hint: '#', keys: 'h1 heading midashi 見出し', text: '# ¦' },
    { id: 'h2', label: '見出し2', hint: '##', keys: 'h2 heading midashi 見出し', text: '## ¦' },
    { id: 'h3', label: '見出し3', hint: '###', keys: 'h3 heading midashi 見出し', text: '### ¦' },
    { id: 'todo', label: 'ToDo リスト', hint: '- [ ]', keys: 'todo task check タスク', text: '- [ ] ¦' },
    { id: 'ul', label: '箇条書き', hint: '-', keys: 'bullet list ul リスト', text: '- ¦' },
    { id: 'ol', label: '番号付きリスト', hint: '1.', keys: 'number ordered ol リスト', text: '1. ¦' },
    { id: 'quote', label: '引用', hint: '>', keys: 'quote inyou 引用', text: '> ¦' },
    { id: 'callout', label: 'コールアウト', hint: '> [!note]', keys: 'callout note tip info', text: '> [!note] ¦\n> ' },
    { id: 'code', label: 'コードブロック', hint: '```', keys: 'code コード', text: '```\n¦\n```' },
    { id: 'table', label: '表', hint: '| |', keys: 'table hyou 表 テーブル', text: '| 項目 | 内容 |\n| --- | --- |\n| ¦ |  |' },
    { id: 'hr', label: '区切り線', hint: '---', keys: 'divider hr line 区切り', text: '---\n¦' },
    { id: 'link', label: 'ノートへのリンク', hint: '[[ ]]', keys: 'link wiki リンク', text: '[[¦' },
    { id: 'embed', label: 'ノートの埋め込み', hint: '![[ ]]', keys: 'embed transclude 埋め込み', text: '![[¦' },
    { id: 'page', label: '子ページを作成', hint: '新規', keys: 'page subpage child ページ', action: 'page' },
    { id: 'date', label: '今日の日付', hint: todayStr(), keys: 'date today 日付 今日', text: () => todayStr() + '¦' },
    { id: 'image', label: '画像（URL）', hint: '![]()', keys: 'image img 画像', text: '![](¦)' },
  ];

  const suggest = { open: false, kind: '', items: [], index: 0, start: 0, el: null };

  function updateSuggest(ta, note) {
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return hideSuggest();
    const before = ta.value.slice(Math.max(0, pos - 200), pos);
    let m;
    if ((m = before.match(/\[\[([^[\]\n|#]*)$/))) {
      const q = m[1].trim().toLowerCase();
      const items = notes()
        .filter((n) => n.id !== note.id)
        .map((n) => ({ n, s: fuzzyScore(n.title, q) }))
        .filter((x) => x.s > -1)
        .sort((a, b) => b.s - a.s || b.n.updated - a.n.updated)
        .slice(0, 8)
        .map(({ n }) => ({ kind: 'link', label: n.title, icon: n.icon || '📄', value: n.title }));
      if (q && !findByTitle(m[1].trim())) items.push({ kind: 'link', label: '「' + m[1].trim() + '」を新規リンク', icon: '＋', value: m[1].trim() });
      if (!items.length) return hideSuggest();
      showSuggest(ta, 'link', pos - m[1].length, items);
    } else if ((m = before.match(/(?:^|\s)\/([^\s/]*)$/))) {
      const q = m[1].toLowerCase();
      const items = SLASH_COMMANDS
        .filter((c) => !q || c.label.toLowerCase().includes(q) || c.keys.includes(q) || c.id.startsWith(q))
        .map((c) => ({ kind: 'slash', label: c.label, icon: c.hint, cmd: c }));
      if (!items.length) return hideSuggest();
      showSuggest(ta, 'slash', pos - m[1].length - 1, items);
    } else hideSuggest();
  }

  function showSuggest(ta, kind, start, items) {
    const changed = suggest.kind !== kind || suggest.start !== start;
    Object.assign(suggest, { open: true, kind, start, items, index: changed ? 0 : Math.min(suggest.index, items.length - 1) });
    if (!suggest.el) {
      suggest.el = el('div', { class: 'suggest' });
      suggest.el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const row = e.target.closest('[data-i]');
        if (row) applySuggest(ta, getNote(state.ui.currentId), suggest.items[Number(row.dataset.i)]);
      });
      document.body.append(suggest.el);
    }
    suggest.ta = ta;
    drawSuggest();
    const c = caretCoords(ta, start);
    const r = ta.getBoundingClientRect();
    let top = r.top + c.top - ta.scrollTop + c.height + 4;
    const h = suggest.el.offsetHeight;
    if (top + h > window.innerHeight - 8) top = r.top + c.top - ta.scrollTop - h - 4;
    suggest.el.style.top = Math.max(8, top) + 'px';
    suggest.el.style.left = Math.min(r.left + c.left, window.innerWidth - suggest.el.offsetWidth - 8) + 'px';
  }

  function drawSuggest() {
    if (!suggest.el) return;
    suggest.el.innerHTML = '';
    suggest.el.append(el('div', { class: 'suggest-head' }, suggest.kind === 'slash' ? 'ブロックを挿入' : 'ノートにリンク'));
    suggest.items.forEach((it, i) => {
      suggest.el.append(el('div', { class: 'suggest-item' + (i === suggest.index ? ' active' : ''), dataset: { i } },
        el('span', { class: 'suggest-icon' }, it.icon), el('span', null, it.label)));
    });
    suggest.el.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function hideSuggest() {
    suggest.open = false;
    suggest.el?.remove();
    suggest.el = null;
  }

  function applySuggest(ta, note, item) {
    if (!item) return;
    const pos = ta.selectionStart;
    hideSuggest();
    if (item.kind === 'link') {
      const hasClose = ta.value.slice(pos, pos + 2) === ']]';
      ta.setSelectionRange(suggest.start, pos);
      insertText(ta, item.value + (hasClose ? '' : ']]'));
      if (hasClose) ta.setSelectionRange(ta.selectionStart + 2, ta.selectionStart + 2);
      return;
    }
    const cmd = item.cmd;
    ta.setSelectionRange(suggest.start, pos);
    if (cmd.action === 'page') {
      const child = createNote({ title: '無題', parentId: note.id });
      insertText(ta, '[[' + child.title + ']]');
      refreshSidebarSoon();
      toast('子ページ「' + child.title + '」を作成しました');
      return;
    }
    const raw = typeof cmd.text === 'function' ? cmd.text() : cmd.text;
    const caret = raw.indexOf('¦');
    const text = raw.replace('¦', '');
    const start = suggest.start;
    insertText(ta, text);
    if (caret >= 0) ta.setSelectionRange(start + caret, start + caret);
    updateSuggest(ta, note);
  }

  function fuzzyScore(text, q) {
    if (!q) return 0;
    const t = text.toLowerCase();
    const idx = t.indexOf(q);
    if (idx === 0) return 100 - t.length * 0.1;
    if (idx > 0) return 80 - idx;
    let ti = 0;
    let score = 0;
    for (const ch of q) {
      const found = t.indexOf(ch, ti);
      if (found < 0) return -1;
      score += found === ti ? 3 : 1;
      ti = found + 1;
    }
    return score;
  }

  // ================================================================ table (database) view

  function renderTableView(params) {
    mainEl.innerHTML = '';
    const tagFilter = params.get('tag') || '';
    let query = '';
    const sort = state.ui.tableSort;

    const searchInput = el('input', { class: 'filter-input', placeholder: '絞り込み…', type: 'search' });
    const tagSelect = el('select', { class: 'filter-select' },
      el('option', { value: '' }, 'すべてのタグ'),
      allTags().map(([t]) => el('option', { value: t, selected: t === tagFilter }, '#' + t)));
    tagSelect.addEventListener('change', () => navigate('#/table' + (tagSelect.value ? '?tag=' + encodeURIComponent(tagSelect.value) : '')));

    const table = el('table', { class: 'db' });
    const wrap = el('div', { class: 'db-wrap' }, table);

    mainEl.append(
      topbar([el('span', null, '🗂️ データベース'), tagFilter ? el('span', { class: 'tag-chip' }, '#' + tagFilter) : null], [
        searchInput, tagSelect,
        el('button', { class: 'primary-btn', onclick: () => newNote({ props: tagFilter ? { tags: [tagFilter] } : {} }) }, '＋ 新規'),
      ]),
      el('div', { class: 'main-scroll' }, el('div', { class: 'wide-page' }, wrap)),
    );

    const columns = [
      { key: 'title', name: '名前', type: 'title' },
      ...state.schema,
      { key: 'updated', name: '更新日時', type: 'meta' },
    ];

    const valueFor = (n, key) => {
      if (key === 'title') return n.title.toLowerCase();
      if (key === 'updated') return n.updated;
      if (key === 'tags') return tagsOf(n).join(',');
      const v = n.props[key];
      return Array.isArray(v) ? v.join(',') : v ?? '';
    };

    const draw = () => {
      table.innerHTML = '';
      const thead = el('thead', null, el('tr', null, columns.map((c) =>
        el('th', {
          class: sort.key === c.key ? 'sorted' : '',
          onclick: () => {
            if (sort.key === c.key) sort.dir *= -1;
            else Object.assign(sort, { key: c.key, dir: 1 });
            save();
            draw();
          },
        }, c.type === 'title' || c.type === 'meta' ? '' : el('span', { class: 'prop-type-icon' }, propIcon(c.type)), c.name,
        sort.key === c.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''))));
      const q = query.toLowerCase();
      const rows = notes()
        .filter((n) => !tagFilter || tagsOf(n).includes(tagFilter))
        .filter((n) => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
        .sort((a, b) => {
          const va = valueFor(a, sort.key);
          const vb = valueFor(b, sort.key);
          if (va === vb) return 0;
          if (va === '' || va == null) return 1;
          if (vb === '' || vb == null) return -1;
          return (va > vb ? 1 : -1) * sort.dir;
        });
      const tbody = el('tbody', null, rows.map((n) => el('tr', null, columns.map((c) => {
        if (c.type === 'title') {
          return el('td', { class: 'title-cell' }, el('a', { href: '#/note/' + n.id }, el('span', null, n.icon || '📄'), ' ', n.title || '無題'));
        }
        if (c.type === 'meta') return el('td', { class: 'muted small nowrap' }, formatTime(n.updated));
        return el('td', { class: 'prop-cell type-' + c.type }, propEditor(n, c, () => {}));
      }))));
      table.append(thead, tbody);
      if (!rows.length) table.append(el('tbody', null, el('tr', null, el('td', { colspan: columns.length, class: 'muted center' }, '該当するノートはありません'))));
      $('.db-count', mainEl)?.remove();
      wrap.append(el('div', { class: 'db-count muted small' }, rows.length + ' 件'));
    };

    searchInput.addEventListener('input', debounce(() => { query = searchInput.value; draw(); }, 150));
    draw();
  }

  // ================================================================ board view

  function renderBoardView() {
    mainEl.innerHTML = '';
    const selectProps = state.schema.filter((p) => p.type === 'select');
    const prop = selectProps.find((p) => p.key === state.ui.boardProp) || selectProps[0];

    const groupSelect = el('select', { class: 'filter-select' }, selectProps.map((p) => el('option', { value: p.key, selected: prop && p.key === prop.key }, 'グループ: ' + p.name)));
    groupSelect.addEventListener('change', () => { state.ui.boardProp = groupSelect.value; save(); render(); });

    mainEl.append(topbar('📋 ボード', selectProps.length ? [groupSelect] : []));
    if (!prop) {
      mainEl.append(el('div', { class: 'empty-state' }, el('p', null, 'ボードを使うには「セレクト」型のプロパティが必要です。'),
        el('button', { class: 'primary-btn', onclick: (e) => openAddProp(e.currentTarget) }, '＋ プロパティを追加')));
      return;
    }

    const groups = [...(prop.options || []), ''];
    const board = el('div', { class: 'board' });
    for (const g of groups) {
      const cards = notes().filter((n) => ((prop.options || []).includes(n.props[prop.key]) ? n.props[prop.key] : '') === g)
        .sort((a, b) => b.updated - a.updated);
      if (!g && !cards.length) continue;
      const col = el('div', { class: 'board-col' },
        el('div', { class: 'board-col-head' },
          el('span', { class: 'pill opt-' + (g ? prop.options.indexOf(g) % 6 : 'none') }, g || '未設定'),
          el('span', { class: 'count' }, cards.length)),
        el('div', { class: 'board-cards' }, cards.map((n) => {
          const tags = tagsOf(n);
          const tasks = (n.body.match(/^\s*[-*+]\s+\[[ xX]\]/gm) || []).length;
          const done = (n.body.match(/^\s*[-*+]\s+\[[xX]\]/gm) || []).length;
          const card = el('a', { class: 'card', href: '#/note/' + n.id, draggable: true },
            el('div', { class: 'card-title' }, (n.icon || '📄') + ' ' + n.title),
            tags.length ? el('div', { class: 'card-tags' }, tags.slice(0, 4).map((t) => el('span', { class: 'mini-tag' }, '#' + t))) : null,
            el('div', { class: 'card-meta muted small' },
              n.props.due ? el('span', null, '📆 ' + n.props.due) : null,
              tasks ? el('span', null, '☑ ' + done + '/' + tasks) : null));
          card.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/x-note-id', n.id);
            card.classList.add('dragging');
          });
          card.addEventListener('dragend', () => card.classList.remove('dragging'));
          return card;
        })),
        el('button', { class: 'text-btn add-card', onclick: () => newNote({ props: g ? { [prop.key]: g } : {} }) }, '＋ 新規'));
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        const n = getNote(e.dataTransfer.getData('text/x-note-id'));
        if (!n) return;
        if (g) n.props[prop.key] = g;
        else delete n.props[prop.key];
        touch(n);
        render();
      });
      board.append(col);
    }
    mainEl.append(el('div', { class: 'main-scroll board-scroll' }, board));
  }

  // ================================================================ graph view

  function renderGraphView() {
    mainEl.innerHTML = '';
    const opts = state.ui.graph;
    const toggle = (key, label) => el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: !!opts[key], onchange: (e) => { opts[key] = e.target.checked; save(); render(); } }), label);
    mainEl.append(topbar('🕸️ グラフビュー', [toggle('tags', 'タグを表示'), toggle('orphans', '孤立ノートを表示')]));

    const canvas = el('canvas', { class: 'graph-canvas' });
    const wrap = el('div', { class: 'graph-wrap' }, canvas, el('div', { class: 'graph-hint muted small' }, 'ドラッグで移動 / ホイールで拡大縮小 / クリックで開く'));
    mainEl.append(wrap);

    // build graph
    const nodes = [];
    const byId = new Map();
    const addNode = (id, label, kind, ref) => {
      const a = Math.random() * Math.PI * 2;
      const r = 50 + Math.random() * 200;
      const node = { id, label, kind, ref, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, deg: 0, fixed: false };
      nodes.push(node);
      byId.set(id, node);
      return node;
    };
    for (const n of notes()) addNode(n.id, (n.icon ? n.icon + ' ' : '') + n.title, 'note', n);
    const edges = [];
    const edgeSet = new Set();
    const addEdge = (a, b) => {
      const k = a < b ? a + '|' + b : b + '|' + a;
      if (a === b || edgeSet.has(k)) return;
      edgeSet.add(k);
      edges.push({ a: byId.get(a), b: byId.get(b) });
      byId.get(a).deg++;
      byId.get(b).deg++;
    };
    for (const n of notes()) {
      for (const l of linksOf(n).links) {
        const t = findByTitle(l);
        if (t) addEdge(n.id, t.id);
      }
      if (n.parentId && byId.has(n.parentId)) addEdge(n.id, n.parentId);
    }
    if (opts.tags) {
      for (const n of notes()) for (const t of tagsOf(n)) {
        const id = 'tag:' + t;
        if (!byId.has(id)) addNode(id, '#' + t, 'tag', t);
        addEdge(n.id, id);
      }
    }
    let visible = nodes;
    if (!opts.orphans) visible = nodes.filter((n) => n.deg > 0);
    const visibleSet = new Set(visible);

    const neighbors = new Map(visible.map((n) => [n, new Set()]));
    for (const e of edges) {
      neighbors.get(e.a)?.add(e.b);
      neighbors.get(e.b)?.add(e.a);
    }

    const ctx = canvas.getContext('2d');
    const view = { x: 0, y: 0, k: 1 };
    let W = 0;
    let H = 0;
    let alpha = 1;
    let hover = null;
    let drag = null;
    let running = true;

    const css = getComputedStyle(document.documentElement);
    const color = (v) => css.getPropertyValue(v).trim();
    const colors = {
      node: color('--graph-node'), tag: color('--graph-tag'), edge: color('--graph-edge'),
      accent: color('--accent'), text: color('--text'), muted: color('--text-muted'), bg: color('--bg'),
    };

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      W = r.width;
      H = r.height;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const toScreen = (n) => [W / 2 + (n.x + view.x) * view.k, H / 2 + (n.y + view.y) * view.k];
    const toWorld = (sx, sy) => [(sx - W / 2) / view.k - view.x, (sy - H / 2) / view.k - view.y];
    const radius = (n) => (n.kind === 'tag' ? 4 : 5) + Math.sqrt(n.deg) * 2.2;

    function tick() {
      if (alpha < 0.004) return;
      const list = visible;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          if (d2 > 250000) continue;
          const f = (4200 / d2) * alpha;
          const d = Math.sqrt(d2);
          a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
          b.vx += (dx / d) * f; b.vy += (dy / d) * f;
        }
      }
      for (const e of edges) {
        if (!visibleSet.has(e.a) || !visibleSet.has(e.b)) continue;
        const dx = e.b.x - e.a.x;
        const dy = e.b.y - e.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 130) * 0.02 * alpha;
        e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f;
        e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f;
      }
      for (const n of list) {
        n.vx -= n.x * 0.006 * alpha;
        n.vy -= n.y * 0.006 * alpha;
        if (n.fixed) { n.vx = n.vy = 0; continue; }
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
      }
      alpha *= 0.992;
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      const focus = hover || drag?.node || null;
      const near = focus ? neighbors.get(focus) : null;
      const current = state.ui.currentId;
      ctx.lineWidth = 1;
      for (const e of edges) {
        if (!visibleSet.has(e.a) || !visibleSet.has(e.b)) continue;
        const [x1, y1] = toScreen(e.a);
        const [x2, y2] = toScreen(e.b);
        const hot = focus && (e.a === focus || e.b === focus);
        ctx.strokeStyle = hot ? colors.accent : colors.edge;
        ctx.globalAlpha = focus && !hot ? 0.25 : 1;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
      ctx.textAlign = 'center';
      for (const n of visible) {
        const [x, y] = toScreen(n);
        if (x < -50 || y < -50 || x > W + 50 || y > H + 50) continue;
        const r = radius(n) * Math.min(1.6, Math.max(0.7, view.k));
        const dim = focus && n !== focus && !near.has(n);
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.fillStyle = n === focus || n.id === current ? colors.accent : n.kind === 'tag' ? colors.tag : colors.node;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        if (view.k > 0.65 || n === focus || (near && near.has(n)) || n.id === current) {
          ctx.fillStyle = n === focus ? colors.text : colors.muted;
          ctx.fillText(n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label, x, y + r + 13);
        }
      }
      ctx.globalAlpha = 1;
    }

    function loop() {
      if (!running) return;
      tick();
      draw();
      requestAnimationFrame(loop);
    }
    // 初期配置を少し進めておく
    for (let i = 0; i < 120; i++) tick();
    loop();

    const hit = (sx, sy) => {
      const [wx, wy] = toWorld(sx, sy);
      let best = null;
      let bestD = Infinity;
      for (const n of visible) {
        const d = Math.hypot(n.x - wx, n.y - wy);
        const r = (radius(n) + 6) / Math.min(1, view.k);
        if (d < r && d < bestD) { best = n; bestD = d; }
      }
      return best;
    };
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    canvas.addEventListener('pointerdown', (e) => {
      const [sx, sy] = pos(e);
      const n = hit(sx, sy);
      canvas.setPointerCapture(e.pointerId);
      drag = { node: n, sx, sy, vx: view.x, vy: view.y, moved: false };
      if (n) { n.fixed = true; alpha = Math.max(alpha, 0.3); }
    });
    canvas.addEventListener('pointermove', (e) => {
      const [sx, sy] = pos(e);
      if (drag) {
        if (Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag.moved = true;
        if (drag.node) {
          const [wx, wy] = toWorld(sx, sy);
          drag.node.x = wx; drag.node.y = wy;
          alpha = Math.max(alpha, 0.3);
        } else {
          view.x = drag.vx + (sx - drag.sx) / view.k;
          view.y = drag.vy + (sy - drag.sy) / view.k;
        }
      } else {
        hover = hit(sx, sy);
        canvas.style.cursor = hover ? 'pointer' : 'grab';
      }
    });
    canvas.addEventListener('pointerup', () => {
      if (!drag) return;
      const n = drag.node;
      if (n) n.fixed = false;
      if (n && !drag.moved) {
        if (n.kind === 'note') openNote(n.id);
        else navigate('#/table?tag=' + encodeURIComponent(n.ref));
      }
      drag = null;
    });
    canvas.addEventListener('pointerleave', () => { hover = null; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = pos(e);
      const [wx, wy] = toWorld(sx, sy);
      view.k = Math.min(4, Math.max(0.2, view.k * Math.exp(-e.deltaY * 0.0015)));
      view.x = (sx - W / 2) / view.k - wx;
      view.y = (sy - H / 2) / view.k - wy;
    }, { passive: false });

    viewCleanup = () => {
      running = false;
      ro.disconnect();
    };
  }

  // ================================================================ command palette

  const COMMANDS = [
    { label: '新規ノート', icon: '＋', run: () => newNote() },
    { label: '今日のノートを開く', icon: '📅', run: openDailyNote },
    { label: 'データベースを開く', icon: '🗂️', run: () => navigate('#/table') },
    { label: 'ボードを開く', icon: '📋', run: () => navigate('#/board') },
    { label: 'グラフを開く', icon: '🕸️', run: () => navigate('#/graph') },
    { label: 'ランダムなノートを開く', icon: '🎲', run: () => { const all = notes(); if (all.length) openNote(all[Math.floor(Math.random() * all.length)].id); } },
    { label: 'テーマを切り替え', icon: '🌓', run: cycleTheme },
    { label: '編集 / 閲覧を切り替え', icon: '✎', run: () => setEditorMode(state.ui.editorMode === 'read' ? 'split' : 'read') },
    { label: 'サイドバーの表示切替', icon: '☰', run: toggleSidebar },
    { label: 'Markdown / JSON をインポート', icon: '⬆', run: () => $('#import-input').click() },
    { label: 'バックアップを書き出し（JSON）', icon: '⬇', run: exportAll },
    { label: '現在のノートを Markdown で書き出し', icon: '⬇', run: () => { const n = getNote(state.ui.currentId); if (n) download(safeFilename(n.title) + '.md', Md.toMarkdownFile(n, state.schema), 'text/markdown'); } },
    { label: '現在のノートを削除', icon: '🗑', run: () => state.ui.currentId && deleteNote(state.ui.currentId) },
  ];

  let paletteEl = null;

  function openPalette(initial) {
    closePalette();
    const input = el('input', { class: 'palette-input', placeholder: 'ノートを検索… （> でコマンド）', value: initial || '' });
    const list = el('div', { class: 'palette-list' });
    let items = [];
    let index = 0;

    const compute = () => {
      const raw = input.value;
      const cmdMode = raw.startsWith('>');
      const q = (cmdMode ? raw.slice(1) : raw).trim().toLowerCase();
      items = [];
      if (!cmdMode) {
        let scored;
        if (!q) {
          const recent = state.ui.recent.map(getNote).filter(Boolean);
          const rest = notes().filter((n) => !recent.includes(n)).sort((a, b) => b.updated - a.updated);
          scored = [...recent, ...rest].slice(0, 12).map((n) => ({ n, s: 0 }));
        } else {
          scored = notes().map((n) => {
            let s = fuzzyScore(n.title, q);
            let snippet = '';
            if (s < 0) {
              const bi = n.body.toLowerCase().indexOf(q);
              if (bi >= 0) {
                s = 1;
                snippet = n.body.slice(Math.max(0, bi - 20), bi + q.length + 40).replace(/\s+/g, ' ');
              }
            }
            return { n, s, snippet };
          }).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 30);
        }
        items.push(...scored.map(({ n, snippet }) => ({
          icon: n.icon || '📄', label: n.title, sub: snippet || ancestors(n).map((a) => a.title).join(' / '), run: () => openNote(n.id),
        })));
        if (q && !findByTitle(raw.trim())) {
          items.push({ icon: '＋', label: '「' + raw.trim() + '」を作成', run: () => newNote({ title: raw.trim() }) });
        }
      }
      const cmds = COMMANDS.filter((c) => !q || fuzzyScore(c.label, q) >= 0).map((c) => ({ ...c, sub: 'コマンド' }));
      items.push(...(cmdMode || !q ? cmds.slice(0, cmdMode ? 99 : 4) : cmds.slice(0, 3)));
      index = 0;
      draw();
    };

    const draw = () => {
      list.innerHTML = '';
      items.forEach((it, i) => list.append(el('div', {
        class: 'palette-item' + (i === index ? ' active' : ''),
        onmousemove: () => { if (index !== i) { index = i; draw(); } },
        onclick: () => { closePalette(); it.run(); },
      }, el('span', { class: 'palette-icon' }, it.icon), el('span', { class: 'palette-label' }, it.label), it.sub ? el('span', { class: 'palette-sub' }, it.sub) : null)));
      if (!items.length) list.append(el('div', { class: 'palette-empty muted' }, '見つかりません'));
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    };

    input.addEventListener('input', compute);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        draw();
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        const it = items[index];
        closePalette();
        it?.run();
      } else if (e.key === 'Escape') {
        closePalette();
      }
    });

    paletteEl = el('div', { class: 'overlay', onmousedown: (e) => { if (e.target === paletteEl) closePalette(); } },
      el('div', { class: 'palette' }, input, list,
        el('div', { class: 'palette-foot muted small' }, '↑↓ 選択 ・ Enter 決定 ・ Esc 閉じる ・ > コマンド')));
    document.body.append(paletteEl);
    compute();
    input.focus();
  }

  function closePalette() {
    paletteEl?.remove();
    paletteEl = null;
  }

  // ================================================================ import / export

  function exportAll() {
    const data = { app: 'hybrid-memo', version: 1, exported: new Date().toISOString(), schema: state.schema, notes: state.notes };
    download('hybrid-memo-' + todayStr() + '.json', JSON.stringify(data, null, 2), 'application/json');
    toast('バックアップを書き出しました');
  }

  async function importFiles(files) {
    let count = 0;
    for (const file of files) {
      const text = await file.text();
      if (/\.json$/i.test(file.name)) {
        try {
          const data = JSON.parse(text);
          if (!data || typeof data.notes !== 'object') throw new Error('invalid');
          for (const p of data.schema || []) if (!state.schema.some((s) => s.key === p.key)) state.schema.push(p);
          for (const n of Object.values(data.notes)) {
            if (!n || !n.id) continue;
            state.notes[n.id] = { props: {}, icon: '', parentId: null, pinned: false, body: '', title: '無題', created: Date.now(), updated: Date.now(), ...n };
            count++;
          }
        } catch (_) {
          toast(file.name + ' を読み込めませんでした');
        }
        continue;
      }
      const { meta, body } = Md.parseMarkdownFile(text);
      const props = {};
      let icon = '';
      for (const [k, v] of Object.entries(meta)) {
        if (k === 'icon') { icon = String(v); continue; }
        if (k === 'title' || k === 'aliases') continue;
        let p = state.schema.find((s) => s.key === k || s.name === k);
        if (!p) {
          const type = Array.isArray(v) ? 'multi' : typeof v === 'boolean' ? 'checkbox' : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? 'date' : 'text';
          p = { key: k, name: k, type };
          state.schema.push(p);
        }
        if (p.type === 'multi') props[p.key] = Array.isArray(v) ? v.map(String) : String(v).split(',').map((s) => s.trim()).filter(Boolean);
        else if (p.type === 'select') {
          props[p.key] = String(v);
          if (!(p.options || []).includes(String(v))) p.options = [...(p.options || []), String(v)];
        } else props[p.key] = v;
      }
      const title = (meta.title && String(meta.title)) || file.name.replace(/\.(md|markdown|txt)$/i, '');
      createNote({ title, body, props, icon });
      count++;
    }
    save();
    toast(count + ' 件のノートを読み込みました');
    render();
  }

  $('#import-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) importFiles(files);
  });

  // ドラッグ&ドロップで .md を取り込み
  document.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.(md|markdown|txt|json)$/i.test(f.name));
    if (files.length) {
      e.preventDefault();
      importFiles(files);
    }
  });

  // ================================================================ global keys

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'k' || e.key === 'p')) {
      e.preventDefault();
      paletteEl ? closePalette() : openPalette('');
    } else if (mod && e.key === 'e') {
      e.preventDefault();
      if (parseRoute().view === 'note') setEditorMode(state.ui.editorMode === 'read' ? 'split' : 'read');
    } else if (mod && e.key === 's') {
      e.preventDefault();
      saveNow();
      toast('保存しました');
    } else if (e.altKey && (e.key === 'n' || e.code === 'KeyN')) {
      e.preventDefault();
      newNote();
    } else if (e.key === 'Escape') {
      closePopover();
      app.classList.remove('sidebar-open');
    }
  });

  $('#scrim').addEventListener('click', () => app.classList.remove('sidebar-open'));

  // 他タブでの変更を反映
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;
    const next = load();
    if (next) {
      state = next;
      render();
    }
  });

  state = load() || seed();
  render();
})();
