#!/usr/bin/env bash
#
# 环境自检：Camoufox（无头 Firefox 指纹浏览器）能不能在**你这台机器上**跑通。
#
# 这是 P0-13 的落地检查。它回答一个问题：
#   「L2 抓取链路在这台机器上成立吗？」
#
# 为什么需要它：插件抓正文要靠 Camoufox 起一个无头浏览器。如果这一步不通，
# 后面的步骤全都是白折腾 —— 而且失败的表现可能是「卡住不动、没有任何报错」。
# 先花几十秒把它验掉，比在界面里试错划算得多。
#
# 用法：
#   ./scripts/probe/selfcheck.sh            # 默认最多等 240 秒
#   ./scripts/probe/selfcheck.sh 120        # 自定义超时
#
# 注意：脚本**带硬超时**，即使卡住也会自己退出，不会一直挂着。

set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
LIMIT="${1:-240}"

echo "======================================================"
echo " dsh-wechat-mp · 环境自检（Camoufox / P0-13）"
echo "======================================================"
echo "仓库目录：$(pwd)"
echo "超时上限：${LIMIT} 秒（到点自动杀掉，不会一直挂着）"
echo

# ---------------------------------------------------------------------------
echo "--- 1/3 环境变量 ---"
echo "node           : $(node -v 2>/dev/null || echo '取不到')"

if [ -n "${NODE_OPTIONS:-}" ]; then
  echo "NODE_OPTIONS   : 有值 ⚠️"
  echo "                 它会让 Camoufox 一起动就被杀。请改用下面这条重跑："
  echo "                 env -u NODE_OPTIONS -u NODE_REPL_EXTERNAL_MODULE ./scripts/probe/selfcheck.sh"
else
  echo "NODE_OPTIONS   : 空（正常）"
fi

PROXY_COUNT="$(env | grep -ciE '^(http|https|all)_proxy=' || true)"
echo "代理环境变量   : ${PROXY_COUNT} 个"
if [ "${PROXY_COUNT}" -gt 0 ]; then
  echo "                 浏览器不一定会用这些变量；若本机是 TUN 模式则无妨。"
fi
echo

# ---------------------------------------------------------------------------
echo "--- 2/3 Camoufox 浏览器二进制 ---"
BROWSER_DIR="${HOME}/Library/Caches/camoufox"
BROWSER_APP="${BROWSER_DIR}/Camoufox.app"
if [ -d "${BROWSER_APP}" ]; then
  echo "✅ 已就位：${BROWSER_APP}"
  echo "   体积：$(du -sh "${BROWSER_APP}" 2>/dev/null | cut -f1)"
else
  echo "❌ 没找到：${BROWSER_APP}"
  echo "   可能还没下载。先试：pnpm exec camoufox fetch"
  echo "   （或让 spider-claw 跑一次，它会自己拉）"
  exit 2
fi
echo

# ---------------------------------------------------------------------------
echo "--- 3/3 实跑一次（抓一篇真实文章）---"

if [ "${SKIP_RUN:-0}" = "1" ]; then
  echo "（SKIP_RUN=1，跳过实跑。只检查了环境变量与浏览器二进制。）"
  exit 0
fi

echo "这一步会真的启动浏览器、渲染页面、下载图片，最多等 ${LIMIT} 秒…"
echo
START="$(date +%s)"

# 用 perl 的 alarm 做硬超时（macOS 默认没有 timeout 命令）
perl -e 'alarm shift; exec @ARGV' "${LIMIT}" \
  ./node_modules/.bin/tsx scripts/probe/l2-camoufox-host.ts
CODE=$?

ELAPSED=$(( $(date +%s) - START ))
echo
echo "======================================================"
echo " 结果：退出码 ${CODE} · 耗时 ${ELAPSED} 秒"
echo "======================================================"

if [ "${CODE}" -eq 0 ]; then
  echo "✅ 自检通过。"
  echo "   Camoufox 在你这台机器上能跑通 → L2 抓取链路成立。"
  echo "   接下来可以直接起 dsh web 做界面验证了。"
elif [ "${CODE}" -ge 128 ]; then
  echo "⏱ 超时或被信号终止（退出码 ${CODE}；142 表示到 ${LIMIT} 秒被杀，137 表示 SIGKILL）。"
  echo "   这通常意味着浏览器起不来、或起来了但加载不了页面。"
  echo "   把上面的完整输出发我。"
else
  echo "❌ 自检失败（退出码 ${CODE}）。请把上面的完整输出发我。"
fi

echo
if pgrep -f "Camoufox.app" >/dev/null 2>&1; then
  echo "ℹ️ 还有 Camoufox 进程残留，清理命令："
  echo "   pkill -f Camoufox.app"
fi
