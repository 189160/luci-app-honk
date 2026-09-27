# Copyright (C) 2016 Openwrt.org

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-honk
PKG_VERSION:=2.0.0
PKG_RELEASE:=31

LUCI_TITLE:=LuCI support for honk
LUCI_PKGARCH:=all
LUCI_DEPENDS:=+honk

# i18n 包（luci-i18n-honk-*）的版本跟随本包，而不是 luci.mk 默认的 findrev 日期型版本
PKG_PO_VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
