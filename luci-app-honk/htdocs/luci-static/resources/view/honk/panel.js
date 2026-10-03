'use strict';
'require view';
'require fs';
'require uci';
'require ui';
'require dom';
'require poll';

/*
 * Panel —— 面板（doona）的状态与在线更新。
 *
 * 面板不嵌在本页里（X-Frame-Options: DENY，且 https 页面里的 http iframe 会被拦），只在新标签页打开。
 * 状态探测与更新都在路由器侧执行（honk-native-api-probe / honk-panel-update），本页只渲染它们的 JSON。
 * 样式一律内联，不注入 <style>：aurora 把写进 head 的样式判为文档污染。
 */

var PROBE = '/usr/libexec/honk-native-api-probe';
var UPDATE = '/usr/libexec/honk-panel-update';

/* 「更新来源」是浏览器侧偏好，不落 uci（uci apply 会对 honk 调 reload，而 reload 默认是 restart） */
var SOURCE_LS = 'honk-panel-source';

/* 更新脚本写的进度文件（tmpfs，几十字节） */
var PROG_STAGE = '/tmp/honk-panel-progress.stage';
var PROG_BYTES = '/tmp/honk-panel-progress.bytes';

var STAGE_TEXT = {
	'download-program': _('Downloading the panel package...'),
	'download-fonts': _('Downloading the fonts...'),
	'download-sums': _('Downloading the checksum list...'),
	'verify': _('Verifying checksums...'),
	'extract': _('Extracting...'),
	'swap': _('Replacing the panel directory...')
};

