#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAKEFILE="$REPO_DIR/honk/Makefile"

# 临时目录（下载两个 musl 资产用）与 Makefile 临时文件（原子写用）。
# 清理必须**绝对**不改变脚本的退出码：EXIT trap 里任何非 0 状态（哪怕只是 rm 失败的残留状态）
# 都会顶掉脚本自身的退出码 —— 一次成功的运行会因此变成失败。故 set +e 与 `|| true` 双保险。
DL_TMP=""
MK_TMP=""
cleanup() {
    set +e
    if [ -n "${DL_TMP:-}" ]; then
        rm -rf -- "$DL_TMP" 2>/dev/null || true
        DL_TMP=""
    fi
    if [ -n "${MK_TMP:-}" ]; then
        rm -f -- "$MK_TMP" 2>/dev/null || true
        MK_TMP=""
    fi
    return 0
}
# 信号路径：清完就**立刻退出**。否则 bash 在 trap 返回后会让脚本继续往下跑，
# 而此时 MK_TMP / DL_TMP 已被清空 ⇒ 会撞上 `mv -- "" …`，多打一行
# `mv: cannot stat ''` 与「替换 Makefile 失败」的噪声（结局仍是 fail-safe：
# 原文件未改 + 非 0 + 无残留，但日志误导）。退出码沿用惯例 128+signum。
on_signal() { cleanup; exit "$1"; }
trap cleanup EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

# 核心来源与锚点仓库：honk fork 的 `debug.*` per-tag release。
FORK_REPO="Glassyiris/honk"

# 锚点语义：取 fork 的 `debug.*` release 里版本最高的那个（fork 绝对最新）。
# 配对代价（如实记录）：面板更新跟随 doona 最新 release、不做钉版，而核心取 fork 绝对最新
# ⇒ 目录形式下面板会长期落后核心一代（`Invalid probe request.` 那类症状），推荐 ui: 'embedded'。
#
# 该 release 不公布 SHA256SUMS ⇒ 两个 musl 非 stock 资产的 sha256 由本脚本下载后自算。
# 判变键仍为 commit + 两个 musl 哈希。
#
# 测试注入点（本地固定样本；生产路径不需要）：
#   HONK_FIXTURE_DIR   离线夹具根：candidates（fork tag 清单，每行一个）、
#                      <tag>/<asset>（真实字节：既当"下载源"，也用于自算哈希）、<tag>/COMMIT
#   FORK_RELEASE_TAG   显式指定 fork tag，跳过候选筛选
# 两者都不设时，才去网上取候选与资产。

git_ls_remote_tags() {
    local attempt
    for attempt in 1 2 3 4 5; do
        if git ls-remote --tags "https://github.com/${FORK_REPO}.git" 2>/dev/null; then
            return 0
        fi
        sleep 3
    done
    return 1
}

# 读 Makefile 里的 `VAR:=值`（值可为空）。
# 字段**缺失**时必须返回空串且状态 0 —— 否则 `set -euo pipefail` 下 `x="$(makefile_var …)"`
# 会因为 grep 无命中而整条流水线非 0，令赋值直接终止脚本（无任何提示，且绕过下游守卫）。
# 缺字段该由原子写的「六字段全命中」守卫统一 fail-loud，而不是在这里静默死掉。
makefile_var() {
    { grep -E "^$1:=" "$MAKEFILE" 2>/dev/null || true; } | head -n 1 | cut -d= -f2-
}

# 候选 fork tag（版本序，高在前）：夹具优先，否则取远端 `debug.*` 标签。
list_candidates() {
    if [ -n "${HONK_FIXTURE_DIR:-}" ]; then
        sort -Vru "${HONK_FIXTURE_DIR}/candidates" 2>/dev/null || true
        return 0
    fi
    git_ls_remote_tags | awk '{print $2}' | sed 's|refs/tags/||' \
        | grep -v '\^{}' | grep -E '^debug\.' | sort -Vr
}

# 临时目录基址：必须是 POSIX 形态。
# Git Bash 下 TMPDIR 常是 `C:\...`，拿它当 mktemp 模板会返回 Windows 绝对路径 ——
# 那种路径 rm 不可靠（本项目沙箱直接拒删），既清理不掉、又会顶掉退出码；
# 同时它还会让 sha256sum 在行首加 `\` 转义。故 Windows 形态一律跳过，退到 /tmp。
pick_dl_base() {
    local b
    for b in "${TMPDIR:-}" /tmp; do
        [ -n "$b" ] || continue
        case "$b" in
            *\\*|[A-Za-z]:*) continue ;;
        esac
        if [ -d "$b" ] && [ -w "$b" ]; then
            printf '%s\n' "$b"
            return 0
        fi
    done
    printf '%s\n' "${REPO_DIR}"
}

