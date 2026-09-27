#!/bin/sh

REPO="${REPO:-498777/luci-app-honk}"
LANGS="zh-cn zh_Hans zh_cn"
FORCE=0
GH_PROXY="${GH_PROXY:-https://ghfast.top}"
PLANFILE="/tmp/honk-plan.$$"
DECIDED="/tmp/honk-decide.$$"
PKGS=""

# 核心服务名与"本次是否更新了核心"标记（供安装后按需重启使用）
CORE_SVC="honk"
CORE_UPDATED=0

# 自愈：清理 /etc/apk/world 中遗留的裸路径条目。
# 更早版本的脚本用 `apk add /tmp/xxx.apk` 装包，apk 会把这条文件路径原样写进 world，
# 文件删除后每次 apk 操作都报 no such package。这里在开始前统一清除。
# 说明：当前版本写入的是 "包名><身份哈希" 约束，由下面的 world_keep 只去掉会失效的身份哈希、保留包名，
# 不在自愈段做无差别删除，以免误伤用户手工添加的 pin。
if [ -f /etc/apk/world ] && grep -q '/tmp/' /etc/apk/world 2>/dev/null; then
    sed -i '/^\/.*\.apk$/d' /etc/apk/world
    echo "ℹ 已清理 /etc/apk/world 中的失效路径条目"
fi

usage() {
    cat <<'EOF'
用法：
  curl -fsSL "https://raw.githubusercontent.com/<OWNER>/<REPO>/main/Auto_Install_Script.sh" | sh -s luci-app-honk

参数：
  --repo <OWNER/REPO>   指定 Release 所在仓库（也可 export REPO=... 后运行）
  --repo=<OWNER/REPO>   同上
  --force               版本相同时也强制重装
  --no-proxy            关闭 GitHub 加速，直连下载
  --gh-proxy [URL]      指定 GitHub 加速前缀（默认 https://ghfast.top；也可 export GH_PROXY=...）
  --keep-dep            （已废弃，仅为兼容旧命令保留；不再拆包剔除依赖）
  -h, --help            显示本帮助
  <包名>...             指定要装的包，留空则装 honk + luci-app-honk + 中文语言包
                        （指定 luci-app-honk 时会自动补上 honk 与中文语言包）

示例：
  curl -fsSL .../Auto_Install_Script.sh | sh -s
  curl -fsSL .../Auto_Install_Script.sh | sh -s honk
  curl -fsSL .../Auto_Install_Script.sh | sh -s -- --force
EOF
    exit 0
}

die() { echo "✗ $*"; exit 1; }
info() { echo "→ $*"; }
ok() { echo "✓ $*"; }

# GitHub 加速前缀（默认 ghfast.top，--no-proxy 或 GH_PROXY= 关闭）
gurl() {
    if [ -n "$GH_PROXY" ]; then
        printf '%s/%s' "${GH_PROXY%/}" "$1"
    else
        printf '%s' "$1"
    fi
}

while [ $# -gt 0 ]; do
    case "$1" in
        --repo|-r)     REPO="$2"; shift 2 ;;
        --repo=*)      REPO="${1#--repo=}"; shift ;;
        --force)       FORCE=1; shift ;;
        --no-proxy)    GH_PROXY=""; shift ;;
        --gh-proxy)    GH_PROXY="${2:-https://ghfast.top}"; shift 2 ;;
        --gh-proxy=*)  GH_PROXY="${1#--gh-proxy=}"; shift ;;
        --keep-dep)    shift ;;   # 兼容旧命令行：vmlinux-btf 已由 CI 断言保证，无需安装时处理
        -h|--help)     usage ;;
        *)             PKGS="$PKGS $1"; shift ;;
    esac
done

echo "╔══════════════════════════════════════════════╗"
echo "║   luci-app-honk 一键安装（apk）              ║"
echo "╚══════════════════════════════════════════════╝"

case "$REPO" in
    ""|YOUR_OWNER/YOUR_REPO)
        die "未设置仓库。请把脚本里的 REPO 改成你的仓库，或这样运行：
     curl -fsSL .../Auto_Install_Script.sh | sh -s -- --repo OWNER/REPO luci-app-honk" ;;
