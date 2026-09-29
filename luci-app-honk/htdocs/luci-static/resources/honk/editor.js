'use strict';
'require view';
'require form';
'require fs';
'require ui';
'require poll';
'require rpc';
'require baseclass';

/*
 * luci-app-honk 共用工具：`editorPage({ blocks })` 一个页签承载多个配置块，
 * 外加带 CodeMirror 的 form.TextValue 与运行状态卡片。
 */

var SERVICE = 'honk';
var INITD = '/etc/init.d/honk';

var PATHS = {
	config: '/etc/honk/config.dae',
	dns: '/etc/honk/config.d/dns.dae',
	node: '/etc/honk/config.d/node.dae',
	route: '/etc/honk/config.d/route.dae',
	/* native_api 的全部字段都要重启才生效，所以本块的服务动作是 restart */
	api: '/etc/honk/config.d/api.dae',
	log: '/var/log/honk/honk.log'
};

/* ---------------------------------------------------------------- CodeMirror */

var CM_ASSETS = [
	/* CodeMirror 5.65.21 压缩版（未压缩源码见 vendor 说明） */
	{ css: 'honk/lib/codemirror.min.css' },
	{ css: 'honk/addon/fold/foldgutter.min.css' },
	{ css: 'honk/theme/dracula.min.css' },
	{ js: 'honk/lib/codemirror.min.js' },
	{ js: 'honk/addon/edit/matchbrackets.min.js' },
	{ js: 'honk/addon/edit/closebrackets.min.js' },
	{ js: 'honk/addon/selection/active-line.min.js' },
	{ js: 'honk/addon/fold/foldcode.min.js' },
	{ js: 'honk/addon/fold/foldgutter.min.js' },
	{ js: 'honk/addon/fold/indent-fold.min.js' },
	{ js: 'honk/mode/dae/dae.js' }
];

var CM_STYLE = [
	/* 编辑器保留 200px 右边距（与原版一致，别删：占满整卡会显得过宽） */
	'.honk-cm .CodeMirror { margin-right: 200px; border: 1px solid #6272a4; border-radius: 6px; height: auto;',
	'	min-height: 400px; font-family: "Fira Code", "Monaco", "Consolas", monospace;',
	'	font-size: 13px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }',
	'.honk-cm .cm-s-dracula.CodeMirror { background-color: #282a36 !important; color: #f8f8f2 !important; }',
	'.honk-cm .cm-s-dracula .CodeMirror-gutters { border-right: none !important; background-color: #282a36 !important; }',
	'.honk-cm .cm-s-dracula .CodeMirror-linenumber { color: #6272a4 !important; }',
	'.honk-cm .cm-s-dracula .cm-keyword, .honk-cm .cm-s-dracula .cm-operator { color: #ff79c6 !important; font-weight: bold; }',
	'.honk-cm .cm-s-dracula .cm-variable-3 { color: #ffb86c !important; }',
	'.honk-cm .cm-s-dracula .cm-def { color: #50fa7b !important; }',
	'.honk-cm .cm-s-dracula .cm-number { color: #bd93f9 !important; }',
	'.honk-cm .cm-s-dracula .cm-string { color: #f1fa8c !important; }',
	'.honk-cm .cm-s-dracula .cm-comment { color: #6272a4 !important; font-style: italic; }',
	/* 「配置块路径」行：路径与服务动作都在字段列，字段右边距与格式化按钮一致 */
	'.honk-cm .honk-pathrow > .cbi-value-field { display: flex; align-items: center;',
	'	justify-content: space-between; gap: 12px; margin-right: 210px; }',
	'.honk-cm .honk-pathrow code { font-size: inherit; }',
	/* 两个按钮与上方下拉同尺寸；等宽是因为 aurora 各变体几何一致，宽度差只来自文案 */
	'.honk-cm .honk-reload, .honk-cm .honk-fmt-ed { min-width: 7.25rem; font-size: var(--text-sm);',
	'	min-height: calc(var(--spacing) * 8.5); }',
	/* 贴在编辑器右上角，用编辑器那套 dracula 色（不随主题明暗变） */
	/* 编辑器与上面的字段同一左边缘：缩进 = 标签列(12rem) + .cbi-value 的 gap(spacing*6) */
	'.honk-cm .honk-ed-field { position: relative;',
	'\tmargin-left: calc(12rem + var(--spacing) * 6); }',
	'.honk-cm .honk-fmt-ed { position: absolute; right: 210px; top: 4px; z-index: 4;',  /* 200 + 10 */
	'	border-color: #6272a4; background-color: #282a36; color: #f8f8f2; }',
	'.honk-cm .honk-fmt-ed:hover { background-color: #343746; }',
	/* 「去哪修」深跳过来时高亮那一行（4 秒后自动撤掉） */
	'.honk-cm .CodeMirror .honk-hit { background: rgba(255,212,121,.18); }',
	/* 手机端（<768px）：标签堆到上方、字段占满宽度，格式化按钮改为普通块（不压代码） */
	'@media (max-width: 767px) {',
	'	.honk-cm .cbi-value { flex-direction: column; align-items: stretch; }',
	'	.honk-cm .cbi-value-title { flex: none; text-align: left; padding: 0 0 6px 0; }',
	'	.honk-cm .cbi-value-field { margin-left: 0; }',
	'\t.honk-cm .honk-ed-field { margin-left: 0; }',
	'\t.honk-cm .CodeMirror { margin-right: 0; min-height: 320px; }',
	'\t.honk-cm .honk-pathrow > .cbi-value-field { margin-right: 0; }',
	'	.honk-cm .honk-fmt-ed { position: static; margin-bottom: 6px; }',
	'}'
].join('\n');

