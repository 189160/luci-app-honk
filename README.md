# luci-app-honk

OpenWrt / ImmortalWrt（25.x，**apk** 体系）上 [honk](https://github.com/daeuniverse/honk)（基于 eBPF 的透明代理引擎，dae 兼容）的打包与 LuCI 管理界面。

## 仓库组件

| 包名 | 类型 | 说明 |
| :--- | :--- | :--- |
| **`honk`** | 核心服务 | 取 [Glassyiris/honk](https://github.com/Glassyiris/honk)（honk fork）release 中**版本最新**的 `debug.*` 构建的 native-api 资产（非 stock）的 musl 静态 `honk-core`，并安装 init 脚本与 `/etc/honk/` 配置 |
| **`luci-app-honk`** | 管理界面 | LuCI Web 界面与 rpcd 服务，菜单项为 **服务 → HONK** |
| **`luci-i18n-honk-*`** | 语言包 | 由 `luci.mk` 跟随界面版本自动带出的翻译 |

> [!NOTE]
> 核心为 `x86_64` 与 `aarch64` 的 musl 静态二进制，包以 `@(x86_64||aarch64)` 限制架构；包版本由 fork tag 派生（`debug.2026.10.4.native-api.3` → `2026.10.4_beta3`，规则 `<日期>_beta<序数>`）。

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
> 随包 `/etc/honk/config.d/api.dae` 的 `native_api` 段默认整段注释（`enabled: false` ⇒ 不启动监听），默认配置可直接启动；要启用面板就取消注释并填好 `secret`（`listen` / `ui` 按需改）。本包自带的 `api.dae` 只是配置参考，不换核心即可启用。
>
> 核心取自 [`Glassyiris/honk`](https://github.com/Glassyiris/honk)（honk fork）的 release 资产 —— `honk-core-debug-<架构>-unknown-linux-musl[-stock].tar.gz`（随包为非 stock，即 mimalloc）。锚点是 fork 的 `debug.*` release 里**版本最高**的那个；该 release 不公布 `SHA256SUMS`，两个 musl 非 stock 资产的 sha256 由 `scripts/update_honk_version.sh` 下载后自算并写进 `honk/Makefile`（`PKG_HASH` 让 CI 在字节不符时 fail-loud）。解出的 `honk-core` 放到 `/usr/bin/honk-core`。包版本由 fork tag 派生（`debug.2026.10.4.native-api.3` → `2026.10.4_beta3`）。
>
> 该构建的 cargo feature 为 `clash-api,ebpf,rprx,native-ui`（`native-ui` 传递包含 `native-api`）—— **既含 `native_api`，也含内嵌面板**。面板形态由 `api.dae` 的 `ui` 决定：
>
> | `api.dae` 的 `ui` | 面板形态 | 更新方式 |
> | :--- | :--- | :--- |
> | `'embedded'` | 内嵌形式：构建时把钉住的 doona 发行版嵌进核心 | 升级核心即升级面板，不经「面板」页 —— **推荐** |
> | `'<目录绝对路径>'` | 目录形式：面板落在指定目录 | 由本仓「面板」页在线更新；要求目标目录存在且含可读 `index.html` |
>
> 🔴 **配对代价（现状如实说明）**：核心取 fork 的**绝对最新**，而「面板」页的在线更新跟随 doona 的**最新 release**、不做钉版 —— 二者不同步。目录形式下面板会**长期落后核心一代**（doona 发版滞后于 fork），这正是「面板与核心差一代」的成因，表现为面板测速 `Invalid probe request.`、状态库 `foreign application id` / `newer schema`。**因此推荐 `ui: 'embedded'`** —— 面板随核心字节走，不存在两代错配。
>
> 反查对应关系（**doona 侧**，不是本包核心所用的 fork release）：`Zakkaus/doona` 每个 release 的 `HONK-SOURCE.txt` 写有它钉的 `Commit:`；比对该 `Commit:` 与 `honk/Makefile` 的 `HONK_COMMIT` 即可判断某个 doona 版本与本核心是否同代。本核心对应的 doona 版本可能**尚未发布**（fork 先行、doona 随后跟进），此时反查无匹配属正常。
>
> 需要自行构建时用 `.github/workflows/build-honk-native-api.yml`，其中 `ref` 钉 commit、`features` 决定是否内嵌面板（写 `native-api,native-ui`）。「面板」页的状态行会实时探测 `/ui/`，两种形态的可用性都以该探测结果为准。
>
> ⚠️ `/etc/honk/` 是本包的 conffile：升级与重装会替换 `/usr/bin/honk-core`，但保留用户改过的 `api.dae`。改过 `api.dae` 后要重启服务才生效（`native_api` 的字段不支持热改，见「LuCI 界面」）。
>
> ⚠️ 换核心后若日志报 state 库相关错误（`foreign application id` / `newer schema`）：那是 `/etc/honk/state/` 里留着**别的** honk 构建写下的运行态库 —— `/etc/honk/` 是 conffile，升级与重装都会保留它。判据：停服务 → 移走或删除 `/etc/honk/state/` → 再启动即可（只丢运行态，不丢配置）。

## LuCI 界面

**服务 → HONK** 下为三个页签：**常规设置** / **日志** / **面板**。

- **常规设置**：顶部是运行状态卡片（每 3 秒刷新），下面一张卡片里依次是 uci 启用开关、**配置块**下拉、编辑器，底部为 Save / Save & Apply / Reset。编辑器带 CodeMirror `.dae` 语法高亮、代码折叠、括号匹配与自动补全、当前行高亮，右上角为「格式化代码」。配置块下拉承载五个块的整文件编辑（全局 / 解析 / 节点 / 路由 / 面板），切换时编辑器的标题、该块的描述、右侧的服务动作按钮一起变。
- **日志**：读取 `/var/log/honk/honk.log`，每次启动轮转并保留 3 代；重启后文件先为空，honk 写出日志后页面自动刷新。
- **面板**：面板状态与在线更新。地址按访问方式（IP / 主机名 / 域名）推导；面板版本与目录内标记一致时跳过更新；需要强制重下时执行 `/usr/libexec/honk-panel-update --action update --force`（页面按钮不提供 `--force`）。面板形态由 `api.dae` 的 `ui` 决定：目录形式的状态行显示目录与面板版本，由本页在线更新；内嵌形式显示「内嵌面板（由核心提供）」与核心构建号，在线更新不适用。目录形式的面板跟随 doona 最新 release，会落后随包核心一代；推荐 `ui: 'embedded'`（见「配置文件结构」的配对代价说明）。可用性一律以本机对 `/ui/` 的探测结果为准。面板不可用时，页面上给出原因与一条「去哪修」链接 —— 跳到常规设置页并选中对应配置块，与 `ui` 相关的两类会再定位到该字段那一行。

**保存与生效是刻意的两步**，不是一次操作：

- Save / Save & Apply **写盘并提示该点哪个按钮**，不自动重载。
- 真正生效由编辑器标题行右侧的按钮触发：面板块为「重启服务 → 立即重启」(`restart`)，其余为「重载服务 → 立即重载」(`hot_reload`)。native_api 的生效字段（`enabled` / `listen` / `secret` / `ui` …）不支持热改，honk 收到 SIGHUP 会忽略这些变更并保留当前 listener，所以面板块必须重启。
- Reset 把编辑器内容重新读回磁盘版本，不写盘。

文件写入与服务动作的执行权限由 `root/usr/share/rpcd/acl.d/luci-app-honk.json` 精确声明；运行状态由 `root/usr/libexec/honk-status` 提供，面板状态与更新由 `root/usr/libexec/honk-native-api-probe` / `honk-panel-update` 提供。

## 编译与发布

CI 用 [sbwml/openwrt-gh-action-sdk](https://github.com/sbwml/openwrt-gh-action-sdk) 的 OpenWrt SDK（默认 `openwrt-25.12`）编译 apk；推送 `main` 或在 **Actions → Build apk → Run workflow** 手动触发。Release tag 采用日期槽位 `honk_<UTC 日期>` 并附带 `SHA256SUMS`，保留最近 2 个 Release。

源码树编译（`./scripts/update_honk_version.sh` 取 fork 的 `debug.*` 最新 release：下载两个 musl 非 stock 资产**自算 sha256**、按该 tag 的 commit 判变 —— 资产取不到即停止不前进；commit 与两个哈希都未变则不产生任何改动、不触发重建）：

```sh
git clone https://github.com/189160/luci-app-honk package/honk
./scripts/feeds update -a && ./scripts/feeds install -a
make menuconfig   # Network -> Web Servers/Proxies -> luci-app-honk
make package/honk/compile V=s
```

## 第三方前端资源

CodeMirror 5.65.21（含 addon、theme）取自 [cdnjs](https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/)，位于 `luci-app-honk/root/www/luci-static/resources/honk/`；`mode/dae/dae.js` 为本仓自写的语法模式。本仓库自身的许可见 [`LICENSE`](./LICENSE)（**AGPL-3.0-only**）。

## 许可证

本仓库（LuCI 界面、脚本与配置）为 **AGPL-3.0-only**，全文见 [`LICENSE`](./LICENSE)。

随包分发的 `honk-core` 二进制按 **GPL-3.0-only** 分发（`honk/Makefile` 的 `PKG_LICENSE:=GPL-3.0-only` 描述的是这个**二进制**，不是本仓库）。其许可**出处是核心归档**（`honk-core-debug-<架构>-unknown-linux-musl.tar.gz`）**顶层自带的 `LICENSE`**（GPL-3.0 全文），该文件随包安装在 `/usr/share/licenses/honk/LICENSE`。该 fork release 不附带 `HONK-SOURCE.txt` 之类的许可证声明文件，故不以它作为依据。

相应许可文本随包安装在 `/usr/share/licenses/honk/`：核心归档顶层的 `LICENSE`（GPL-3.0），以及内嵌面板随核心字节一并分发的 `doona/{LICENSE,NOTICE,THIRD-PARTY-NOTICES.txt,LICENSES/*.txt}`（与 `honk/Makefile` 的 install 段逐条对应；`LICENSES/` 用通配，上游新增的许可文件会一并装出）。

**Corresponding Source（GPL-3.0 §6）**：随包 `honk-core` 由 fork commit [`186353d1bffcd832774d6e57cc621df68e2c4634`](https://github.com/Glassyiris/honk/tree/186353d1bffcd832774d6e57cc621df68e2c4634) 构建。该 commit 对应的 doona 版本尚未发布（fork 先行），故 doona 侧没有 `honk-source-<commit>.tar.gz`；相应源码取 fork 仓库该 commit 的归档：`https://github.com/Glassyiris/honk/archive/186353d1bffcd832774d6e57cc621df68e2c4634.tar.gz`（GitHub 按 commit 生成的源码归档，上游未公布其 sha256）。

## 鸣谢

- [daeuniverse/honk](https://github.com/daeuniverse/honk) 及其贡献者（honk 引擎）
- [Zakkaus/doona](https://github.com/Zakkaus/doona)（随包核心与配对面板的来源）
- [Glassyiris/honk](https://github.com/Glassyiris/honk)（随包核心的构建分支）
- [QiuSimons/luci-app-honk](https://github.com/QiuSimons/luci-app-honk)（界面设计受其启发）
- [OpenWrt LuCI](https://github.com/openwrt/luci) 框架