/* 错误码 → 页面文案（脚本里那份 message 是给命令行看的） */
var ERRORS = {
	no_dir: _('No panel directory is configured'),
	embedded: _('The embedded panel comes with the core and is not updated from this page.'),
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

/* rpcd 的 exec 没有超时，一旦不返回页面会永远吊住 */
function withTimeout(promise, ms, what) {
	return new Promise(function(resolve, reject) {
		var t = window.setTimeout(function() {
			reject(new Error(_('%s timed out after %s seconds').format(what, Math.round(ms / 1000))));
		}, ms);

		promise.then(function(v) {
			window.clearTimeout(t);
			resolve(v);
		}, function(e) {
			window.clearTimeout(t);
			reject(e);
		});
	});
}

/* 从 curl 进度条里取最后一个百分比 */
function lastPercent(blob) {
	var s = String(blob == null ? '' : blob);
	var i = s.lastIndexOf('%');

	if (i < 0)
		return null;

	var j = i;

	while (j > 0) {
		var c = s.charAt(j - 1);

		if ((c >= '0' && c <= '9') || c === '.')
			j--;
		else
			break;
	}

	var v = s.slice(j, i);

	if (!v)
		return null;

	var n = parseFloat(v);

	return isNaN(n) ? null : Math.round(n);
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

/* 面板地址要跟当前访问方式对齐：IP 访问给 IP，域名访问给域名 */
function currentHost() {
	return String(window.location.hostname || '') +
		(window.location.port ? ':' + window.location.port : '');
}

/* 'https://dae.example.com' / 'dae.example.com:9527' → 'dae.example.com[:port]' */
function originHost(s) {
	var m = /^[a-z]+:\/\/(.+)$/i.exec(String(s || '').trim().replace(/\/+$/, ''));

	return m ? m[1] : String(s || '').trim().replace(/\/+$/, '');
}

/* 当前是否用 IP / localhost / IPv6 字面量访问（不用正则：jsmin 的教训） */
function isLocalHostName(name) {
	var s = String(name || '');

	if (!s)
		return false;

	if (s === 'localhost' || s.charAt(0) === '[')
		return true;

	for (var i = 0; i < s.length; i++) {
		var c = s.charAt(i);

		if ((c < '0' || c > '9') && c !== '.')
			return false;
	}

	return true;
}

/* 只有带 scheme 的条目才能直接当 URL 用（不用正则：jsmin 会把正则里的 // 当注释删掉） */
function originUrl(s) {
	var v = String(s || '').trim().replace(/\/+$/, '');

	return v.indexOf('://') > 0 ? v + '/ui/' : null;
}

/* 面板地址：优先用命中当前 host 的 allow_origins / allowed_hosts；否则 IP 访问按 listen 推导、
   域名访问用配置里的对外地址；都没有再退回 listen */
function panelUrl(cfg) {
	var l = splitListen(cfg.listen);
	var origins = cfg.allow_origins || [];
	var hosts = cfg.allowed_hosts || [];
	var cur = currentHost();
	var ext = (origins.length === 1) ? originUrl(origins[0]) : null;

	if (ext && originHost(origins[0]) === cur)
		return { url: ext, src: _('matches how you opened this page') };

	if (hosts.length === 1 && String(hosts[0]) === cur)
		return {
			url: window.location.protocol + '//' + cur + '/ui/',
			src: _('matches how you opened this page')
		};

/* IP 访问：同网段里 监听地址 + 端口 直接可用 */
	if (l && isLocalHostName(window.location.hostname)) {
/* 回环监听：有对外地址就用它，否则如实提示只能从路由器本机打开 */
		if (isLoopback(l.host)) {
			if (ext)
				return { url: ext, src: _('from allow_origins') };

			return {
				url: 'http://%s:%s/ui/'.format(l.host, l.port),
				src: _('from listen (loopback, so it only opens on the router itself)')
			};
		}

		return {
			url: 'http://%s:%s/ui/'.format(
				isWildcard(l.host) ? (window.location.hostname || '127.0.0.1') : l.host, l.port),
			src: _('LAN address (from listen)'),
			alt: ext
		};
	}

/* 域名访问：域名是前置反代，裸监听端口未必对它开放，用配置里的对外地址 */
	if (ext)
		return { url: ext, src: _('from allow_origins') };

	if (hosts.length === 1)
		return {
			url: window.location.protocol + '//' + hosts[0] + '/ui/',
			src: _('from allowed_hosts (protocol taken from this page)')
		};

	/* ④ 配置里也没有对外地址：退回监听地址本身 */
	if (!l)
		return null;

	return {
		url: 'http://%s:%s/ui/'.format(
			isWildcard(l.host) ? (window.location.hostname || '127.0.0.1') : l.host, l.port),
		src: isLoopback(l.host)
			? _('from listen (loopback, so it only opens on the router itself)')
			: _('from listen')
	};
}

/* 内嵌面板判据：优先用探测给的 ui_kind，旧探测没有该字段时退回比较 ui 字符串。
   embedded 与目录模式都由 honk 在 /ui/ 提供，所以"能不能用"一律以探测结果为准，
   不再假定某个构建里一定没有内嵌面板。 */
function isEmbedded(cfg) {
	cfg = cfg || {};

	return cfg.ui_kind === 'embedded' || (cfg.ui_kind == null && cfg.ui === 'embedded');
}

/* 面板没在服务的第一个原因，正常时返回 null（不看本机探测：Host 校验会造成误报） */
function issue(data) {
	var cfg = (data && data.configured) || {};
	var panel = (data && data.panel) || {};

	if (uci.get('honk', 'config', 'enabled') !== '1')
		return { text: _('The honk service is disabled'), page: 'global',
			link: _('Enable it on the General Settings page') };

	if (!cfg.present)
		return { text: _('No native API configuration file was found'), page: 'api',
			link: _('Open the Panel config block') };

	if (cfg.block_present !== true)
		return { text: _('The native_api block is commented out or missing'), page: 'api',
			link: _('Open the Panel config block') };

	if (cfg.enabled !== true)
		return { text: _('The native API listener is disabled'), page: 'api',
			link: _('Open the Panel config block') };

/* 内嵌面板：可用性由探测决定（探得到 /ui/ 就说明这份核心在提供面板），
   探不到时才回退到"服务没跑"或"核心可能不含 native-ui"这两种可解释的原因 */
	if (isEmbedded(cfg)) {
		if (((data || {}).probe || {}).reachable === true)
			return null;

		if (((data || {}).service || {}).running !== true)
			return { text: _('The honk service is not running'), page: 'global',
				link: _('Start it on the General Settings page') };

		return {
			text: _('The embedded panel did not answer; the running core may lack native-ui'),
			page: 'api', field: 'ui', link: _('Open the Panel config block')
		};
	}

	if (!panel.absolute)
		return { text: _('ui is not an absolute path'), page: 'api',
			field: 'ui', link: _('Set ui on the Panel config block') };

	if (!panel.exists)
		return { text: _('The panel directory does not exist'), page: 'api',
			field: 'ui', link: _('Set ui on the Panel config block') };

	if (!panel.index)
		return { text: _('The panel directory holds no readable index.html'), page: 'api',
			field: 'ui', link: _('Set ui on the Panel config block') };

	if (((data || {}).service || {}).running !== true)
		return { text: _('The honk service is not running'), page: 'global',
			link: _('Start it on the General Settings page') };

	return null;
}

/* 「去哪修」：跳到常规设置页，必要时带上 ?block= 与 ?focus= */
function fixUrl(page, field) {
	var u = L.url('admin/services/honk/general');

	if (page !== 'api')
		return u;

	return u + '?block=api' + (field ? '&focus=' + field : '');
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
		var busy = false;		/* 正在跑 update */
		var checking = false;		/* 正在跑 check（防并发堆积） */
		var progressTimer = null;
		var progressBusy = false;
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
			/* 探测不到 panel.title（例如目录不存在）时退回默认面板名 doona */
			var name = panel.title ? cap(panel.title) : 'Doona';
			var running = !!data && !bad;

			/* 探测还没回来：给灰点 + 收集中，别让状态行/事实行留白 */
			if (!data) {
				dom.content(stateNode, [
					E('span', { 'style': '%s;background:#b0b0b0'.format(S.dot) }),
					E('strong', {}, _('Collecting data...'))
				]);
				dom.content(factsNode, joinParts([ _('Collecting data...') ]));
				return;
			}

			dom.content(stateNode, [
				E('span', {
					'style': '%s;background:%s'.format(S.dot, running ? '#46a546' : '#cc3333')
				}),
				E('strong', {}, '%s %s'.format(name, running ? _('RUNNING') : _('NOT RUNNING')))
			]);

			/* 内嵌模式没有面板目录，版本改取核心自己的构建号（探测从日志首行取得） */
			var embedded = isEmbedded((data || {}).configured || {});
			var version = embedded
				? (((data || {}).service || {}).core_version || '')
				: (panel.version || '');

			var facts = [
				embedded ? _('Embedded panel (served by the core)')
					: _('Panel directory %s').format(panel.dir || _('unset')),
				version ? _('Version %s').format(version) : _('Version unknown')
			];

			if (bad) {
				facts.push(bad.link
					? [ bad.text, ' ', E('a', { 'href': fixUrl(bad.page, bad.field) }, bad.link) ]
					: bad.text);
			}
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

/* 运行中但本机探测无回应：多半是 allowed_hosts 的 Host 校验，如实提一句 */
			if (data && !bad && ((data.probe || {}).reachable !== true))
				facts.push(_('The local probe got no answer'));

			dom.content(factsNode, joinParts(facts));
		}

		function renderUrl() {
			var cfg = (data || {}).configured || {};
			var u = data ? panelUrl(cfg) : null;
			var note = u ? u.src : '';

			dom.content(urlNode, u ? u.url : '\u2014');
			dom.content(urlSrcNode, u
				? [ note,
				    u.alt ? E('span', { 'style': S.sep }, '\u00b7') : null,
				    u.alt ? _('external: %s').format(u.alt) : null ].filter(function(v) { return v != null; })
				: '');
		}

		function renderHint() {
			dom.content(hintNode, isEmbedded((data || {}).configured || {})
				? _('The embedded panel comes with the core and is not updated from this page.')
				: (source === 'doona'
					? _('The panel is fetched from the official release, verified against SHA256SUMS and unpacked over the panel directory. That directory comes from ui in the honk configuration and has to be writable.')
					: _('The panel files are maintained elsewhere. Updating replaces the contents of the directory with the official release after a confirmation. Set ui on the Panel config block to the absolute path of the directory, with a readable index.html in it and the fonts in a fonts subdirectory next to it.')));
		}

		function renderButtons() {
			var panel = (data || {}).panel || {};
			var canUpdate = !!data && panel.absolute === true;
			var embedded = isEmbedded((data || {}).configured || {});

			updateBtn.disabled = busy || !canUpdate;
			updateBtn.title = canUpdate ? ''
				: (embedded
					? _('The embedded panel comes with the core and is not updated from this page.')
					: _('Set a panel directory on the Panel config block first'));
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

		/* ---- 更新进度：读脚本写的两个小文件（1.5s 一拍，单飞防堆积）---- */

		function renderProgress(stage, percent) {
			var text = STAGE_TEXT[stage] || _('Starting...');

			dom.content(resultNode, E('span', {
				'style': 'color:var(--text-color-medium,var(--text-muted))'
			}, percent == null ? text : text + ' ' + percent + '%'));
		}

		function startProgress() {
			stopProgress();
			renderProgress('', null);

			progressTimer = window.setInterval(function() {
				if (progressBusy)		/* 上一拍还没回来就跳过，别把 rpcd 的 exec 堆起来 */
					return;

				progressBusy = true;

				Promise.all([
					fs.read(PROG_STAGE).catch(function() { return null; }),
					fs.read(PROG_BYTES).catch(function() { return null; })
				]).then(function(r) {
					progressBusy = false;
					renderProgress(String(r[0] == null ? '' : r[0]).trim(), lastPercent(r[1]));
				}, function() {
					progressBusy = false;
				});
			}, 1500);
		}

		function stopProgress() {
			if (progressTimer != null) {
				window.clearInterval(progressTimer);
				progressTimer = null;
			}

			progressBusy = false;
		}

		function runUpdate(extra) {
			busy = true;
			startProgress();
			renderButtons();

/* 兜底超时：避免真卡住时按钮永远停在「更新中…」 */
			return withTimeout(execJson(UPDATE, [ '--action', 'update' ].concat(extra)),
				900000, _('Panel update')).then(function(res) {
				busy = false;
				stopProgress();

				/* 脚本侧也有同样的闸门（已是最新且目录健康 ⇒ 不下载），这里负责显示出来 */
				if (res.ok && res.skipped) {
					showResult(_('Up to date (version %s); nothing to do.').format(res.to || ''));
					checked = { latest: res.to, update_available: false };
					return probe(false);
				}

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
				stopProgress();
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

/* 已是最新且目录健康：那 12 MB 都不下（脚本侧同样会拦，这里给即时反馈） */
			if (panel.index === true && checked && checked.ok === true && checked.update_available === false) {
				showResult(_('Up to date (version %s); nothing to do.')
					.format(checked.latest || panel.version || ''));
				return null;
			}

			if (source === 'custom')
				return confirm(_('Overwrite the panel directory?'),
					_('Updating replaces the contents of %s with the official release and keeps no copy of the current files.').format(dir),
					_('Continue'),
					function() { runUpdate([ '--overwrite' ]); });

/* 默认来源但目录没有本页标记：多半是手工放进去的，多问一次避免覆盖用户文件 */
			if (panel.exists === true && panel.managed === false)
				return confirm(_('Overwrite the panel directory?'),
					_('The directory %s was not installed from this page. Updating replaces its contents with the official release and keeps no copy of the current files.').format(dir),
					_('Update anyway'),
					function() { runUpdate([ '--overwrite' ]); });

			return runUpdate([]);
		}

		/* 探测；withCheck 为真时再取一次最新版本号（要访问 github.com，失败不影响状态显示） */
		function probe(withCheck) {
			return withTimeout(execJson(PROBE), 20000, _('Status probe')).then(function(res) {
				data = res;
				renderAll();

				if (!withCheck)
					return null;

				return runCheck();
			}).catch(function(err) {
				data = null;
				renderAll();
				showResult(err && err.message ? err.message : String(err), true);
				return null;
			});
		}

/* 版本检查要访问外网：同一时刻只允许一个在飞，避免连点堆起一串 curl */
		function runCheck() {
			if (checking)
				return Promise.resolve(null);

			checking = true;
			renderState();

			return withTimeout(execJson(UPDATE, [ '--action', 'check' ]), 60000, _('Version check'))
				.then(function(c) {
					checked = c.ok ? c : { error: c.error || 'check_failed' };
				})
				.catch(function() {
					checked = { error: 'unreachable' };
				})
				.then(function() {
					checking = false;
					renderState();
					return null;
				});
		}

		function handleRefresh() {
			checked = null;
			showResult('');
			renderState();
			return probe(true);
		}

/* 先渲染「什么都没拿到」的一帧，再让探测回来覆盖，避免首屏一排空标签 */
		renderAll();

		/* 首次：探测先出画面，随后按目录名定来源并取版本号 */
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
			E('h2', { 'name': 'content' }, _('Panel')),
			E('div', { 'class': 'cbi-map-descr' }, _('Panel status and online updates')),
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
