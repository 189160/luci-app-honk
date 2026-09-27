'use strict';
'require view';
'require fs';
'require uci';
'require ui';
'require dom';
'require poll';

/*
 * WebUI —— 面板的地址、状态与更新。
 *
 * 面板**不嵌在本页里**，只在新标签页打开，三个原因：
 *   1) 跨源 iframe 被 X-Frame-Options / CSP 拒绝时浏览器不给任何反馈，只会渲染空白；
 *   2) 本页走 https 而面板走 http 时 iframe 命中混合内容拦截，顶层新标签页不受此限；
 *   3) doona 的玻璃主题自带一张 position:fixed + backdrop-filter 的遮罩层（.rp-shell:after），
 *      在部分浏览器上会盖住面板内容 —— 该层在面板自己的文档里，本页无法干预。
 *
 * 状态探测与面板更新都在**路由器侧**执行，见 /usr/libexec/honk-native-api-probe 与
 * /usr/libexec/honk-panel-update；本页只渲染它们输出的 JSON。
 *
 * 样式一律内联，不注入 <style>：aurora 等主题的同文档路由会把手写进 <head> 的样式表
 * 判定为"文档被污染"，从而放弃无刷新切换、退回整页加载（editor.js 里有同样的说明）。
 */

var PROBE = '/usr/libexec/honk-native-api-probe';
var UPDATE = '/usr/libexec/honk-panel-update';

/* 「更新来源」是浏览器侧的偏好（未设置时按面板目录名推断），不落 uci：
   本页没有"只提交、不触发服务动作"的写入通道 —— uci apply 会对 honk 调 reload，
   而 rc.common 的 reload 默认就是 restart，为一个界面开关重启服务不可接受。 */
var SOURCE_LS = 'honk-panel-source';

/* 错误码 → 页面文案。脚本自己那份 message 是给命令行用的（中文），
   页面用这张表按当前语言显示，无法归类时才回落到 message。 */
var ERRORS = {
	no_dir: _('No panel directory is configured'),
	embedded: _('This build does not embed the panel'),
	bad_dir: _('The configured panel directory is not a usable absolute path'),
	tag_failed: _('Unable to determine the latest release'),
	no_space: _('Not enough free space'),
	busy: _('Another update is already running'),
	download_failed: _('The download failed'),
	checksum_failed: _('The checksum did not match'),
	invalid_archive: _('The downloaded archive is not usable'),
	extract_failed: _('Extracting the archive failed'),
	swap_failed: _('Replacing the panel directory failed'),
	needs_overwrite: _('The panel directory was not installed from this page')
};

var S = {
	state: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:6px 0 0',
	dot: 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle',
	sep: 'color:var(--text-muted);margin:0 5px',
	facts: 'font-size:12px;color:var(--text-color-medium,var(--text-muted));margin-top:4px',
	row: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px',
	label: 'min-width:64px;color:var(--text-muted);font-size:13px',
	value: 'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;word-break:break-all',
	hint: 'font-size:12px;color:var(--text-color-medium,var(--text-muted))',
	actions: 'margin-top:12px;display:flex;flex-wrap:wrap;align-items:center;gap:8px',
	result: 'font-size:12px;margin-top:8px'
};

/* --------------------------------------------------------------- 小工具 */

