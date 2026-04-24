#!/bin/bash

# Tonel 版本号统一更新脚本
# 用法: ./scripts/bump-version.sh <new_version>
# 示例: ./scripts/bump-version.sh 0.4.0

set -euo pipefail

if [ $# -ne 1 ]; then
    echo "用法: $0 <new_version>"
    echo "示例: $0 0.4.0"
    exit 1
fi

NEW_VERSION="$1"

# 验证版本号格式
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "❌ 版本号格式错误: $NEW_VERSION"
    echo "   必须为 MAJOR.MINOR.PATCH（如 0.4.0）"
    exit 1
fi

# 获取当前版本
CURRENT_VERSION=$(grep -oP 'project\(Tonel VERSION \K[0-9]+\.[0-9]+\.[0-9]+' CMakeLists.txt 2>/dev/null || echo "unknown")
echo "当前版本: $CURRENT_VERSION"
echo "目标版本: $NEW_VERSION"
echo ""

if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
    echo "❌ 新版本号与当前版本相同"
    exit 1
fi

# 需要更新的文件列表
FILES=(
    "CMakeLists.txt"
    "Tonel-Desktop-AppKit/CMakeLists.txt"
    "server/CMakeLists.txt"
    "web/package.json"
    "config.schema.json"
)

echo "📋 将要更新以下文件:"
for f in "${FILES[@]}"; do
    if [ -f "$f" ]; then
        echo "   ✅ $f"
    else
        echo "   ❌ $f (不存在!)"
        exit 1
    fi
done
echo ""

read -rp "确认更新? (y/N) " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "已取消"
    exit 0
fi

# 执行替换
echo ""

# 1. CMakeLists.txt (根)
sed -i '' "s/project(Tonel VERSION $CURRENT_VERSION/project(Tonel VERSION $NEW_VERSION/" CMakeLists.txt
sed -i '' "s/message(STATUS \"Tonel v$CURRENT_VERSION\")/message(STATUS \"Tonel v$NEW_VERSION\")/" CMakeLists.txt
echo "   ✅ CMakeLists.txt"

# 2. Tonel-Desktop-AppKit/CMakeLists.txt
sed -i '' "s/VERSION $CURRENT_VERSION/VERSION $NEW_VERSION/" Tonel-Desktop-AppKit/CMakeLists.txt
echo "   ✅ Tonel-Desktop-AppKit/CMakeLists.txt"

# 3. server/CMakeLists.txt
sed -i '' "s/VERSION $CURRENT_VERSION/VERSION $NEW_VERSION/" server/CMakeLists.txt
echo "   ✅ server/CMakeLists.txt"

# 4. web/package.json
sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" web/package.json
echo "   ✅ web/package.json"

# 5. config.schema.json
sed -i '' "s/\"default\": \"$CURRENT_VERSION\"/\"default\": \"$NEW_VERSION\"/" config.schema.json
echo "   ✅ config.schema.json"

echo ""
echo "🔍 验证:"
echo "   Root CMake:   $(grep -oP 'project\(Tonel VERSION \K[^\s]+' CMakeLists.txt)"
echo "   AppKit CMake: $(grep -oP 'VERSION \K[0-9]+\.[0-9]+\.[0-9]+' Tonel-Desktop-AppKit/CMakeLists.txt)"
echo "   Server CMake: $(grep -oP 'VERSION \K[0-9]+\.[0-9]+\.[0-9]+' server/CMakeLists.txt)"
echo "   Web package:  $(grep -oP '\"version\": \"\K[^\"]+' web/package.json)"
echo "   Config schema:$(grep -oP '\"default\": \"\K[0-9]+\.[0-9]+\.[0-9]+' config.schema.json | tail -1)"

echo ""
echo "📝 下一步:"
echo "   1. 在 CHANGELOG.md 顶部添加 v$NEW_VERSION 条目 (Keep a Changelog 格式)"
echo "   2. git add -A && git commit -m \"release: v$NEW_VERSION\""
echo "   3. git tag -a v$NEW_VERSION -m \"v$NEW_VERSION\""
echo "   4. git push origin main --tags"
