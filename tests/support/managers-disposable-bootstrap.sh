#!/bin/sh
# Root bootstrap runs only inside the disposable container. Disktop runs as UID10001.
set -eu
test "$(id -u)" = 0
test -f /.dockerenv
test -f /workspace/disktop/tests/integration/managers-privileged.test.mjs
# Refuse a writable checkout before even bootstrapping packages.
awk '$5 == "/workspace/disktop" && $6 ~ /(^|,)ro(,|$)/ { isolated = 1 } END { exit !isolated }' /proc/self/mountinfo
test -f /run/disktop-gate-node
cp /run/disktop-gate-node /usr/local/bin/disktop-gate-node
chmod 0755 /usr/local/bin/disktop-gate-node
manager=$1
case "$manager" in
  apt)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends sudo util-linux passwd tar
    apt-get clean
    fixture=/var/cache/apt/archives/disktop-gate_1.0_all.deb
    command='/usr/bin/apt-get clean'
    ;;
  dnf)
    dnf -y --setopt=keepcache=True install sudo shadow-utils util-linux
    # Use a repository cache created by this real installation, not an unused
    # synthetic old-DNF path. Fedora's DNF5 defaults to /var/cache/libdnf5.
    cache=$(dnf --dump-main-config 2>/dev/null | sed -n 's/^system_cachedir = //p' | head -n 1)
    case "$cache" in /var/cache/libdnf5|/var/cache/dnf) ;; *) echo "unrecognized dnf system cache: $cache" >&2; exit 1 ;; esac
    packages=$(find "$cache" -mindepth 2 -maxdepth 2 -type d -name packages | head -n 1)
    test -n "$packages"
    dnf clean packages
    mkdir -p "$packages"
    fixture="$packages/disktop-gate-1.0-1.noarch.rpm"
    command='/usr/bin/dnf clean packages'
    ;;
  pacman)
    pacman -Syu --noconfirm --needed sudo shadow util-linux tar
    # --noconfirm accepts -Scc's default answer (no), so explicitly approve
    # emptying only this freshly bootstrapped disposable container cache.
    printf 'y\ny\n' | pacman -Scc
    fixture=/var/cache/pacman/pkg/disktop-gate-1.0-1-any.pkg.tar
    command='/usr/bin/pacman -Sc --noconfirm'
    ;;
  *) echo 'choose exactly apt, dnf, or pacman' >&2; exit 1 ;;
esac
useradd --uid 10001 --user-group --create-home --shell /bin/sh disktop-gate
mkdir -p /run/disktop-manager-gate /etc/sudoers.d
printf 'disktop-gate ALL=(root) NOPASSWD: %s\n' "$command" > /etc/sudoers.d/disktop-manager-gate
chmod 0440 /etc/sudoers.d/disktop-manager-gate
visudo -cf /etc/sudoers.d/disktop-manager-gate
if test "$manager" = pacman; then
  mkdir /run/disktop-manager-gate/package
  cat > /run/disktop-manager-gate/package/.PKGINFO <<'PKGINFO'
pkgname = disktop-gate
pkgbase = disktop-gate
pkgver = 1.0-1
pkgdesc = Disposable Disktop cache-cleanup fixture
url = https://github.com/Dijo-404/disktop
builddate = 1791374400
packager = Disktop fixture
size = 0
arch = any
PKGINFO
  tar -cf "$fixture" -C /run/disktop-manager-gate/package .PKGINFO
else
  printf 'Disposable Disktop package cache fixture\n' > "$fixture"
fi
chmod 0644 "$fixture"
printf 'Outside the package cache: preserve exactly\n' > /var/tmp/disktop-manager-preserved
chmod 0644 /var/tmp/disktop-manager-preserved
gate_node=/usr/local/bin/disktop-gate-node
"$gate_node" tests/support/managers-disposable-manifest.mjs "$manager" "$fixture"
runuser -u disktop-gate -- env HOME=/home/disktop-gate \
  XDG_CONFIG_HOME=/home/disktop-gate/config XDG_DATA_HOME=/home/disktop-gate/data \
  XDG_STATE_HOME=/home/disktop-gate/state XDG_CACHE_HOME=/home/disktop-gate/cache \
  DISKTOP_TEST_REAL_MANAGER="$manager" NO_COLOR=1 \
  "$gate_node" --test tests/integration/managers-privileged.test.mjs