function cap(s) {
	return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function splitListen(listen) {
	var i = String(listen || '').lastIndexOf(':');

	return i < 0 ? null : { host: listen.slice(0, i), port: listen.slice(i + 1) };
}

function isWildcard(host) {
	return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function isLoopback(host) {
	return host === '::1' || host === '[::1]' || host.indexOf('127.') === 0;
}

function execJson(cmd, args) {
	return fs.exec_direct(cmd, args).then(function(raw) {
		var text = String(raw == null ? '' : raw).trim();

		try {
			return JSON.parse(text || '{}');
		}
		catch (e) {
			throw new Error(_('Unparsable output from %s').format(cmd));
		}
	});
}

/* 用「·」连接一串文本，分隔符单独着色 */
function joinParts(list) {
	var out = [];

	list.forEach(function(t, i) {
		if (!t)
			return;

		if (out.length)
			out.push(E('span', { 'style': S.sep }, '\u00b7'));

		out.push(E('span', {}, t));
	});

	return out;
}

/* 面板地址：allow_origins 唯一项 → allowed_hosts 唯一项 → listen。
   面板自身的路径固定是 /ui/（honk 的挂载点）。 */
function panelUrl(cfg) {
	var l = splitListen(cfg.listen);
	var origins = cfg.allow_origins || [];
	var hosts = cfg.allowed_hosts || [];

	if (origins.length === 1) {
		var o = String(origins[0]).replace(/\/+$/, '');

		if (/^https?:\/\/[^\/]+$/.test(o))
			return { url: o + '/ui/', src: _('from allow_origins') };
	}

	if (hosts.length === 1) {
		var h = String(hosts[0]);

		if (/^[A-Za-z0-9.\-]+$/.test(h) && l)		/* 裸主机名：端口借 listen */
			h += ':' + l.port;

		if (/^[A-Za-z0-9.\-\[\]:]+$/.test(h))
			return {
				url: window.location.protocol + '//' + h + '/ui/',
				src: _('from allowed_hosts (protocol taken from this page)')
			};
	}

	if (!l)
		return null;

	var host = isWildcard(l.host) ? (window.location.hostname || '127.0.0.1') : l.host;
	var src;

	if (origins.length > 1)
		src = _('allow_origins has several entries, so listen is used');
	else if (isLoopback(l.host))
		src = _('from listen (loopback, so it only opens on the router itself)');
	else if (isWildcard(l.host))
		src = _('from listen (wildcard, so the host name of this page is used)');
	else
		src = _('from listen');

	return { url: 'http://%s:%s/ui/'.format(host, l.port), src: src };
}

/* 面板没在提供服务的第一个原因；都正常时返回 null */
function issue(data) {
	var cfg = (data && data.configured) || {};
	var panel = (data && data.panel) || {};

	if (uci.get('honk', 'config', 'enabled') !== '1')
		return { text: _('The honk service is disabled'), page: 'global' };

	if (!cfg.present)
		return { text: _('No native API configuration file was found'), page: 'api' };

	if (cfg.block_present !== true)
		return { text: _('The native_api block is commented out or missing'), page: 'api' };

	if (cfg.enabled !== true)
		return { text: _('The native API listener is disabled'), page: 'api' };

	if (cfg.ui === 'embedded')
		return { text: _('ui is set to embedded, which this build does not provide'), page: 'api' };

	if (!panel.absolute)
		return { text: _('ui is not an absolute path'), page: 'api' };

	if (!panel.exists)
		return { text: _('The panel directory does not exist'), page: 'api' };

	if (!panel.index)
		return { text: _('The panel directory holds no readable index.html'), page: 'api' };

	if (((data || {}).probe || {}).reachable !== true)
		return { text: _('The panel does not answer; native_api changes need a service restart') };

	return null;
}

/* 面板目录名即默认来源：doona 装在默认位置时不需要任何配置 */
function defaultSource(data) {
	var name = (((data || {}).panel || {}).dir || '').replace(/\/+$/, '').split('/').pop();

	return (name === 'doona') ? 'doona' : 'custom';
}

function loadSource(data) {
	var v = null;

	try { v = window.localStorage.getItem(SOURCE_LS); } catch (e) {}

	return (v === 'doona' || v === 'custom') ? v : defaultSource(data);
}

/* --------------------------------------------------------------- 页面 */

return view.extend({
	load: function() {
		return uci.load('honk');
	},

	render: function() {
		var data = null;
		var checked = null;		/* check 结果：null=未取到；失败时 {error:...} */
		var source = 'doona';
		var busy = false;
		var firstLoad = null;		/* 首次探测的 promise，轮询等它落地再续 */

		var stateNode = E('div', { 'style': S.state });
		var factsNode = E('div', { 'style': S.facts });
		var urlNode = E('code', { 'style': S.value });
		var urlSrcNode = E('span', { 'style': S.hint });
		var hintNode = E('div', { 'style': S.hint });
		var resultNode = E('div', { 'style': S.result });

		var openBtn = E('button', {
			'class': 'cbi-button cbi-button-action',
			'type': 'button',
			'click': function() {
				var cfg = (data || {}).configured || {};
				var u = data ? panelUrl(cfg) : null;

				if (u)
					window.open(u.url, '_blank', 'noopener');
			}
		}, _('Open Panel'));

		var updateBtn = E('button', {
			'class': 'cbi-button',
			'type': 'button',
			'click': function() { return handleUpdate(); }
		}, _('Update Panel'));

		var refreshBtn = E('button', {
			'class': 'cbi-button',
			'type': 'button',
			'click': function() { return handleRefresh(); }
		}, _('Refresh Status'));

		var sourceSelect = E('select', {
			'class': 'cbi-input-select',
			'change': function(ev) {
				source = ev.target.value;
				try { window.localStorage.setItem(SOURCE_LS, source); } catch (e) {}
				renderAll();
			}
		}, [
			E('option', { 'value': 'doona' }, _('Doona (default)')),
			E('option', { 'value': 'custom' }, _('Custom'))
		]);

		/* ---------------------------------------------------- 渲染 */

		function showResult(text, isError) {
			dom.content(resultNode, text
				? E('span', {
					'style': 'color:%s'.format(isError ? '#cc3333' : 'var(--text-color-medium,var(--text-muted))')
				}, text)
				: '');
		}

		function renderState() {
			var panel = (data || {}).panel || {};
			var bad = data ? issue(data) : null;
			var name = panel.title ? cap(panel.title) : _('Panel');
			var running = !!data && !bad;

			dom.content(stateNode, [
				E('span', {
					'style': '%s;background:%s'.format(S.dot, running ? '#46a546' : '#cc3333')
				}),
				E('strong', {}, '%s %s'.format(name, running ? _('RUNNING') : _('NOT RUNNING')))
			]);

			var facts = [
				_('Panel directory %s').format(panel.dir || _('unset')),
				panel.version ? _('Version %s').format(panel.version) : _('Version unknown')
			];

			if (!data)
				facts.push(_('Collecting data...'));
			else if (bad)
				facts.push(bad.text);
			else if (source === 'custom')
				facts.push(_('Not updated from this page'));
			else if (!checked)
				facts.push(_('Checking for a newer release...'));
			else if (checked.error)
				facts.push(_('Unable to determine whether a newer release exists'));
			else if (checked.update_available)
				facts.push(_('A newer release is available: %s').format(checked.latest));
			else
				facts.push(_('Up to date'));

			facts.push(((data || {}).configured || {}).secret_configured === true
				? _('Access key configured') : _('No access key configured'));

			dom.content(factsNode, joinParts(facts));
		}

		function renderUrl() {
			var cfg = (data || {}).configured || {};
			var u = data ? panelUrl(cfg) : null;

			dom.content(urlNode, u ? u.url : '\u2014');
			dom.content(urlSrcNode, u ? u.src : '');
		}

		function renderHint() {
			dom.content(hintNode, source === 'doona'
				? _('The panel is fetched from the official release, verified against SHA256SUMS and unpacked over the panel directory. That directory comes from ui in the honk configuration and has to be writable.')
				: _('The panel files are maintained elsewhere. Updating replaces the contents of the directory with the official release after a confirmation. Set ui on the API Settings page to the absolute path of the directory, with a readable index.html in it and the fonts in a fonts subdirectory next to it.'));
		}

		function renderButtons() {
			var panel = (data || {}).panel || {};
			var canUpdate = !!data && panel.absolute === true;

			updateBtn.disabled = busy || !canUpdate;
			updateBtn.title = canUpdate ? '' : _('Set a panel directory on the API Settings page first');
			updateBtn.textContent = busy ? _('Updating...') : _('Update Panel');

			refreshBtn.disabled = busy;
			openBtn.disabled = !data || panelUrl((data || {}).configured || {}) == null;
		}

		function renderAll() {
			sourceSelect.value = source;
			renderState();
			renderUrl();
			renderHint();
			renderButtons();
		}

		/* ---------------------------------------------------- 动作 */

		function reportError(res) {
			if (res.error === 'no_space' && res.free_kb != null)
				return [
					_('Not enough free space: %s KB available, %s KB required').format(res.free_kb, res.need_kb),
					' ', E('code', {}, '(%s)'.format(res.dir || ''))
				];

			var head = ERRORS[res.error] || _('The update failed');

			return [ head, ' ', E('code', {}, '(%s)'.format(res.error || 'unknown')) ];
		}

		function runUpdate(extra) {
			busy = true;
			showResult(_('Downloading and verifying the release. This can take a while.'));
			renderButtons();

			return execJson(UPDATE, [ '--action', 'update' ].concat(extra)).then(function(res) {
				busy = false;

				if (!res.ok) {
					dom.content(resultNode, E('span', {
						'style': 'color:#cc3333'
					}, reportError(res)));
					renderButtons();
					return null;
				}

				showResult(_('Panel updated to version %s.').format(res.to || ''));
				checked = { latest: res.to, update_available: false };
				return probe(true);
			}).catch(function(err) {
				busy = false;
				showResult(err && err.message ? err.message : String(err), true);
				renderButtons();
			});
		}

		function confirm(title, body, okLabel, onOk) {
			ui.showModal(title, [
				E('p', {}, body),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': function() { ui.hideModal(); }
					}, _('Cancel')),
					' ',
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'click': function() {
							ui.hideModal();
							onOk();
						}
					}, okLabel)
				])
			]);
		}

		function handleUpdate() {
			if (busy)
				return null;

			var panel = (data || {}).panel || {};
			var dir = panel.dir || '';

			if (source === 'custom')
				return confirm(_('Overwrite the panel directory?'),
					_('Updating replaces the contents of %s with the official release and keeps no copy of the current files.').format(dir),
					_('Continue'),
					function() { runUpdate([ '--overwrite' ]); });

			/* 默认来源下目录却没有本页的标记：多半是目录被手工放进去的，
			   多问一次，避免覆盖掉用户自己的文件 */
			if (panel.exists === true && panel.managed === false)
				return confirm(_('Overwrite the panel directory?'),
					_('The directory %s was not installed from this page. Updating replaces its contents with the official release and keeps no copy of the current files.').format(dir),
					_('Update anyway'),
					function() { runUpdate([ '--overwrite' ]); });

			return runUpdate([]);
		}

		/* 探测；withCheck 为真时再取一次最新版本号（要直连 github.com，失败不影响状态显示） */
		function probe(withCheck) {
			return execJson(PROBE).then(function(res) {
				data = res;
				renderAll();

				if (!withCheck)
					return null;

				return execJson(UPDATE, [ '--action', 'check' ]).then(function(c) {
					checked = c.ok ? c : { error: c.error || 'check_failed' };
				}).catch(function() {
					checked = { error: 'unreachable' };
				}).then(renderState);
			}).catch(function(err) {
				data = null;
				renderAll();
				showResult(err && err.message ? err.message : String(err), true);
				return null;
			});
		}

		function handleRefresh() {
			checked = null;
			showResult('');
			renderState();
			return probe(true);
		}

		/* 首次：探测先出画面，乐观地按空配置渲染一帧；随后按目录名定来源并取版本号 */
		firstLoad = probe(false).then(function() {
			source = loadSource(data);
			renderAll();
			return handleRefresh();
		});

		poll.add(function() {
			return firstLoad.then(function() {
				if (!busy)
					return probe(false);
			});
		}, 10);

		return E('div', { 'class': 'cbi-map', 'id': 'cbi-honk-webui' }, [
			E('h2', { 'name': 'content' }, _('WebUI')),
			E('div', { 'class': 'cbi-map-descr' }, _('Address, status and updates for the panel. Updating the panel needs no service restart; the first install, and any change to the panel directory (ui), needs one.')),
			E('div', { 'class': 'cbi-section' }, E('div', { 'class': 'cbi-section-node' }, [
				stateNode,
				factsNode,
				E('div', { 'style': S.row }, [
					E('span', { 'style': S.label }, _('Panel address')),
					urlNode, urlSrcNode
				]),
				E('div', { 'style': S.row }, [
					E('span', { 'style': S.label }, _('Update source')),
					sourceSelect
				]),
				E('div', { 'style': S.actions }, [ updateBtn, refreshBtn, openBtn ]),
				hintNode,
				resultNode
			]))
		]);
	}
});
