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
	}
});
