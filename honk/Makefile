# SPDX-License-Identifier: GPL-2.0-only

include $(TOPDIR)/rules.mk

PKG_NAME:=honk
PKG_VERSION:=2026.10.25_beta2
PKG_RELEASE:=1

# 核心来源：上游 daeuniverse/honk 的 `v*` release 资产（预编译，免自建）。
# 随包变体 = native-api（非 stock，即 mimalloc），cargo feature 为
# ebpf,rprx,native-api,mimalloc —— **不含 native-ui，也不含 clash-api**。
# 因此面板走目录形式：在 api.dae 里写 `ui: 'embedded'` 会让核心启动失败
# （embedded native UI requires the native-ui feature）。
#
# 版本派生：release published_at 的 UTC 日期 + tag 的 beta 序数 ⇒ <日期>_beta<序数>。
#
#   HONK_RELEASE_TAG  上游 release tag（拼资产 URL、并据此派生 PKG_VERSION）
#   HONK_COMMIT       该 tag 对应的 commit（更新脚本判变与溯源）
HONK_RELEASE_TAG:=v0.1.0-beta.2
HONK_COMMIT:=399f6985e7a6cfb78a33a0c71b3248f7eafef22e

# 两个 musl（native-api = mimalloc）资产的 sha256，取自上游 release 的 SHA256SUMS；
# scripts/update_honk_version.sh 会再下载两个资产做一次交叉校验（PKG_HASH 让 CI 在
# 字节不符时 fail-loud）。
HONK_HASH_X86_64:=b08a734f79ddabadbf0e5c9554379c9af65968b344de1efe57b20d18aa5899e3
HONK_HASH_AARCH64:=49f5d74059de8502428cb867fc721cd4dacbe4ea4d079d4265158ca252f2fa9d

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

# 变体后缀：-native-api = 非 stock（mimalloc）；上游另有 -stock / -clash-api / -full
HONK_VARIANT:=-native-api
HONK_ASSET:=honk-core-$(HONK_RELEASE_TAG)-$(HONK_TARGET)$(HONK_VARIANT).tar.gz

PKG_SOURCE:=$(HONK_ASSET)
PKG_SOURCE_URL:=https://github.com/daeuniverse/honk/releases/download/$(HONK_RELEASE_TAG)/
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

	# 再分发伴随义务：核心归档顶层的 LICENSE（GPL-3.0）。精简变体的归档内没有 doona/。
	# 该条置于 recipe 末尾：退出码即它的成败。
	$(INSTALL_DIR) $(1)/usr/share/licenses/honk
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/LICENSE $(1)/usr/share/licenses/honk/LICENSE
endef

$(eval $(call BuildPackage,honk))