esac
echo "仓库: https://github.com/$REPO"

command -v curl >/dev/null 2>&1 || die "缺少 curl，请先安装：apk add curl"
command -v apk  >/dev/null 2>&1 || die "未检测到 apk。本仓库只发布 apk 包，请使用 OpenWrt 24.10+ / 25.x 的 apk 体系固件。"

ARCH=$(apk --print-arch 2>/dev/null)
[ -n "$ARCH" ] || die "无法获取系统架构（apk --print-arch 失败）"
echo "架构: $ARCH"

if [ ! -f /sys/kernel/btf/vmlinux ]; then
    echo "⚠ 未发现 /sys/kernel/btf/vmlinux：当前内核可能未开启 CONFIG_DEBUG_INFO_BTF。"
    echo "  honk 仍能装上，但无法启动。请换用带 BTF 的内核（如官方 24.10+ 默认配置）。"
fi

# ------------------------------------------------- 获取最新 Release（不走 GitHub API，避免 403）
info "查询最新 Release ..."

# 候选 URL：先直连，再走加速站。
# 加速站只镜像 assets 下载与 /releases/latest 的重定向；releases 列表页走代理一律返回空
# （实测 2026-09-27），所以两条通道都要试，不能只靠代理。
rel_urls() {
    printf '%s\n' "https://github.com/$REPO$1"
    if [ -n "$GH_PROXY" ]; then
        printf '%s\n' "$(gurl "https://github.com/$REPO$1")"
    fi
    return 0
}

get_latest_tag() {
    for u in $(rel_urls /releases/latest); do
        loc=$(curl -fsSI --max-time 20 "$u" 2>/dev/null \
            | tr -d '\r' | sed -n 's#^[Ll]ocation: .*/releases/tag/##p')
        [ -n "$loc" ] && { printf '%s' "$loc"; return 0; }
    done
    for u in $(rel_urls /releases); do
        page=$(curl -fsSL --max-time 30 "$u" 2>/dev/null)
        loc=$(printf '%s' "$page" | grep -oE '/releases/tag/[^"?]+' | head -1 | sed 's#.*/tag/##')
        [ -n "$loc" ] && { printf '%s' "$loc"; return 0; }
    done
    return 1
}

list_assets() {
    tag="$1"
    curl -fsSL --max-time 30 "$(gurl "https://github.com/$REPO/releases/expanded_assets/$tag")" 2>/dev/null \
        | grep -oE "href=\"/$REPO/releases/download/$tag/[^\"]+\.apk\"" \
        | sed "s#^href=\"/#https://github.com/#; s#\"\$##" | sort -u
}

TAG=$(get_latest_tag) || die "获取 Release 失败，请检查网络或仓库名是否正确"
echo "最新版本: $TAG"

# 拉取 Release 的 SHA256SUMS 用于下载后的完整性校验（旧 Release 可能未附此文件，容错处理）
SUMS=""
SUMS_FILE="/tmp/honk-SHA256SUMS.$$"
if curl -fsSL --max-time 30 -o "$SUMS_FILE" "$(gurl "https://github.com/$REPO/releases/download/$TAG/SHA256SUMS")" 2>/dev/null && [ -s "$SUMS_FILE" ]; then
    SUMS="$SUMS_FILE"
    echo "校验文件: 已取得 SHA256SUMS"
else
    rm -f "$SUMS_FILE"
    SUMS=""
    echo "⚠ 未取得 SHA256SUMS：本次跳过完整性校验（该 Release 可能未附校验文件）"
fi

URLS=$(list_assets "$TAG")
[ -n "$URLS" ] || die "Release $TAG 中没有找到 .apk 文件"

# ----------------------------------------------------------- 版本工具
strip_arch_suffix() {
    v="$1"
    for a in "$ARCH" x86_64 x86_64v3 aarch64 aarch64_generic all noarch; do
        case "$v" in *"-$a") v="${v%-$a}" ;; esac
    done
    printf '%s' "$v"
}