var cmReady = null;

/* 取静态资源 URL：优先 L.resource()，并保留兜底（某些 LuCI 构建/旧版没有该助手） */
function resource(path) {
	if (typeof L.resource == 'function')
		return L.resource(path);

	if (L.env && L.env.resource)
		return L.env.resource + path;

	return '/luci-static/resources/' + path;
}

/* 样式必须挂进视图节点内：挂 head 会被主题判为文档污染，挂 #view 直属会被 renderContents 清掉 */
function styleHost(node) {
	return node || document.getElementById('view') || document.body || document.head;
}

/* 加载脚本失败自动重试：uhttpd 偶发丢连接会让编辑器退回文本框 */
function loadScript(url) {
	return new Promise(function(resolve, reject) {
		var attempt = 0;

		(function next() {
			var el = E('script', { src: url });

/* 动态插入的 script 默认 async，要关掉才能保证 codemirror 先于 addon/mode 执行 */
			el.async = false;

			el.onload = function() { resolve(); };
			el.onerror = function() {
				el.remove();

				if (++attempt < 3)
					window.setTimeout(next, 250);
				else
					reject(new Error('无法加载 ' + url));
			};

			document.head.appendChild(el);
		})();
	});
}

/* 样式随视图切换会被释放，每次都补齐；JS 只加载一次 */
function ensureCmStyles(node) {
	var pending = [];

	var host = styleHost(node);

/* 去重限定在视图节点内：主题路由是「先渲染新视图、后释放旧视图」 */
	if (!host.querySelector('#honk-cm-style'))
		host.appendChild(E('style', { id: 'honk-cm-style' }, CM_STYLE));

	CM_ASSETS.forEach(function(asset) {
		if (!asset.css)
			return;

		var url = resource(asset.css);

/* CSS 也纳入等待，避免编辑器先于样式渲染而没吃到主题色 */
		if (host.querySelector('link[href="' + url + '"]'))
			return;

		pending.push(new Promise(function(resolve) {
			var el = E('link', { rel: 'stylesheet', href: url });
			var done = false;

			el.onload = function() { if (!done) { done = true; resolve(); } };
			el.onerror = function() { if (!done) { done = true; resolve(); } };
			host.appendChild(el);

			/* 兜底：极端情况 onload/onerror 都不触发，3 秒后放行（最坏只是没主题色） */
			window.setTimeout(function() { if (!done) { done = true; resolve(); } }, 3000);
		}));
	});

	return Promise.all(pending);
}

function loadCodeMirror(node) {
	/* 样式每次都要补齐（可能随上一个视图被释放），JS 只加载一次 */
	var styles = ensureCmStyles(node);

	if (cmReady)
		return Promise.all([ cmReady, styles ]);

	var pending = [];

	CM_ASSETS.forEach(function(asset) {
		if (asset.css)
			return;

		var url = resource(asset.js);

		if (document.querySelector('script[src="' + url + '"]'))
			return;

		pending.push(loadScript(url));
	});

	cmReady = Promise.all(pending).then(function() {
		if (typeof CodeMirror == 'undefined')
			throw new Error('CodeMirror failed to load');
	}).catch(function(err) {
		/* 失败不永久缓存，下次调用可重试 —— 否则一次偶发失败会让整个会话退回文本框 */
		cmReady = null;
		throw err;
	});

	return Promise.all([ cmReady, styles ]);
}


