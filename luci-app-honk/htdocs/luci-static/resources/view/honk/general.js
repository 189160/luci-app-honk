'use strict';
'require form';
'require honk.editor as heditor';

/*
 * General Settings —— 一个页签承载 5 个配置块（全局 / 解析 / 节点 / 路由 / 面板）。
 * 页签标题与描述固定；当前编辑哪一块由「配置块」下拉与编辑器标题体现。
 */

return heditor.editorPage({
	title: _('General Settings'),
	description: _('HONK global switches and configuration'),
	blocks: [
		{
			key: 'config',
			/* 原来挂在编辑器上的「include 说明」并进本块描述：合并后编辑器区不再单独放描述 */
			description: _('Configure global settings for HONK. Configure the include field correctly for separate config to work, or enter the complete configuration here.'),
			editorTitle: _('Global Configuration')
		},
		{
			key: 'dns',
			description: _('Configure DNS settings for HONK.'),
			editorTitle: _('DNS Configuration')
		},
		{
			key: 'node',
			description: _('Configure nodes and groups for HONK.'),
			editorTitle: _('Node Configuration')
		},
		{
			key: 'route',
			description: _('Configure routing rules for HONK.'),
			editorTitle: _('Route Configuration')
		},
		{
			key: 'api',
			description: _('Configure the panel. Editing this configuration requires a service restart to take effect.'),
			editorTitle: _('Panel Configuration'),
			/* 服务动作为「重启」而非热重载：native_api 的生效字段（enabled / listen / secret /
			   ui / config_write / record_* / allowed_hosts / allow_origins…）全都不支持热改，
			   honk 收到 SIGHUP 会忽略这些变更并保留当前 listener（不是报错）。 */
			reloadAction: 'restart',
			reloadNowLabel: _('Restart Now'),
			reloadOk: _('Service restarted successfully'),
			reloadFail: _('Restart failed: %s')
		}
	],
	uciSection: function(section) {
		var enable = section.option(form.Flag, 'enabled', _('Start Service'));
		enable.rmempty = false;

		/*
		 * 控件的真假观必须与 heditor.normalizeEnabled() 一致。
		 *
		 * form.Flag 渲染 checkbox 时是拿 cfgvalue 与 value_enabled('1') 直接比
		 * （form.js: render() → cfgvalue(section_id) → renderWidget → new ui.Checkbox(cfgvalue,
		 *  { value_enabled: '1' })；ui.js: 'checked': (this.value == this.options.value_enabled)）。
		 * 而配置里 enabled 可能是 'on'/'true'/'yes' 这类 config_get_bool 认、控件不认的值：
		 * 那样界面显示**未勾选**，用户做任何无关编辑保存就把 fval='0' 写回，并把「没变」误判成
		 * 「变了」而去停服务；v2 走 commit 后这个改写还会落盘成持久修改。
		 * 归一化后：非规范值也显示为已勾选，且 fval == cval ⇒ 不写、不判变、不停服务。
		 *
		 * 注意 cfgvalue 同时是 getter(1 参) 与 setter(2 参)：load() 走的是 2 参 setter
		 * （form.js 的 section.load() 里 `children[i].cfgvalue(section_id, set_values[i])`），
		 * 必须原样转发，否则载入的值存不进去。
		 */
		var baseCfgvalue = form.Flag.prototype.cfgvalue;

		enable.cfgvalue = function(section_id, set_value) {
			if (arguments.length == 2)
				return baseCfgvalue.call(this, section_id, set_value);

			return heditor.normalizeEnabled(baseCfgvalue.call(this, section_id));
		};
	}
});
