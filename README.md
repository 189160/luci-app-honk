# luci-app-honk（自建仓库 · 仅 apk）

> License: **AGPL-3.0-only**（[LICENSE](./LICENSE)）

OpenWrt 上 [honk](https://github.com/daeuniverse/honk)（eBPF 透明代理引擎，dae 兼容）的自建打包仓库，只产出 **apk**（OpenWrt 25.x apk 体系）。

## 构成

| 部分 | 说明 |
| --- | --- |
| 核心包 `honk` | 直接取上游 Release 的预编译静态 musl 二进制 `honk-core`，按架构下载（x86_64 / aarch64） |
| LuCI 包 `luci-app-honk` | JS 版界面（`htdocs/` 客户端视图 + `root/usr/share/luci/menu.d/` + `rpcd/acl.d/`），菜单显示名 **HONK**，不依赖 `luci-compat` |
| `update-honk` 工作流 | 每日检查上游新 Release，自动同步版本与校验和并触发构建 |

### 相对上游的调整

- **只出 apk**；
- **不依赖 `vmlinux-btf`**：移除条件依赖与 choice，固定使用内核自带 BTF；
- **geo 数据**：依赖 `v2ray-geoip` / `v2ray-geosite`，安装脚本在 `/usr/share/honk` 自动建立软链；
- **启动脚本**：新增 `/var/log/honk/honk.log` 三代轮转，不再劫持 `/tmp/resolv.conf`（上游从不创建日志文件）。
- **启动脚本的权限收紧**：`/etc/honk` 收紧为 750/640，`state` 子树单独 0700/0600（该目录不可被同组访问，否则 honk 启动报 `state database path is unsafe`）。
- **启动脚本不预建内核资源**：`dae0` / `dae0peer` / `/run/netns/daens` 由 honk 自建自清。

## 安装

### 一键安装（apk）

```sh
curl -fsSL "https://raw.githubusercontent.com/498777/luci-app-honk/main/Auto_Install_Script.sh" | sh -s luci-app-honk
```

默认安装 `honk` + `luci-app-honk` + 中文语言包；`sh -s honk` 只装主程序。

脚本行为：非 apk 体系直接退出；未发现内核 BTF 时给出提示；从 Release 拉取 `SHA256SUMS` 并对每个下载的 apk 做 sha256 校验（Release 未附校验文件时跳过并提示）；**不对下载的 apk 做任何改写**（`vmlinux-btf` 依赖由 CI 的 Makefile 断言保证，见 build-apk.yml 的 Assert 步骤）；安装完成后自动刷新 LuCI 缓存。其余参数（`--repo`、`--no-proxy`、`--gh-proxy`、`--force` 等）见脚本 `-h`。

### 手动安装与启用

```sh
apk add honk luci-app-honk luci-i18n-honk-zh-cn

uci set honk.config.enabled=1 && uci commit honk
/etc/init.d/honk start
```

### 前提与平台

- **BTF**：honk 是 eBPF CO-RE 程序，内核需开启 `CONFIG_DEBUG_INFO_BTF`（官方 24.10+ 的 x86_64 / armsr 默认开启）。未开启时 honk 可安装但无法启动；CI 有 Assert 步骤保证产物不含 `vmlinux-btf` 依赖。
- **cgroup v2 与 bpffs**：`pname(...)` 与 map pin 各自依赖，固件启动时已挂载，无需处理；缺失时 honk 日志出现 `cgroup2 not available` 或 `pin '<名称>'`。
- **架构**：上游只提供 x86_64 与 aarch64 的预编译静态二进制，包以 `@(x86_64||aarch64)` 限制架构。

## LuCI 界面

安装后 **服务 → HONK** 下为七个页签（JS 客户端渲染，`htdocs/luci-static/resources/view/honk/*.js`）。编辑器页顶部是运行状态卡片（每 3 秒刷新），下面一张卡片里依次是 uci 启用开关、服务动作按钮、代码编辑器。编辑器页都带 CodeMirror（`.dae` 语法高亮、代码折叠、括号匹配与自动补全、当前行高亮、格式化代码），底部为 Save / Save & Apply / Reset 三个按钮：

| 页签 | 内容 |
| --- | --- |
| Global Settings | uci 启用开关 + `/etc/honk/config.dae`（编辑器） |
| DNS Settings | `/etc/honk/config.d/dns.dae`（编辑器） |
| Node Settings | `/etc/honk/config.d/node.dae`（编辑器，节点 / 订阅 / 分组） |
| Routing Settings | `/etc/honk/config.d/route.dae`（编辑器） |
| Logs | `/var/log/honk/honk.log`（实时日志，末尾 1000 行） |
| API Settings | `/etc/honk/config.d/api.dae`（编辑器，`native_api` / `clash_api`） |
| WebUI | 面板的地址、状态与更新（面板在新标签页打开，不嵌在本页） |

**WebUI 页**显示面板地址、运行状态、目录与版本，并提供「更新面板」与「刷新状态」。

面板在**新标签页**打开，不嵌在本页，原因有三条：跨源 iframe 被 `X-Frame-Options` / CSP 拒绝时浏览器
不给任何反馈，只会渲染空白；本页走 https 而面板走 http 时 iframe 还会命中混合内容拦截；
doona 的玻璃主题自带一张 `position:fixed` + `backdrop-filter` 的遮罩层（`.rp-shell:after`），
在部分浏览器上会盖住面板内容。顶层新标签页不受前两条限制，第三条也只在面板自己的文档里发生。

地址由 `/usr/libexec/honk-native-api-probe` 交出原始字段后推导：`allow_origins` 唯一项 →
`allowed_hosts` 唯一项 → `listen`（具体 IP 用它 / 通配监听取当前访问的主机名 / 回环地址只能在路由器本机打开）。

**更新面板**由 `/usr/libexec/honk-panel-update` 执行（root，经 rpcd 调用）：目标目录取自 `ui`，
只接受绝对路径，因此页面显示的目录与脚本写入的目录天然一致，脚本也不接受任何 URL 或路径参数。
更新源固定为 `Zakkaus/doona` 的最新 release，程序包与字体包解到同一个 staging 目录后原子替换；
目录已存在且没有本页写的 `.honk-panel.json` 标记时，必须带 `--overwrite` 才允许覆盖。
替换面板目录内容不需要重启服务；首次安装、或改动 `ui` 的值需要重启。

版本号要**直连** `github.com` 取（加速站如 ghfast.top 只镜像资产下载，不转发 release 页面与 API），
资产下载走 `uci honk.config.gh_proxy`，默认 `https://ghfast.top`，置空即直连。

**让 doona 的面板内编辑可用**：需要 `config_write: true` + 非空 `secret`（或密码模式），否则所有配置源都是只读。
随包附带 `/etc/honk/config.d/api.dae` —— 一份精简的 `native_api` 配置参考（`enabled: false`，默认不启动监听）。
它是 conffile，升级不会覆盖用户改动；启用时把 `enabled` 改为 `true`、填好 `secret`，再**重启服务**。

该文件一旦启用，会因为含 `secret` 而在 doona 面板里显示为**只读**——这是 honk 的硬规则：

```
writable = config_write && credentialed()
        && !source.contains_api_secret        // 块内有 secret 键
        && !正文里真的出现监听 secret 值
```

这正是它必须单独成一个 include 的原因（否则主文件也会被牵连成只读，
连带面板的节点/分组管理失效）。反之亦然：**不要在其它 `.dae` 里写 `native_api` / `clash_api` 块** ——
判据是「`experimental` 下这两个块内存在**任意子块**或名为 `secret` 的键」，不只是 `secret`。

**保存与生效是刻意的两步**，不是一次操作：

- Save / Save & Apply **只写盘**，并在提示里告诉你去点哪个按钮，**不会自动重载**。honk 文档写明「所有生效字段都要求重启；SIGHUP 拒绝其变更并保留当前 listener 与配置代次」—— 自动重载只会让用户以为已经生效。
- 真正生效由配置卡片里的按钮触发：默认「重载服务 → 立即重载」（`hot_reload`）；**API Settings 页是「重启服务 → 立即重启」**（`restart`），因为该文件里的 `native_api` 字段不支持热改。按钮名由视图传入的 `reloadAction` / `reloadLabel` / `reloadNowLabel` 定制。
- Reset 只把编辑器内容重新读回磁盘版本，不写盘。

文件写入与服务动作的执行权限由 `root/usr/share/rpcd/acl.d/luci-app-honk.json` 精确声明；运行状态由 `root/usr/libexec/honk-status` 提供（只放开该脚本的执行权限，不放开 `/proc`）。

默认 `node.dae` 是占位模板，直接启用会因 honk 启动校验失败而无法运行；需先在 Node 页签填入真实节点 / 订阅。

## 编译与发布

推送 `main`，或在 **Actions → Build apk → Run workflow** 手动触发（SDK 默认 `openwrt-25.12`，`sdk` / `packages` 可覆盖）。

Release 采用当天日期槽位 `honk_<UTC 日期>`，每次发布前清空该 tag 的旧附件并附带 `SHA256SUMS`。保留策略：Release 保留最近 2 个，workflow run 与 artifact 各保留 2 天。

源码树编译：

```sh
git clone https://github.com/498777/luci-app-honk package/honk
./scripts/feeds update -a && ./scripts/feeds install -a
make menuconfig   # Network -> Web Servers/Proxies -> luci-app-honk
make package/honk/compile V=s
```

产物位于 `bin/packages/<arch>/`，中文语言包由 `luci.mk` 自动带出。

## 目录结构

```
Auto_Install_Script.sh             一键安装（apk）
honk/                              核心包（下载预编译 honk-core + init / 配置）
luci-app-honk/                     LuCI 界面（htdocs 视图 + menu.d/acl.d + libexec 状态脚本 + po）
scripts/update_honk_version.sh     上游版本 / 校验和同步
scripts/check-po.sh                po 与源码一致性检查（CI 的 lint-po 调用）
.github/workflows/build-apk.yml                 取上游 release 二进制 + 编译 apk 并发布 Release
.github/workflows/update-honk.yml               每日检查上游 honk release 并自动 bump 版本
.github/workflows/build-honk-native-api.yml     临时：编译 fork 的 native-api 分支（仅出 artifact）
```

日志：`/var/log/honk/honk.log`（init 每次启动轮转，保留 3 代）。

## 第三方前端资源

`luci-app-honk/root/www/luci-static/resources/honk/` 下的 CodeMirror 资源为 **5.65.21 压缩版**，取自 cdnjs（`https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/`）。库本体的压缩版位于该包的 **根目录**（`codemirror.min.js` / `codemirror.min.css`），addon 与 theme 与上游同名：

| 仓库内路径 | 上游文件 |
| --- | --- |
| `lib/codemirror.min.js` | `codemirror.min.js` |
| `lib/codemirror.min.css` | `codemirror.min.css` |
| `addon/edit/matchbrackets.min.js` | `addon/edit/matchbrackets.min.js` |
| `addon/edit/closebrackets.min.js` | `addon/edit/closebrackets.min.js` |
| `addon/selection/active-line.min.js` | `addon/selection/active-line.min.js` |
| `addon/fold/foldcode.min.js` | `addon/fold/foldcode.min.js` |
| `addon/fold/foldgutter.min.js` | `addon/fold/foldgutter.min.js` |
| `addon/fold/foldgutter.min.css` | `addon/fold/foldgutter.min.css` |
| `addon/fold/indent-fold.min.js` | `addon/fold/indent-fold.min.js` |
| `theme/dracula.min.css` | `theme/dracula.min.css` |

`mode/dae/dae.js` 是本仓库自写的语法模式，保持未压缩以便修改。升级 CodeMirror 时需同步替换上表全部文件，并保证 `editor.js` 的 `CM_ASSETS` 与实际文件一一对应 —— 声明了却不存在、或存在却未被声明，都会使编辑器静默降级为普通文本框。

替换结果的校验命令（在 `luci-app-honk/root/www/luci-static/resources/honk/` 下执行）：

```sh
sha256sum -c <<'EOF'
d649a8d6bd5d0ca9bb3bef8212c9de6fa5599af3e3fe2898f94861dfe87bea7d  lib/codemirror.min.js
22f18b4dec95cc981a96f8e69f61f595314162fd102ba401abcd20b0674d9846  lib/codemirror.min.css
d0676055ec033a6f8f8f225b3fe47f8b6b2388e5beba4765d24152f106077806  addon/edit/matchbrackets.min.js
d48f92696b5cd5dc27055c73d1c34c4fa4e4e1e5e7b5baea58e5c23ca9777a36  addon/edit/closebrackets.min.js
6b5973470168d480f70a87affe7b1f93bea82369d790a23349c6a4816ae11708  addon/selection/active-line.min.js
4d101855eaa4334515bbdc6d96b1ff885ac83093d30cf792307e9e109622bd6e  addon/fold/foldcode.min.js
7d42c7d69bab903cf0ebb6864faf0ce097dbcabf9576dd8956bf97f3db8bb5cc  addon/fold/foldgutter.min.js
6c92093b9b94474c6d956b2989361928888e25fa695b140d8d8d0c0d2400773c  addon/fold/foldgutter.min.css
25d0dae3fc23df52e6ef52bf144a2a1b4418f130cb334eeb84359f5171e6cd46  addon/fold/indent-fold.min.js
d3a5434495be383a98973444d440d60b5148e67dd7c94e87369c2dcb829bb9e0  theme/dracula.min.css
EOF
```

## 许可证

**AGPL-3.0-only**（与 `honk/Makefile` 的 `PKG_LICENSE` 一致）。上游 honk-core 为 GPL-3.0 文本（dae 系源 AGPL-3.0）；LuCI 界面移植自 QiuSimons/luci-app-honk。

## 鸣谢

- [daeuniverse/honk](https://github.com/daeuniverse/honk) 及其贡献者（honk 引擎）；[QiuSimons/luci-app-honk](https://github.com/QiuSimons/luci-app-honk)（界面行为与文案的移植来源）；
- 本仓库（498777）：负责打包与每日同步上游；
- [OpenWrt LuCI](https://github.com/openwrt/luci) 框架与 luci-app 基础设施；JS 版界面（`form.TextValue` 自定义 load/write + `fs.*_direct` + menu.d/acl.d 的权限写法）参考 [ImmortalWrt/luci](https://github.com/immortalwrt/luci) 的 `luci-app-dae`。