/* 与 Lua 版 Format Code 完全相同的规则 */
function formatValue(content) {
	return content.split('\n').map(function(line) {
		var t = line.trim();

		if (t.indexOf('#') == 0 || t.indexOf('//') == 0)
			return line;

		line = line.replace(/\s*->\s*/g, ' -> ');
		line = line.replace(/\s*&&\s*/g, ' && ');
		line = line.replace(/(['"])([a-zA-Z0-9_-]+)\1/g, function(match, quote, word) {
			return word;
		});
		return line.trimEnd();
	}).join('\n');
}

/* 从 form.TextValue 渲染出的节点里取出 textarea（返回形态随 LuCI 版本而变） */
function findTextarea(node) {
	if (!node)
		return null;

	if (Array.isArray(node)) {
		for (var i = 0; i < node.length; i++) {
			var found = findTextarea(node[i]);
			if (found)
				return found;
		}
		return null;
	}

	if (node.nodeType == 1) {
		if (node.tagName == 'TEXTAREA')
			return node;
		return node.querySelector ? node.querySelector('textarea') : null;
	}

	return null;
}

/* 脱离文档时创建的编辑器染色会被推迟，可见后需 refresh 一次 */
function refreshWhenVisible(cm) {
	var attempts = 0;

	(function tick() {
		var el = cm.getWrapperElement();

		if (el && el.offsetParent !== null)
			cm.refresh();
		else if (++attempts < 200)
			window.setTimeout(tick, 50);
	})();
}

function attachCodeMirror(textarea, node) {
	/* 包一层 Promise：loadCodeMirror() 的同步异常（例如环境缺 L.resource）也能被 catch 到 */
	return Promise.resolve().then(function() {
		return loadCodeMirror(node);
	}).then(function() {
		var cm = CodeMirror.fromTextArea(textarea, {
			mode: 'dae',
			indentUnit: 4,
			tabSize: 4,
			styleActiveLine: true,
			lineNumbers: true,
			theme: 'dracula',
			lineWrapping: true,
			matchBrackets: true,
			autoCloseBrackets: true,
			foldGutter: true,
			gutters: [ 'CodeMirror-linenumbers', 'CodeMirror-foldgutter' ]
		});

		cm.on('inputRead', function(editor, change) {
			if (change.origin != '+input')
				return;

			var pairs = { '{': '}', '[': ']', '(': ')', '"': '"', "'": "'" };
			var close = pairs[change.text[0]];

			if (close) {
				var cur = editor.getCursor();
				editor.replaceRange(close, cur);
				editor.setCursor(cur);
			}
		});

		/* LuCI 提交表单时读 textarea，这里保持同步（Lua 版亦如此） */
		cm.on('change', function() {
			textarea.value = cm.getValue();
		});

		/* 防御：若表单在挂载之后才写入 textarea（异步 load 的时序差异），以 textarea 为准 */
		if (textarea.value !== cm.getValue())
			cm.setValue(textarea.value || '');
		else
			textarea.value = cm.getValue();

		/* 可见后刷新，确保首屏语法高亮/主题色正确 */
		refreshWhenVisible(cm);

		return cm;
	});
}

/* ------------------------------------------- 带 CodeMirror 的 form.TextValue */

var CodeMirrorValue = form.TextValue.extend({
	renderWidget: function(section_id, option_index, cfgvalue) {
		var node = form.TextValue.prototype.renderWidget.apply(this, arguments);
		var self = this;
		var textarea = findTextarea(node);

		if (textarea) {
			attachCodeMirror(textarea, node).then(function(cm) {
				self.editor = cm;

				/* 让页面在编辑器就绪后做一次性的后续动作（例如「去哪修」带来的字段定位） */
				if (typeof self.onEditorReady == 'function')
					self.onEditorReady(cm);
			}).catch(function(err) {
				ui.addNotification(null, E('p', _('Editor unavailable, plain textarea is used: %s').format(err.message)), 'error');
			});
		}

		return node;
	}
});

/* --------------------------------------------------------------- 状态卡片 */

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

function statusCard() {
	var statusNode = E('span', {}, _('Collecting data...'));
	var memNode = E('div', { style: 'font-size: 12px; color: var(--text-color-medium); margin-top: 4px' });

	function renderStatus(running) {
		statusNode.innerHTML = '';
		statusNode.appendChild(E('span', { style: 'display:inline-block; width:8px; height:8px; border-radius:50%; background:' + (running ? '#46a546' : '#cc3333') + '; margin-right:6px; vertical-align:middle' }));
		statusNode.appendChild(E('strong', {}, SERVICE.toUpperCase() + ' ' + (running ? _('RUNNING') : _('NOT RUNNING'))));
	}

	function refresh() {
		return fs.exec_direct('/usr/libexec/honk-status').then(function(stdout) {
			var data = JSON.parse(stdout || '{}');
			var running = !!data.running;
			renderStatus(running);
			memNode.textContent = data.memory_kb
				? '%s (%s MB)'.format(_('Memory Usage'), (data.memory_kb / 1024).toFixed(1))
				: '';
		}).catch(function() {
			/* helper 不可用时退回 ubus service list（仅运行状态，无内存占用） */
			return callServiceList(SERVICE).then(function(res) {
				var instances = (res && res[SERVICE] && res[SERVICE].instances) || {};
				var running = Object.keys(instances).length > 0;
				renderStatus(running);
				memNode.textContent = '';
			}).catch(function() {
				renderStatus(false);
				memNode.textContent = '';
			});
		});
	}

	poll.add(refresh, 3);
	refresh();

	return E('fieldset', { 'class': 'cbi-section' }, [
		E('h3', {}, _('Running Status')),
		E('div', { style: 'margin: 6px 0 0' }, statusNode),
		memNode
	]);
}

/* ------------------------------------- 页面工厂：一个页签 = 若干配置块 */

/* 取地址里的查询参数：LuCI 的路由可能是路径式，也可能是 #/ 式，两处都认 */
function queryParam(name) {
	var raw = String(window.location.search || '') + '&' +
		String(window.location.hash || '').replace(/^[^?]*[?]?/, '');
	var hit = null;

	raw.replace(/^[?]/, '').split('&').forEach(function(kv) {
		var i = kv.indexOf('=');

		if (i > 0 && decodeURIComponent(kv.slice(0, i)) === name)
			hit = decodeURIComponent(kv.slice(i + 1));
	});

	return hit;
}

/* 定位某个字段所在行并高亮（focus=xxx 带过来） */
function focusField(cm, field) {
	var name = String(field || '').replace(/[^A-Za-z0-9_]/g, '');
	var hit = -1;

	if (!name)
		return;

	var re = new RegExp('^(#[ ]*)?' + name + '[ ]*[:=]');

	for (var i = 0; i < cm.lineCount(); i++) {
		if (re.test(cm.getLine(i).replace(/^[ \t]+/, ''))) {
			hit = i;
			break;
		}
	}

	if (hit < 0)
		return;

	cm.setCursor({ line: hit, ch: 0 });
	cm.addLineClass(hit, 'background', 'honk-hit');
	cm.scrollIntoView({ line: hit, ch: 0 }, 120);
	window.setTimeout(function() { cm.removeLineClass(hit, 'background', 'honk-hit'); }, 4000);
}

/*
 * opts: title / description（页签级，固定）、blocks（每块含 key / label / description /
 * editorTitle（下拉里显示的名称；文件路径显示在编辑器标题行）,
 * 可选 reload* 定制服务动作）、uciSection(section)（给出时渲染 uci 开关与状态卡片）。
 */
function editorPage(opts) {
	var blocks = opts.blocks || [];
	var current = blocks[0];

	function blockOf(key) {
		for (var i = 0; i < blocks.length; i++) {
			if (blocks[i].key === key)
				return blocks[i];
		}
		return blocks[0];
	}

	return view.extend({
		render: function() {
/* 其它页面可用 ?block=<key>[&focus=<字段>] 定位到配置块与字段 */
			var wantBlock = queryParam('block');

			if (wantBlock) {
				var b = blockOf(wantBlock);

				if (b && b.key === wantBlock)
					current = b;
			}

			var wantFocus = queryParam('focus');

			var m = new form.Map('honk', opts.title, opts.description);

			if (opts.uciSection) {
				var st = m.section(form.TypedSection, 'honk');
				st.anonymous = true;
				opts.uciSection(st);
			}

			var s = m.section(form.NamedSection, 'config', 'honk');
			s.anonymous = true;

			/* 描述放在「配置块」那一行，编辑器区不再重复 */
			var o = s.option(CodeMirrorValue, '_edit', current.editorTitle);
			o.rows = 28;
			o.monospace = true;
			o.wrap = 'off';
			/* 读写的路径跟着「配置块」下拉走，取当前值而不是闭包首次捕获的值 */
			o.load = function() {
				var path = PATHS[current.key];

				return fs.read(path).then(function(data) {
					return data != null ? data : '';
				}).catch(function(err) {
					ui.addNotification(null, E('p', _('Unable to read %s: %s').format(path, err.message)), 'error');
					return '';
				});
			};
			o.write = function(section_id, value) {
				return fs.write(PATHS[current.key], value, 416 /* 0640，与 honk 启动脚本收紧后的权限一致 */);
			};
			/* 「去哪修」带来的字段定位：编辑器就绪后做一次（之后重绘/切块不再触发） */
			o.onEditorReady = function(cm) {
				if (!wantFocus)
					return;

				focusField(cm, wantFocus);
				wantFocus = null;
			};

			return m.render().then(L.bind(function(node) {
				this.formMap = m;
				this.editorOption = o;

/* 状态卡片只建一次并复用：内部有 poll.add，每次重绘都重建会叠加轮询 */
				var statusEl = opts.uciSection ? statusCard() : null;

				var setEditorValue = function(value) {
					if (o.editor)
						o.editor.setValue(value || '');
					else {
						var ta = findTextarea(node);
						if (ta)
							ta.value = value || '';
					}
				};

/* 单卡片布局。必须可重放：Map.save()/reset() 会经 renderContents 清空重建，而 view.render 不重跑 */
				var applyLayout = function() {
					/* 幂等：重放不该把注入节点叠起来 */
					Array.prototype.slice.call(node.querySelectorAll('.honk-inject')).forEach(function(el) {
						if (el.parentNode)
							el.parentNode.removeChild(el);
					});

					/* 收集顶层 section（TypedSection=已启用 / NamedSection=编辑器） */
					var sections = [];
					for (var i = 0; i < node.children.length; i++) {
						var el = node.children[i];
						if (el.classList && el.classList.contains('cbi-section'))
							sections.push(el);
					}

					var enabledValue = null, editorSection = null;
					if (opts.uciSection && sections.length >= 2) {
						enabledValue = sections[0].querySelector('.cbi-value');
						editorSection = sections[1];
					}
					else if (sections.length >= 1) {
						editorSection = sections[0];
					}

					var editorValue = editorSection ? editorSection.querySelector('.cbi-value') : null;
					var editorField = editorValue ? editorValue.querySelector('.cbi-value-field') : null;

/* 去掉 LuCI 那列 12rem 的标签，标题改由下面的标题行承担（否则编辑器被挤窄、按钮对不齐） */
					var luciLabel = editorValue ? editorValue.querySelector(':scope > .cbi-value-title') : null;
					if (luciLabel && luciLabel.parentNode)
						luciLabel.parentNode.removeChild(luciLabel);

					/* 编辑器那一行作为定位容器：格式化按钮贴在编辑器右上角 */
					if (editorField)
						editorField.classList.add('honk-ed-field');

					var formatBtn = E('button', {
						'class': 'cbi-button honk-fmt-ed honk-inject',
						'type': 'button',
						'click': function() {
							var cm = o.editor;
							if (cm) {
								cm.operation(function() {
									var cur = cm.getCursor();
									cm.setValue(formatValue(cm.getValue()));
									for (var k = 0; k < cm.lineCount(); k++)
										cm.indentLine(k, 'smart');
									cm.setCursor(cur);
								});
							}
							else {
								var ta = findTextarea(editorValue);
								if (ta)
									ta.value = formatValue(ta.value);
							}
						}
					}, _('Format Code'));

					if (editorField)
						editorField.appendChild(formatBtn);

/* 服务动作与文案取当前配置块，切块即生效，无需重建按钮 */
					var reloadBtn = E('button', {
						'class': 'cbi-button cbi-button-action honk-reload honk-inject',
						'type': 'button',
						'click': function() {
							var b = current;
							/* 不能用 L.resolveDefault(..., null) 包住：它会把 rejection 吞成 null，
							   下面的 .catch 永远进不去，失败也不会有任何提示 */
							return fs.exec_direct(INITD, [ b.reloadAction || 'hot_reload' ]).then(function() {
								ui.addNotification(null, E('p', _(b.reloadOk || 'Service reloaded successfully')), 'info');
							}).catch(function(err) {
								ui.addNotification(null, E('p', _(b.reloadFail || 'Reload failed: %s').format(err && err.message ? err.message : err)), 'error');
							});
						}
					}, _(current.reloadNowLabel || 'Reload Now'));

					/* 「配置块路径」用标准表单行：标签进左列（与「配置块」标签同列右对齐），
					   路径与服务动作都在字段列；字段右边距与格式化按钮一致 */
					var pathCode = E('code', {}, PATHS[current.key]);

					var pathRow = E('div', { 'class': 'cbi-value honk-inject honk-pathrow' }, [
						E('label', { 'class': 'cbi-value-title' }, _('Config Block Path')),
						E('div', { 'class': 'cbi-value-field' }, [ pathCode, reloadBtn ])
					]);

					/* 配置块：下拉 + 该块的描述（描述随块变，编辑器区不再重复） */
					var blockSel = E('select', { 'class': 'cbi-input-select' },
						blocks.map(function(b) {
							return E('option', { 'value': b.key }, _(b.editorTitle));
						}));

					/* 选中态只能构造后赋值：dom.attr() 只跳过 null，false 同样走 setAttribute，
					   `selected="false"` 属性存在即选中，多选项时取最后一个 */
					blockSel.value = current.key;

					var blockDesc = E('div', { 'class': 'cbi-value-description' }, current.description);

					var blockRow = E('div', { 'class': 'cbi-value honk-inject' }, [
						E('label', { 'class': 'cbi-value-title' }, _('Config Block')),
						E('div', { 'class': 'cbi-value-field' }, [ blockSel, blockDesc ])
					]);

					/* 切换配置块：重读磁盘上的文件，并把标题 / 描述 / 服务动作的文案一起换掉 */
					blockSel.addEventListener('change', function(ev) {
						var key = ev.target.value;

						current = blockOf(key);
						blockDesc.textContent = current.description;
					pathCode.textContent = PATHS[key];
						reloadBtn.textContent = _(current.reloadNowLabel || 'Reload Now');

						return fs.read(PATHS[key]).then(function(data) {
							setEditorValue(data != null ? data : '');
						}).catch(function(err) {
							ui.addNotification(null, E('p', _('Unable to read %s: %s').format(PATHS[key], err.message)), 'error');
							setEditorValue('');
						});
					});

					/* 单卡片：启动服务 → 配置块 → 编辑器标题（+ 服务动作）→ 编辑器 */
					var card = E('div', { 'class': 'cbi-section' });

					if (enabledValue)
						card.appendChild(enabledValue);

					card.appendChild(blockRow);
					card.appendChild(pathRow);

					if (editorValue)
						card.appendChild(editorValue);

					sections.forEach(function(s) {
						if (s.parentNode)
							s.parentNode.removeChild(s);
					});

					node.appendChild(card);

					/* 运行状态卡片置于页签标题（及描述）下方、配置卡片上方 */
					if (opts.uciSection)
						node.insertBefore(statusEl, card);
				};

/* 包装 renderContents：原生重绘后重放布局 */
				var origRenderContents = m.renderContents.bind(m);
				m.renderContents = function() {
					return origRenderContents.apply(null, arguments).then(function(el) {
						applyLayout();
						return el;
					});
				};

				applyLayout();
				return E('div', { 'class': 'honk-cm' }, node);
			}, this));
		},

		handleSave: function(ev) {
			return this.formMap.save();
		},

		handleSaveApply: function(ev, mode) {
/* 保存与重载解耦：重载由标题行的按钮单独触发 */
			return this.handleSave(ev).then(function() {
				/* 提示里的按钮名随当前配置块变化：面板块是「立即重启」，其余是「立即重载」 */
				ui.addNotification(null, E('p',
					_('Configuration saved. Use %s to apply it.').format(_(current.reloadNowLabel || 'Reload Now'))),
					'info');
			});
		},

		/* Reset = 放弃编辑，重新载入磁盘上的内容（CodeMirror 需同步，故自行实现） */
		handleReset: function() {
			return fs.read(PATHS[current.key]).then(L.bind(function(data) {
				var option = this.editorOption;

				if (option && option.editor)
					option.editor.setValue(data != null ? data : '');
			}, this));
		}
	});
}

/* LuCI 要求模块 return 一个 Class 子类（Class.isSubclass 检查），否则报
 * "xxx factory yields invalid constructor"。 */
return baseclass.extend({
	PATHS: PATHS,
	SERVICE: SERVICE,
	INITD: INITD,
	loadCodeMirror: loadCodeMirror,
	attachCodeMirror: attachCodeMirror,
	formatValue: formatValue,
	CodeMirrorValue: CodeMirrorValue,
	statusCard: statusCard,
	editorPage: editorPage
});
