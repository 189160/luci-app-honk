# SPDX-License-Identifier: GPL-2.0-only

include $(TOPDIR)/rules.mk

PKG_NAME:=honk
PKG_VERSION:=2026.10.4_beta3
PKG_RELEASE:=2

# 核心来源：Glassyiris/honk（honk fork）的 release 资产。该构建带 native-api 与内嵌面板
# （cargo feature 含 native-ui），因此 `ui: 'embedded'` 与目录形式都可用。
#
# 锚点 = fork 的 `debug.*` release 里版本最高的那个。
# 配对代价（如实记录）：面板更新跟随 doona 的最新 release、不做钉版，而核心取 fork 绝对
# 最新 —— 于是目录形式下面板会长期落后核心一代（`Invalid probe request.` 那类症状），
# 故推荐 `ui: 'embedded'`，面板随核心字节走。
#   FORK_RELEASE_TAG  fork release tag（拼资产 URL、并据此派生 PKG_VERSION）
#   HONK_COMMIT       该构建的上游 commit（更新脚本判变与溯源）
FORK_RELEASE_TAG:=debug.2026.10.4.native-api.3
HONK_COMMIT:=186353d1bffcd832774d6e57cc621df68e2c4634

# 两个 musl（非 stock）资产的 sha256。该 fork release 不公布 SHA256SUMS，故由
# scripts/update_honk_version.sh 下载两个 musl 非 stock 资产后自行计算（PKG_HASH 会
# 让 CI 在字节不符时 fail-loud）。x86_64 一处另有独立实下核对。
HONK_HASH_X86_64:=fd39e4787ff9a3645fe40d2dcde3590e06691f4b67ae7038ba04519e20982a0a
HONK_HASH_AARCH64:=a02011ae351793c62875dbc507868a3f5c5ce16cb7e9abac3f86fcbaa4583712

PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=luci-app-honk maintainers

ifeq ($(ARCH),x86_64)
  HONK_TARGET:=x86_64-unknown-linux-musl
  HONK_HASH:=$(HONK_HASH_X86_64)
else ifeq ($(ARCH),aarch64)
  HONK_TARGET:=aarch64-unknown-linux-musl
  HONK_HASH:=$(HONK_HASH_AARCH64)
endif

# 置空 = 非 stock（mimalloc）；上游同时提供 stock 变体，命名后缀不同
HONK_SUFFIX:=
HONK_ASSET:=honk-core-debug-$(HONK_TARGET)$(HONK_SUFFIX).tar.gz

PKG_SOURCE:=$(HONK_ASSET)
PKG_SOURCE_URL:=https://github.com/Glassyiris/honk/releases/download/$(FORK_RELEASE_TAG)/
PKG_HASH:=$(HONK_HASH)

include $(INCLUDE_DIR)/package.mk

define Package/honk
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=honk - eBPF transparent proxy engine (dae-compatible)
  URL:=https://github.com/daeuniverse/honk
  DEPENDS:=@(x86_64||aarch64) \
    +ca-bundle +ip-full \
    +kmod-sched-core +kmod-sched-bpf +kmod-veth +kmod-nft-queue \
    +v2ray-geoip +v2ray-geosite \
    +@KERNEL_XDP_SOCKETS
endef

define Package/honk/conffiles
/etc/honk/
/etc/config/honk
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(TAR) -xzf $(DL_DIR)/$(PKG_SOURCE) -C $(PKG_BUILD_DIR) --strip-components=1
endef

define Build/Compile
	true
endef

define Package/honk/install
	# package-pack.mk 把本定义展开为单条 recipe 行、由单个 sh -c 执行：退出码取自
	# 最后一条命令，前面的失败会被掩蔽。首行 set -e 与之对冲。
	set -e
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/honk-core $(1)/usr/bin/honk-core

	$(INSTALL_DIR) $(1)/etc/honk/config.d
	$(INSTALL_CONF) $(CURDIR)/files/config.dae $(1)/etc/honk/config.dae
	$(INSTALL_CONF) $(CURDIR)/files/config.d/node.dae $(1)/etc/honk/config.d/node.dae
	$(INSTALL_CONF) $(CURDIR)/files/config.d/route.dae $(1)/etc/honk/config.d/route.dae
	$(INSTALL_CONF) $(CURDIR)/files/config.d/dns.dae $(1)/etc/honk/config.d/dns.dae
	# native_api 配置参考（随包附带，enabled: false 保持不启动；conffile ⇒ 升级不会覆盖用户改动）
	$(INSTALL_CONF) $(CURDIR)/files/config.d/api.dae $(1)/etc/honk/config.d/api.dae

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) $(CURDIR)/files/honk.config $(1)/etc/config/honk

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) $(CURDIR)/files/honk.init $(1)/etc/init.d/honk

	# 再分发伴随义务：核心归档顶层 LICENSE（GPL-3.0）＋ 内嵌面板随核心字节一并分发的
	# doona/ 声明（LICENSE / NOTICE / THIRD-PARTY-NOTICES.txt / LICENSES/*.txt；通配吃下
	# 上游后续新增的许可文件）。LICENSE 一条置于 recipe 末尾：退出码即它的成败。
	$(INSTALL_DIR) $(1)/usr/share/licenses/honk/doona/LICENSES
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/doona/LICENSE $(1)/usr/share/licenses/honk/doona/LICENSE
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/doona/NOTICE $(1)/usr/share/licenses/honk/doona/NOTICE
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/doona/THIRD-PARTY-NOTICES.txt $(1)/usr/share/licenses/honk/doona/THIRD-PARTY-NOTICES.txt
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/doona/LICENSES/*.txt $(1)/usr/share/licenses/honk/doona/LICENSES/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/LICENSE $(1)/usr/share/licenses/honk/LICENSE
endef

$(eval $(call BuildPackage,honk))
