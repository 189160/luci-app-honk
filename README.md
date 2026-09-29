# luci-app-honk

OpenWrt / ImmortalWrt（25.x，**apk** 体系）上 [honk](https://github.com/daeuniverse/honk)（基于 eBPF 的透明代理引擎，dae 兼容）的打包与 LuCI 管理界面。

## 仓库组件

| 包名 | 类型 | 说明 |
| :--- | :--- | :--- |
| **`honk`** | 核心服务 | 从上游 Release 下载预编译的 musl 静态 `honk-core`，并安装 init 脚本与 `/etc/honk/` 配置 |
| **`luci-app-honk`** | 管理界面 | LuCI Web 界面与 rpcd 服务，菜单项为 **服务 → HONK** |
| **`luci-i18n-honk-*`** | 语言包 | 由 `luci.mk` 跟随界面版本自动带出的翻译 |

> [!NOTE]
> 上游提供 `x86_64` 与 `aarch64` 的预编译 musl 静态二进制，包以 `@(x86_64||aarch64)` 限制架构。

## 安装

### 一键安装

```sh
curl -fsSL "https://raw.githubusercontent.com/189160/luci-app-honk/main/Auto_Install_Script.sh" | sh -s luci-app-honk
```

无参数时安装 `honk` + `luci-app-honk` + 中文语言包；`sh -s honk` 安装核心包，不含界面与语言包。脚本从 Release 取 `SHA256SUMS` 校验 apk，安装后自动补齐 geo 数据、建立软链并刷新 LuCI 缓存。

脚本参数（见 `-h`）：`--repo <OWNER/REPO>`（或环境变量 `REPO`）、`--no-proxy`（关闭 GitHub 加速，直连下载）、`--gh-proxy [URL]`（加速前缀，默认 `https://ghfast.top`，或 `GH_PROXY`）、`--force`（版本相同时也强制重装）。

### 手动安装与启用

```sh
apk add honk luci-app-honk luci-i18n-honk-zh-cn

uci set honk.config.enabled=1 && uci commit honk
/etc/init.d/honk start
```

`honk` 依赖 `v2ray-geoip` / `v2ray-geosite`，安装时在 `/usr/share/honk` 建立指向 `/usr/share/v2ray/{geoip,geosite}.dat` 的软链。

> [!TIP]
> `/etc/honk/config.d/node.dae`（常规设置 → 节点 配置块）默认是占位模板，替换为实际节点与订阅后再启用服务，否则 honk 启动校验失败。

## 配置文件结构

```text
/etc/honk/
├── config.dae          # 主配置
├── config.d/
│   ├── node.dae        # 节点与订阅
│   ├── route.dae       # 分流路由
│   ├── dns.dae         # DNS 解析与分流
│   └── api.dae         # native_api 配置参考（enabled: false）
└── state/              # 运行状态与 SQLite 数据库
```

> [!IMPORTANT]
> 上游预编译核心不含 `native_api`（`experimental` 段对未知子块直接报错；`udp_nfqueue` 已移至 `global.nfqueue_enable`，保留为迁移兼容用），所以随包 `/etc/honk/config.d/api.dae` 的该段默认整段注释、默认配置可直接启动。使用 doona 控制面板需两步：把核心换成带 native-api 的构建（[`Glassyiris/honk` releases](https://github.com/Glassyiris/honk/releases) 的 `honk-core-debug-<架构>-unknown-linux-musl[-stock].tar.gz`，两个变体都含 native-api，`-stock` 表示改用系统 malloc；解出的 `honk-core` 放到 `/usr/bin/honk-core`），再在 `api.dae` 里取消该段注释并填好 `secret` 与 `ui`。

## LuCI 界面

**服务 → HONK** 下为三个页签：**常规设置** / **日志** / **面板**。

- **常规设置**：顶部是运行状态卡片（每 3 秒刷新），下面一张卡片里依次是 uci 启用开关、**配置块**下拉、编辑器，底部为 Save / Save & Apply / Reset。编辑器带 CodeMirror `.dae` 语法高亮、代码折叠、括号匹配与自动补全、当前行高亮，右上角为「格式化代码」。配置块下拉承载五个块的整文件编辑（全局 / 解析 / 节点 / 路由 / 面板），切换时编辑器的标题、该块的描述、右侧的服务动作按钮一起变。
- **日志**：读取 `/var/log/honk/honk.log`，每次启动轮转并保留 3 代；重启后文件先为空，honk 写出日志后页面自动刷新。
- **面板**：面板状态与在线更新。地址按访问方式（IP / 主机名 / 域名）推导；面板版本与目录内标记一致时跳过更新；需要强制重下时执行 `/usr/libexec/honk-panel-update --action update --force`（页面按钮不提供 `--force`）。面板不可用时，页面上给出原因与一条「去哪修」链接 —— 跳到常规设置页并选中对应配置块，与 `ui` 相关的两类会再定位到该字段那一行。

**保存与生效是刻意的两步**，不是一次操作：

- Save / Save & Apply **写盘并提示该点哪个按钮**，不自动重载。
- 真正生效由编辑器标题行右侧的按钮触发：面板块为「重启服务 → 立即重启」(`restart`)，其余为「重载服务 → 立即重载」(`hot_reload`)。native_api 的生效字段（`enabled` / `listen` / `secret` / `ui` …）不支持热改，honk 收到 SIGHUP 会忽略这些变更并保留当前 listener，所以面板块必须重启。
- Reset 把编辑器内容重新读回磁盘版本，不写盘。

文件写入与服务动作的执行权限由 `root/usr/share/rpcd/acl.d/luci-app-honk.json` 精确声明；运行状态由 `root/usr/libexec/honk-status` 提供，面板状态与更新由 `root/usr/libexec/honk-native-api-probe` / `honk-panel-update` 提供。

## 编译与发布

CI 用 [sbwml/openwrt-gh-action-sdk](https://github.com/sbwml/openwrt-gh-action-sdk) 的 OpenWrt SDK（默认 `openwrt-25.12`）编译 apk；推送 `main` 或在 **Actions → Build apk → Run workflow** 手动触发。Release tag 采用日期槽位 `honk_<UTC 日期>` 并附带 `SHA256SUMS`，保留最近 2 个 Release。

源码树编译（`./scripts/update_honk_version.sh` 可自动跟随上游最新版本）：

```sh
git clone https://github.com/189160/luci-app-honk package/honk
./scripts/feeds update -a && ./scripts/feeds install -a
make menuconfig   # Network -> Web Servers/Proxies -> luci-app-honk
make package/honk/compile V=s
```

## 第三方前端资源

CodeMirror 5.65.21（含 addon、theme）取自 [cdnjs](https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/)，位于 `luci-app-honk/root/www/luci-static/resources/honk/`；`mode/dae/dae.js` 为本仓自写的语法模式。许可见 [`LICENSE`](./LICENSE)。

## 许可证

**AGPL-3.0-only**（与 `honk/Makefile` 的 `PKG_LICENSE` 一致）。

## 鸣谢

- [daeuniverse/honk](https://github.com/daeuniverse/honk) 及其贡献者（honk 引擎与本仓库二进制来源）
- [QiuSimons/luci-app-honk](https://github.com/QiuSimons/luci-app-honk)（界面设计受其启发）
- [OpenWrt LuCI](https://github.com/openwrt/luci) 框架
