#!/usr/bin/env bash
# OpenEasyX 低内存 VPS 一键修复：加 swap -> 拉取代码 -> 构建 -> 启动 -> 验证
# 用法: bash vps-deploy.sh
set -uo pipefail

DIR="${EASYX_DIR:-$HOME/OpenEasyX}"
log(){ echo; echo "===== $* ====="; }

log "1/7 环境"
free -h
echo "-- swap --"; swapon --show || echo "(无 swap)"
cd "$DIR" 2>/dev/null || { echo "!! 目录不存在: $DIR  (可用 EASYX_DIR=路径 bash $0)"; exit 1; }

log "2/7 代码来源"
git remote -v 2>/dev/null | head -2
echo "-- HEAD --"; git log -1 --oneline 2>/dev/null
case "$(git remote get-url origin 2>/dev/null)" in
  *raccommode*) echo "!! 警告: origin 指向上游 raccommode，pull 到的是无登录功能的官方代码";;
esac

log "3/7 拉取更新"
git pull --ff-only 2>&1 | tail -3 || echo "!! pull 失败，沿用现有代码"

log "4/7 配置检查"
grep -q 'build:' compose.yaml 2>/dev/null \
  && echo "compose.yaml: 本地构建 OK" \
  || echo "!! compose.yaml 无 build 段(仍是官方镜像配置)，docker compose build 不会生效"
grep -q 'EASYX_SESSION_SECRET' .env 2>/dev/null \
  && echo ".env: 存在" \
  || echo "!! .env 缺失或不含 EASYX_SESSION_SECRET(见 .env.example)"

log "5/7 启用 swap"
if [ "$(swapon --show 2>/dev/null | wc -l)" -eq 0 ]; then
  fallocate -l 4G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap 已启用"
fi
free -h | grep -i swap

log "6/7 构建镜像(耗时较久)"
if grep -q 'SKIP_TYPECHECK' Dockerfile 2>/dev/null; then
  echo "使用 SKIP_TYPECHECK=true(跳过 tsc，省内存)"
  docker compose build --build-arg SKIP_TYPECHECK=true 2>&1 | tail -15
else
  echo "旧版 Dockerfile -> 临时改为只跑 vite build(原文件备份为 Dockerfile.bak)"
  cp -n Dockerfile Dockerfile.bak 2>/dev/null
  sed -i 's|^RUN npm run build$|RUN npx vite build|' Dockerfile
  sed -n '6p' Dockerfile
  docker compose build 2>&1 | tail -15
fi

log "7/7 启动并验证"
docker compose up -d 2>&1 | tail -5
sleep 10
echo "-- 容器状态 --"; docker compose ps 2>/dev/null | tail -3
echo "-- 端口探测 --"
printf "auth/me(期望401): %s\n" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3210/api/auth/me)"
printf "health  (期望200): %s\n" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3210/api/health)"
printf "首页    (期望200): %s\n" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3210/)"
echo "-- 密码/密钥日志 --"
docker compose logs open-easyx 2>/dev/null | grep -iE "password|session secret" | tail -3
echo
echo "完成。把以上输出整体贴回即可。"
