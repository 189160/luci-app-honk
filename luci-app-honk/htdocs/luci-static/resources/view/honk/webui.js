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

/* 更新脚本写的进度文件（tmpfs，几十字节）：
   .stage 是阶段名，.bytes 是 curl -# 的进度条输出（页面只取里面最后一个百分比）。 */
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

/* rpcd 侧的 exec 没有超时：一旦某个调用不返回，页面会永远吊在那里
   （症状就是"一直显示收集数据…"）。所以每个 exec 都套一层客户端超时。 */
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

/* 从 curl 进度条里取最后一个百分比。
   ⚠️ 刻意用字符串操作而不是正则：luci.mk 打包时用 jsmin 压缩，它不认识正则字面量，
   正则里一旦出现 // 或 /* 就会被当成注释删掉（r29 就是这么炸的）。 */
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

/* 当前访问 LuCI 的 host[:port]：面板地址要跟它对齐 —— 你在 IP 上访问就给 IP，
   在域名上访问才给域名（用户明确要求：IP 访问时不该显示域名）。 */
function currentHost() {
	return String(window.location.hostname || '') +
		(window.location.port ? ':' + window.location.port : '');
}

/* 'https://dae.example.com' / 'dae.example.com:9527' → 'dae.example.com[:port]' */
function originHost(s) {
	var m = /^[a-z]+:\/\/(.+)$/i.exec(String(s || '').trim().replace(/\/+$/, ''));

	return m ? m[1] : String(s || '').trim().replace(/\/+$/, '');
}

/* 当前是不是用 IP（或 localhost）在访问 LuCI。
   IPv4 字面量 = 全是数字和点；IPv6 字面量在 location.hostname 里带方括号；localhost 同理按"直达"算。
   ⚠️ 不用正则（jsmin 的教训）。 */
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

/* 只有带 scheme 的条目才能直接当 URL 用。
   ⚠️ 这里刻意不用正则：luci.mk 用 Crockford 的 jsmin 压缩 htdocs 下的 JS，
   而 jsmin **不认识正则字面量** —— 写成 /^[a-z]+:\/\//i 时，"结尾的 / 紧跟在 \/ 之后"
   会在源码里凑出一个字面的 `//`，被 jsmin 当成行注释删到行尾，产出的文件语法错误
   （V8 报 Invalid regular expression: missing /，且只在设备上复现）。
   所以判定 scheme 用字符串查找，别引入任何"正则里出现 // 或 /*"的写法。 */
function originUrl(s) {
	var v = String(s || '').trim().replace(/\/+$/, '');

	return v.indexOf('://') > 0 ? v + '/ui/' : null;
}

/* 面板地址。优先级 = 「你此刻怎么访问 LuCI」，并按 IP / 域名分叉：
   ① 当前 host 就在 allow_origins / allowed_hosts 里 → 用那一条（这条路你正在用）
   ② 用 IP / localhost 访问 → 按 listen 推导（通配就用当前主机名 = 那个 IP）
   ③ 用域名访问 → 用 native_api 里配的对外地址（allow_origins → allowed_hosts）；
      域名是前置反代，现编 `http://<该域名>:<端口>/ui/` 多半不通
   ④ 配置里也没有对外地址 → 退回 listen 推导
   另外：走 ② 而 allow_origins 有唯一项时，把它作为「对外」附注给出。 */
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

	/* ② 用 IP / localhost 访问 LuCI：同一张网里，监听地址 + 端口直接可用（"IP 访问就给 IP"）。
	      listen 是通配时用当前的主机名（也就是那个 IP），否则用 listen 里写死的地址。 */
	if (l && isLocalHostName(window.location.hostname)) {
		/* 回环监听：只有反代能到达本机 —— 有对外地址就用它；没有就如实说"只能在路由器上打开"，
		   别把它标成"局域网地址"（那个地址在别的机器上连不通）。 */
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

	/* ③ 用域名访问 LuCI：域名是前置反代，裸监听端口未必对它开放 ——
	      这时该用 native_api 里配好的对外地址（allow_origins / allowed_hosts），而不是现编一个
	      http://<这个域名>:<端口>/ui/。 */
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

/* 面板没在提供服务的第一个原因；都正常时返回 null。
   ⚠️ 这里**不看**本机 HTTP 探测结果：探测失败可能是 allowed_hosts 的 Host 校验造成的误报
   （busybox 的 wget/uclient-fetch 改不了 Host 头），而面板到底能不能打开，点「打开面板」最准。 */
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

	if (((data || {}).service || {}).running !== true)
		return { text: _('The honk service is not running'), page: 'global' };

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
			var name = panel.title ? cap(panel.title) : _('Panel');
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

			var facts = [
				_('Panel directory %s').format(panel.dir || _('unset')),
				panel.version ? _('Version %s').format(panel.version) : _('Version unknown')
			];

			if (bad)
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

			/* 运行中但本机探测没回应：多半是 allowed_hosts 的 Host 校验（探测脚本改不了 Host 头），
			   如实提一句，别让它伪装成「未运行」 */
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

			/* 更新要下载 ~12 MB（脚本内每个 curl 有自己的 --max-time），这里只做兜底，
			   避免真卡住时按钮永远停在「更新中…」 */
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

			/* 已是最新且面板目录健康 ⇒ 连那 12 MB 都不下（脚本侧同样会拦，这里是即时反馈）。
			   目录缺 index.html 时不走这条 —— 那正是要用官方 release 修的场景。 */
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

			/* 默认来源下目录却没有本页的标记：多半是目录被手工放进去的，
			   多问一次，避免覆盖掉用户自己的文件 */
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

		/* 版本检查要访问外网，可能很慢；同一时刻只允许一个在飞，
		   否则连点「刷新状态」会堆起一串 curl，把 rpcd 的 exec 拖住（连带其它页签一起卡）。 */
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

		/* 先按「什么都没拿到」渲染一帧（灰点 + 收集数据…）+ 占位地址，
		   再让探测回来覆盖：否则首屏会是一排空标签 */
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
