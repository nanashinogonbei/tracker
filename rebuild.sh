#!/bin/bash

# エラーが発生したら即座に中断する設定
set -e

echo "--- 1. 既存コンテナの停止と不要なリソースの削除 ---"
# docker compose down -v
# docker compose down --rmi all
docker compose down --remove-orphans

echo "--- 2. キャッシュを使用せずにイメージをビルド ---"
docker compose build --no-cache

echo "--- 3. コンテナをバックグラウンドで起動 ---"
docker compose up -d

# docker compose logs -f app

# echo "--- 4. DB接続 ---"
# docker compose exec mongodb mongosh