# 该 tag 的 commit：annotated tag 取 peeled（^{}）那一行，轻量 tag 取原行。
fetch_commit() {
    local tag="$1" c
    if [ -n "${HONK_FIXTURE_DIR:-}" ]; then
        [ -r "${HONK_FIXTURE_DIR}/${tag}/COMMIT" ] || return 1
        tr -d ' \t\r\n' < "${HONK_FIXTURE_DIR}/${tag}/COMMIT"
        printf '\n'
        return 0
    fi
    c="$(git_ls_remote_tags | awk -v t="refs/tags/${tag}^{}" '$2 == t { print $1 }' | head -n 1)"
    [ -n "$c" ] || c="$(git_ls_remote_tags | awk -v t="refs/tags/${tag}" '$2 == t { print $1 }' | head -n 1)"
    [ -n "$c" ] || return 1
    printf '%s\n' "$c"
}

# 取资产字节。夹具模式下从本地复制（同样用于自算哈希），生产路径下载。
# 二者共用同一出口：拿不到字节即视为不可达 ⇒ 调用方 fail-safe 停止、不写盘。
#
# 生产路径的完整性闸门：`curl -f` 只挡 HTTP 错误码，**挡不住「状态码正常但连接中断」的截断**
# —— 截断字节算出的 sha256 形态完全合法、数值却是错的，会被 assert_hash 放行、静默钉进
# Makefile（本脚本首次下 aarch64 时就得过 `d6d91255…` 这类错值）。故下载后**必须**比对
# HTTP `Content-Length` 与实际字节数，不等即报错、不写盘。
fetch_asset() {
    local tag="$1" asset="$2" dest="$3"
    if [ -n "${HONK_FIXTURE_DIR:-}" ]; then
        [ -r "${HONK_FIXTURE_DIR}/${tag}/${asset}" ] || return 1
        cp "${HONK_FIXTURE_DIR}/${tag}/${asset}" "$dest"
        return 0
    fi
    local url want actual
    url="https://github.com/${FORK_REPO}/releases/download/${tag}/${asset}"
    # 期望长度：HEAD 跟随重定向（-L）后取最后一跳的 Content-Length。
    want="$(curl -fsSL -I -L --retry 3 --connect-timeout 20 --max-time 120 "$url" 2>/dev/null \
        | tr -d '\r' | awk 'tolower($1)=="content-length:"{v=$2} END{print v+0}')"
    curl -fsSL --retry 3 --connect-timeout 20 --max-time 600 "$url" -o "$dest" 2>/dev/null || return 1
    actual="$(wc -c < "$dest" | tr -d ' ')"
    if [ -z "$want" ] || [ "$want" -le 0 ]; then
        echo "error: ${asset} 取不到 Content-Length —— 无法确认完整性，停止跟随，不前进" >&2
        return 1
    fi
    if [ "$actual" -le 0 ]; then
        echo "error: ${asset} 下载得到 0 字节 —— 停止跟随，不前进" >&2
        return 1
    fi
    if [ "$actual" != "$want" ]; then
        echo "error: ${asset} 下载不完整（Content-Length=${want}，实得 ${actual} 字节） —— 停止跟随，不前进" >&2
        return 1
    fi
    return 0
}

# 走 stdin：部分环境（如 Git Bash）下文件名含反斜杠时，sha256sum 会在行首加 `\` 转义，
# 按字段切出来就带上了它；读 stdin 时输出恒为 "<hash>  -"，不受路径形态影响。
sha256_of() {
    sha256sum < "$1" | cut -d' ' -f1
}

# 写进 Makefile 的值必须是裸 64 位十六进制 —— 否则 sed 的替换串会把 `\f`/`\a` 之类
# 当转义吃掉，静默污染 Makefile。宁可 fail-loud。
assert_hash() {
    local h="$1" name="$2"
    case "$h" in
        *[!0-9a-f]*|"") echo "error: ${name} 自算 sha256 形态非法：'${h}' —— 停止跟随，不前进" >&2; exit 1 ;;
    esac
    [ "${#h}" -eq 64 ] || { echo "error: ${name} 自算 sha256 长度非法（${#h}） —— 停止跟随，不前进" >&2; exit 1; }
}