asset_ver() {
    f=$(basename "$1")
    n="$2"
    f=${f%.apk}
    v=${f#"$n"-}
    strip_arch_suffix "$v"
}

apk_installed_ver() {
    apk list --installed 2>/dev/null | awk -v p="$1-" -v a="$ARCH" '
        $1 ~ "^" p {
            v=$1; sub("^" p, "", v)
            if (v ~ ("-" a "$")) v=substr(v,1,length(v)-length(a)-1)
            n=split("x86_64 x86_64v3 aarch64 aarch64_generic all noarch", ar, " ")
            for (i=1;i<=n;i++) if (v ~ ("-" ar[i] "$")) { v=substr(v,1,length(v)-length(ar[i])-1); break }
            print v; exit
        }'
}

norm_ver() { printf '%s' "$1" | tr -d '~._-'; }

# --------------------------------------------------------- 挑选包（写入 PLANFILE：每行 "URL|包名"）
select_pkg() {
    cands=$(echo "$URLS" | grep -E "/${1}[-_][^\"/]*\.apk$")
    [ -n "$cands" ] || return 1
    best=$(echo "$cands" | grep -i -- "$ARCH" | head -1)
    [ -z "$best" ] && best=$(echo "$cands" | grep -Ei '[-_](all|noarch)[-_.]' | head -1)
    [ -z "$best" ] && best=$(echo "$cands" | head -1)
    echo "$best"
}

plan_has() {
    grep -q "^[^|]*|$1$" "$PLANFILE" 2>/dev/null
}

add_pkg() {
    u=$(select_pkg "$1") || u=""
    if [ -n "$u" ]; then
        echo "$u|$1" >> "$PLANFILE"
    else
        echo "⚠ 未找到 $1 的 apk，跳过"
        return 1
    fi
}

add_i18n() {
    for lang in $LANGS; do
        u=$(select_pkg "luci-i18n-honk-${lang}") || u=""
        if [ -n "$u" ]; then echo "$u|luci-i18n-honk-${lang}" >> "$PLANFILE"; return 0; fi
    done
    echo "⚠ 未找到中文语言包，界面将是英文"
    return 1
}

# 从 apk 文件名解析包名：luci-app-honk-2.0.0-r1.apk -> luci-app-honk
pkg_name_of() {
    b=$(basename "$1"); b=${b%.apk}
    printf '%s' "$b" | sed 's/-[0-9][0-9A-Za-z._+~-]*-r[0-9][0-9A-Za-z._+~-]*$//'
}

# 把 apk 安装本地文件时写入的 "包名><身份哈希" 规范化为纯包名。
# 背景：apk-add(8) —— "If a file is added, a constraint against the package identity
# hash will be add"；.apk 文件删除后该约束即失效，后续 apk 操作都报 no such package。
# 也不用 --force-broken-world（那会无差别删约束直到可求解，风险更大）。
# 不能整行删除 —— 那一行是包在 /etc/apk/world（期望状态）里的成员身份，
# 删掉后包会退出期望状态，其后任何一次 apk add 都会把它当作非期望状态收敛掉
# （实测：装 dae 时把 honk、luci-app-honk、luci-i18n-honk-zh-cn 连同 honk 的
#  独占依赖 ip-full/libbpf1/libelf1 一起 Purging）。只去掉会失效的身份哈希即可。
world_keep() {
    n="$1"
    [ -n "$n" ] || return 0
    [ -f /etc/apk/world ] || return 0
    if grep -qxF "$n" /etc/apk/world 2>/dev/null; then
        sed -i "\|^${n}><|d" /etc/apk/world 2>/dev/null || true
    else
        sed -i "\|^${n}><|s|^${n}><.*|${n}|" /etc/apk/world 2>/dev/null || true
    fi
}

install_local_apk() {
    f="$1"
    [ -f "$f" ] || return 1
    n=$(pkg_name_of "$f")

    # 安装前先规范化同名残留约束，避免失效的身份哈希约束让整个事务失败
    world_keep "$n"

    # </dev/null：本函数是在 `while read ... < "$DECIDED"` 里被调的，
    # 若 apk 去读 stdin（交互提示等）会把待装清单后面的行吃掉
    if ! apk add --allow-untrusted "$f" </dev/null; then
        echo "  ✗ $(basename "$f") 安装失败，请看上面的 apk 报错"
        return 1
    fi

    # 装完即规范化：apk 会把 "包名><身份哈希" 约束写进 world，留着 hash 下次会报 no such package
    world_keep "$n"
    ok "$(basename "$f") 安装完成"
    return 0
}

# 用 Release 的 SHA256SUMS 校验下载到的文件（纯 shell 解析，不依赖 awk）。
# 未取得校验文件、或校验文件里没有该文件名时跳过（见上方 SUMS 处理）。
verify_sha256() {
    f="$1"
    name=$(basename "$f")
    [ -n "$SUMS" ] || return 0

    want=""
    while read -r h n; do
        # 兼容 sha256sum 清单里的 "./" 前缀与二进制模式的 "*" 前缀
        n="${n#\*}"
        n="${n#./}"
        [ "$n" = "$name" ] && { want="$h"; break; }
    done < "$SUMS"

    if [ -z "$want" ]; then
        echo "  ⚠ SHA256SUMS 中未列出 $name，跳过校验"
        return 0
    fi

    got=$(sha256sum "$f" 2>/dev/null | cut -d' ' -f1)
    if [ "$got" != "$want" ]; then
        echo "  ✗ $name SHA256 校验失败（期望 $want / 实际 $got）"
        return 1
    fi
    echo "  ✓ $name SHA256 校验通过"
    return 0
}

install_url() {
    url="$1"
    [ -n "$url" ] || return 1
    file=$(basename "$url")
    info "下载 $file"
    curl -fsSL --max-time 300 --retry 2 -o "/tmp/$file" "$(gurl "$url")" || { echo "✗ 下载失败"; return 1; }

    verify_sha256 "/tmp/$file" || { rm -f "/tmp/$file"; return 1; }

    echo "  ⬇ 安装 $file"
    install_local_apk "/tmp/$file" || { rm -f "/tmp/$file"; return 1; }
    return 0
}

# --------------------------------------------------------- 更新核心后按需重启
# 仅当本次确实安装/更新了核心包（honk/dae），且服务已启用时才接管重启：
#   - 已启用且正在运行 -> 重启，让新版本生效
#   - 已启用但未运行   -> 启动，让新版本生效
#   - 未启用（多为全新安装、尚未配置节点）-> 不自动启动，避免启动一个没配好节点的核心而报错
# 前提检查用 OpenWrt procd 的 enabled/running，不做无差别启动。
restart_core_if_needed() {
    [ "$CORE_UPDATED" -eq 1 ] || return 0
    initscript="/etc/init.d/$CORE_SVC"
    [ -x "$initscript" ] || return 0

    if ! "$initscript" enabled >/dev/null 2>&1; then
        echo "  ℹ $CORE_SVC 尚未启用，跳过自动重启（配置并启用后才会运行新版本）"
        return 0
    fi

    running=0
    "$initscript" running >/dev/null 2>&1 && running=1
    if [ "$running" -eq 1 ]; then
        echo "  ↻ $CORE_SVC 正在运行，重启以应用新核心 ..."
    else
        echo "  ↻ $CORE_SVC 已启用但未运行，启动以应用新核心 ..."
    fi
    if "$initscript" restart; then
        ok "$CORE_SVC 已应用新版本"
    else
        echo "⚠ $CORE_SVC 重启失败，请检查配置与日志：logread | grep $CORE_SVC"
    fi
}

# --------------------------------------------------------- 计算待装清单
: > "$PLANFILE"; : > "$DECIDED"

add_pkg_nodup() {
    plan_has "$1" && return 0
    add_pkg "$1"
}

if [ -n "$PKGS" ]; then
    want_luci=0
    for p in $PKGS; do
        [ "$p" = "luci-app-honk" ] && want_luci=1
    done
    if [ "$want_luci" -eq 1 ]; then
        add_pkg_nodup honk
    fi
    for p in $PKGS; do
        add_pkg_nodup "$p"
    done
    if [ "$want_luci" -eq 1 ]; then
        add_pkg_nodup luci-app-honk
        add_i18n
    fi
else
    add_pkg honk
    add_pkg luci-app-honk
    add_i18n
fi

if [ ! -s "$PLANFILE" ]; then die "没有可安装的包"; fi

echo ""
echo "版本检查："
echo "  本地已装  vs  最新 Release"
while IFS='|' read -r u n; do
    [ -n "$u" ] || continue
    newv=$(asset_ver "$u" "$n")
    oldv=$(apk_installed_ver "$n")
    if [ -n "$oldv" ] && [ "$(norm_ver "$oldv")" = "$(norm_ver "$newv")" ] && [ "$FORCE" -eq 0 ]; then
        echo "  · $n  $oldv == $newv  已是最新，跳过"
        # 已安装却可能不在 /etc/apk/world（旧版本脚本曾整行删除 world 条目）：补登记回去。
        # 否则该包已退出「期望状态」，之后任何一次 apk add 都会把它连带清除。
        if [ -f /etc/apk/world ] && ! grep -qxF "$n" /etc/apk/world 2>/dev/null; then
            echo "$n" >> /etc/apk/world
            echo "    ↑ 该包此前不在 /etc/apk/world，已补登记"
        fi
    else
        echo "  · $n  ${oldv:-未安装} → $newv"
        echo "$u|$n" >> "$DECIDED"
    fi
done < "$PLANFILE"
echo ""

if [ ! -s "$DECIDED" ]; then
    echo "✅ 所有包已是最新版本，无需操作（--force 可强制重装）"
    rm -f "$PLANFILE" "$DECIDED"
    exit 0
fi

echo "即将安装："
while IFS='|' read -r u n; do echo "  · $(basename "$u")"; done < "$DECIDED"
echo ""

FAILED=""
while IFS='|' read -r u n; do
    if install_url "$u"; then
        [ "$n" = "$CORE_SVC" ] && CORE_UPDATED=1
    else
        FAILED="$FAILED $(basename "$u")"
    fi
done < "$DECIDED"
rm -f "$PLANFILE" "$DECIDED"

echo ""
info "刷新 LuCI 缓存 ..."
rm -rf /tmp/luci-indexcache /tmp/luci-modulecache 2>/dev/null
/etc/init.d/rpcd restart    >/dev/null 2>&1
/etc/init.d/uhttpd restart  >/dev/null 2>&1

echo ""
info "准备 geo 数据（softlink -> /usr/share/honk）..."
mkdir -p /usr/share/honk
link_geo() {
    for gf in geoip.dat geosite.dat; do
        [ -f "/usr/share/v2ray/$gf" ] && ln -sf "/usr/share/v2ray/$gf" "/usr/share/honk/$gf"
    done
}
link_geo
if [ ! -f /usr/share/v2ray/geoip.dat ] || [ ! -f /usr/share/v2ray/geosite.dat ]; then
    info "缺少 geo 数据，尝试自动补装 v2ray-geoip / v2ray-geosite ..."
    if apk add --allow-untrusted v2ray-geoip v2ray-geosite >/dev/null 2>&1; then
        link_geo
    else
        echo "⚠ 源中无法安装 v2ray-geoip / v2ray-geosite；若规则用到 geoip:/geosite:，"
        echo "  请确认软件源包含这两个包（apk search -x v2ray-geoip v2ray-geosite）后重试。"
    fi
fi
if [ -f /usr/share/honk/geoip.dat ] || [ -f /usr/share/honk/geosite.dat ]; then
    ok "geo 数据就绪，已建立软链"
else
    echo "⚠ 仍然缺少 geo 数据；未配置 geoip:/geosite: 规则时可忽略本提示。"
fi

echo ""
info "核心已更新，按服务启用状态决定是否重启 ..."
restart_core_if_needed

echo ""
if [ -n "$FAILED" ]; then
    echo "✗ 以下包安装失败：$FAILED"
    exit 1
fi
echo "✅ 完成！"
echo ""
echo "下一步："
echo "  1. LuCI 界面：服务 → HONK（若看不到请清浏览器缓存或重新登录）"
echo "  2. 命令行启用：uci set honk.config.enabled=1; uci commit honk; /etc/init.d/honk start"
echo "  3. geo 数据缺失时会自动补装 v2ray-geoip/v2ray-geosite 并建好软链"
echo "  4. 首次使用请先在 Node Settings 页签（或 /etc/honk/config.d/node.dae）"
echo "     把示例节点/订阅替换成自己的，再启用服务，否则 honk 会拒绝启动"
