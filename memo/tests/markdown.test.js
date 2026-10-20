const test = require('node:test');
const assert = require('node:assert/strict');
const Md = require('../markdown.js');

test('extractLinks: エイリアス・見出し・埋め込み・コード内を正しく扱う', () => {
  const md = '[[A]] [[B|別名]] [[C#見出し]] ![[D]] [[a]]\n`[[E]]`\n```\n[[F]]\n```';
  assert.deepEqual(Md.extractLinks(md), ['A', 'B', 'C', 'D']);
});

test('extractTags: 日本語タグ・ネスト、見出しと数字のみは除外', () => {
  const md = '# 見出し\n#仕事 と #project/alpha と #123 と a#no `#code`';
  assert.deepEqual(Md.extractTags(md), ['仕事', 'project/alpha']);
});

test('renameLinks: 別名・見出し付きリンクも書き換える', () => {
  const md = '[[Old]] [[old|x]] [[Old#h]] ![[Old]] [[Older]]';
  assert.equal(Md.renameLinks(md, 'Old', 'New'), '[[New]] [[New|x]] [[New#h]] ![[New]] [[Older]]');
});

test('toggleTask: 指定行だけ反転', () => {
  const md = '- [ ] a\n- [x] b\ntext';
  assert.equal(Md.toggleTask(md, 0), '- [x] a\n- [x] b\ntext');
  assert.equal(Md.toggleTask(md, 1), '- [ ] a\n- [ ] b\ntext');
  assert.equal(Md.toggleTask(md, 2), md);
});

test('render: HTML はエスケープされ javascript: URL は無効化される', () => {
  const html = Md.render('<script>alert(1)</script> [x](javascript:alert(1)) [[<img onerror=x>]]');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('<img onerror'));
});

test('render: 未作成リンクに unresolved クラス', () => {
  const html = Md.render('[[有る]] [[無い]]', { resolve: (t) => t === '有る' });
  assert.match(html, /class="wikilink" data-target="有る"/);
  assert.match(html, /class="wikilink unresolved" data-target="無い"/);
});

test('render: タスクの data-line は元の行番号（引用内も含む）', () => {
  const html = Md.render('intro\n\n- [ ] one\n  - [x] two\n\n> - [ ] quoted');
  assert.match(html, /data-line="2">/);
  assert.match(html, /data-line="3" checked>/);
  assert.match(html, /data-line="5">/);
});

test('render: 入れ子リスト・表・コールアウト・コード', () => {
  const html = Md.render('- a\n  - b\n- c\n\n| x | y |\n| :-- | --: |\n| 1 | 2 |\n\n> [!warning]- 注意\n> 本文\n\n```js\nlet a = "<b>";\n```');
  assert.match(html, /<ul><li>a<ul><li>b<\/li><\/ul><\/li><li>c<\/li><\/ul>/);
  assert.match(html, /<th style="text-align:left">x<\/th>/);
  assert.match(html, /<details class="callout callout-warning">/);
  assert.match(html, /let a = &quot;&lt;b&gt;&quot;;/);
});

test('render: インライン装飾', () => {
  const html = Md.renderInline('**太字** *斜体* ~~消~~ ==強調== `c*o*de` https://example.com/a #タグ');
  assert.match(html, /<strong>太字<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<del>消<\/del>/);
  assert.match(html, /<mark>強調<\/mark>/);
  assert.match(html, /<code>c\*o\*de<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com\/a"/);
  assert.match(html, /data-tag="タグ"/);
});

test('render: 埋め込みは ctx.embed に委譲', () => {
  const html = Md.render('![[ノート#見出し]]', { embed: (t) => `<x>${t.target}|${t.heading}</x>` });
  assert.equal(html, '<x>ノート|見出し</x>');
});

test('extractSection: 見出し配下だけを返す', () => {
  const md = '# T\n## A\na1\n### A-1\na2\n## B\nb';
  assert.equal(Md.extractSection(md, 'A'), '## A\na1\n### A-1\na2');
});

test('frontmatter: 書き出し → 読み込みで往復できる', () => {
  const schema = [
    { key: 'status', type: 'select' }, { key: 'tags', type: 'multi' }, { key: 'done', type: 'checkbox' },
  ];
  const note = { body: '本文', icon: '🚀', props: { status: '進行中', tags: ['仕事', 'a b'], done: true } };
  const file = Md.toMarkdownFile(note, schema);
  const { meta, body } = Md.parseMarkdownFile(file);
  assert.deepEqual(meta, { status: '進行中', tags: ['仕事', 'a b'], done: true, icon: '🚀' });
  assert.equal(body, '本文');
});

test('parseMarkdownFile: YAML のリスト記法', () => {
  const { meta, body } = Md.parseMarkdownFile('---\ntags:\n  - x\n  - "y"\ntitle: T\n---\nhello');
  assert.deepEqual(meta, { tags: ['x', 'y'], title: 'T' });
  assert.equal(body, 'hello');
});