# debug.2026.10.4.native-api.3 -> 2026.10.4_beta3（规则：<日期>_beta<序数>）
# 形态不符时输出空串，由 main 的格式守卫 fail-loud。
derive_version() {
    local tag="$1" date n
    date="$(printf '%s' "$tag" | sed -nE 's/^debug\.([0-9]+(\.[0-9]+){2})\..*$/\1/p')"
    n="$(printf '%s' "$tag" | sed -nE 's/.*[._-]([0-9]+)$/\1/p')"
    if [ -n "$date" ] && [ -n "$n" ]; then
        printf '%s_beta%s\n' "$date" "$n"
    else
        printf '\n'
    fi
}

main() {
    local tag version commit suffix hash_x86_64 hash_aarch64 asset tmpdir
    local old_tag old_commit old_rel old_hx old_ha
    local assets=()

    if [ -n "${FORK_RELEASE_TAG:-}" ]; then
        tag="$FORK_RELEASE_TAG"
    else
        tag="$(list_candidates | head -n 1)"
    fi
    [ -n "$tag" ] || { echo "error: 找不到 fork 的 debug.* release tag" >&2; exit 1; }

    version="$(derive_version "$tag")"
    # apk 版本号必须以数字开头；fork tag 形态变化时 derive_version 会产出空串 —— 宁可
    # fail-loud，也绝不把非法版本写进 Makefile。
    case "$version" in
        [0-9]*) ;;
        *) echo "error: ${tag} 派生出的版本号非法：'${version}'（期望格式 debug.<日期>.native-api.<序数> ⇒ <日期>_beta<序数>）" >&2; exit 1 ;;
    esac

    commit="$(fetch_commit "$tag")" \
        || { echo "error: 取不到 ${tag} 对应的 commit —— 停止跟随，不前进" >&2; exit 1; }
    [ -n "$commit" ] || { echo "error: 取不到 ${tag} 对应的 commit —— 停止跟随，不前进" >&2; exit 1; }

    # 资产名与 Makefile 的 HONK_ASSET 拼法一致（后缀由 Makefile 决定：置空 = 非 stock）
    suffix="$(makefile_var HONK_SUFFIX)"

    # 临时目录：基址经 pick_dl_base 过滤为 POSIX 形态（Windows 形态的 TMPDIR 会让
    # mktemp 返回 `C:\...`，既让 sha256sum 加转义前缀、也让清理失败并顶掉退出码）。
    local dl_base
    dl_base="$(pick_dl_base)"
    tmpdir="$(mktemp -d "${dl_base%/}/honk-dl.XXXXXX" 2>/dev/null || echo "${dl_base%/}/honk-dl.$$")"
    mkdir -p "$tmpdir"
    DL_TMP="$tmpdir"

    # 该 release 不公布 SHA256SUMS ⇒ 下载两个 musl 非 stock 资产自算哈希。
    # 下载失败即资产不可达 ⇒ fail-safe 停止、不写盘（宁可不更新，也不写一个取不到的 pin）。
    for asset in \
        "honk-core-debug-x86_64-unknown-linux-musl${suffix}.tar.gz" \
        "honk-core-debug-aarch64-unknown-linux-musl${suffix}.tar.gz"; do
        if ! fetch_asset "$tag" "$asset" "$tmpdir/$asset"; then
            echo "error: fork ${FORK_REPO} 的 ${tag} 取不到资产 ${asset}（或下载不完整） —— 停止跟随，不前进" >&2
            exit 1
        fi
        # 计算 sha256 **之前**的大小闸门（两种模式共用）：0 字节算出的 sha256 形态合法，
        # 却绝无可能是正确值 —— 宁可在这里停，也不要把错值钉进 Makefile。
        if [ ! -s "$tmpdir/$asset" ]; then
            echo "error: ${asset} 字节数为 0 —— 停止跟随，不前进" >&2
            exit 1
        fi
        assets+=("$asset")
    done
    hash_x86_64="$(sha256_of "$tmpdir/${assets[0]}")"
    hash_aarch64="$(sha256_of "$tmpdir/${assets[1]}")"
    assert_hash "$hash_x86_64" HONK_HASH_X86_64
    assert_hash "$hash_aarch64" HONK_HASH_AARCH64

    old_tag="$(makefile_var FORK_RELEASE_TAG)"
    old_commit="$(makefile_var HONK_COMMIT)"
    old_rel="$(makefile_var PKG_RELEASE)"
    old_hx="$(makefile_var HONK_HASH_X86_64)"
    old_ha="$(makefile_var HONK_HASH_AARCH64)"
    [ -n "$old_rel" ] || old_rel=1

    # 判变键 = commit + 两个 musl 哈希：
    #   · 三者都相同 ⇒ 一个字节都不改（git diff 为空、不触发重建）。
    #   · commit 未变但哈希变了（同一 tag 被就地替换资产）⇒ **必须**重新钉哈希：
    #     否则 URL 指向同一 tag 却校验新字节，CI 会一直失败、且因 commit 没变而永不自愈。
    if [ "$commit" = "$old_commit" ] \
        && [ "$hash_x86_64" = "$old_hx" ] && [ "$hash_aarch64" = "$old_ha" ]; then
        echo "honk core is up to date (fork=${tag}, commit=${commit}, PKG_VERSION=${version})"
        echo "HONK_HASH_X86_64=${hash_x86_64}"
        echo "HONK_HASH_AARCH64=${hash_aarch64}"
        return 0
    fi

    # 走到这里且 commit 未变 = 同一 release 被重新打包，记一条便于事后诊断
    if [ "$commit" = "$old_commit" ]; then
        echo "note: commit 未变但资产哈希已变（同一 release 被就地重新打包），重新钉哈希" >&2
    fi

    # 换了 tag：正常发布 ⇒ PKG_RELEASE 归 1；同一 tag 被重新打包 ⇒ 递增
    local next_rel
    if [ "$tag" = "$old_tag" ]; then
        next_rel=$((old_rel + 1))
    else
        next_rel=1
    fi

    # ── 原子写 ──────────────────────────────────────────────────────────────
    # 六处改动必须**一次性**落定。逐条 `sed -i` 是多条串行写：中途失败（磁盘满、信号、
    # 字段缺失）会留下「半新半旧」的 Makefile，而 update-honk.yml 紧接着用
    # `git diff --quiet` 判定 ⇒ 会把半成品当正常变更提交。故此处改成：
    #   ① 用 awk 把**完整**新内容写进同目录临时文件，且六个字段必须**全部命中**；
    #   ② 只做一次 `mv`（同目录 rename，原子替换）。
    # 任一步失败 ⇒ 原 Makefile 逐字节不变 + 非 0 退出。
    MK_TMP="$(mktemp "${MAKEFILE}.tmp.XXXXXX" 2>/dev/null || echo "${MAKEFILE}.tmp.$$")"
    if ! awk -v ver="$version" -v tag="$tag" -v cmt="$commit" \
             -v hx="$hash_x86_64" -v ha="$hash_aarch64" -v rel="$next_rel" '
        BEGIN { sv=st=sc=sx=sa=sr=0 }
        /^PKG_VERSION:=/       { print "PKG_VERSION:=" ver;       sv=1; next }
        /^FORK_RELEASE_TAG:=/  { print "FORK_RELEASE_TAG:=" tag;  st=1; next }
        /^HONK_COMMIT:=/       { print "HONK_COMMIT:=" cmt;       sc=1; next }
        /^HONK_HASH_X86_64:=/  { print "HONK_HASH_X86_64:=" hx;   sx=1; next }
        /^HONK_HASH_AARCH64:=/ { print "HONK_HASH_AARCH64:=" ha;  sa=1; next }
        /^PKG_RELEASE:=/       { print "PKG_RELEASE:=" rel;       sr=1; next }
        { print }
        END {
            if (!(sv && st && sc && sx && sa && sr)) {
                printf "error: Makefile 缺待更新字段（PKG_VERSION=%d FORK_RELEASE_TAG=%d HONK_COMMIT=%d HONK_HASH_X86_64=%d HONK_HASH_AARCH64=%d PKG_RELEASE=%d） —— 原文件未改，不前进\n", sv, st, sc, sx, sa, sr > "/dev/stderr"
                exit 1
            }
        }
    ' "$MAKEFILE" > "$MK_TMP"; then
        rm -f -- "$MK_TMP"; MK_TMP=""
        echo "error: 构造新 Makefile 失败 —— 原文件未改，不前进" >&2
        exit 1
    fi
    # 临时文件由 mktemp 建成 0600；显式对齐原文件权限，避免 mv 后权限漂移。
    chmod --reference="$MAKEFILE" "$MK_TMP" 2>/dev/null || chmod 644 "$MK_TMP" 2>/dev/null || true
    if ! mv -- "$MK_TMP" "$MAKEFILE"; then
        rm -f -- "$MK_TMP"; MK_TMP=""
        echo "error: 替换 Makefile 失败 —— 原文件未改，不前进" >&2
        exit 1
    fi
    MK_TMP=""

    echo "honk updated to fork=${tag} commit=${commit} (PKG_VERSION=${version}, PKG_RELEASE=${next_rel})"
    echo "FORK_RELEASE_TAG=${tag}"
    echo "HONK_COMMIT=${commit}"
    echo "HONK_HASH_X86_64=${hash_x86_64}"
    echo "HONK_HASH_AARCH64=${hash_aarch64}"
}

main "$@"
