#!/usr/bin/env bash
# ============================================================================
# Redeploy local de BioAgents (host con docker compose)
# ----------------------------------------------------------------------------
# Reconstruye la imagen (rehorneando el bundle del cliente con el .env actual)
# y recrea el contenedor. Usar cada vez que cambies el código o las variables
# que se hornean en el cliente: SUPABASE_URL, SUPABASE_ANON_KEY, PRIVY_APP_ID,
# CDP_PROJECT_ID, CORALGPT_HERO_VIDEO_URL.
#
# Para solo recargar documentos nuevos de /docs NO hace falta esto: alcanza con
#   docker compose restart bioagents
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Building image (esto puede tardar varios minutos)..."
docker compose build bioagents

echo "==> Recreating container..."
docker compose up -d --force-recreate bioagents

echo "==> Estado:"
docker compose ps bioagents
echo "==> Listo. Recordá recargar la página en el navegador (Ctrl+Shift+R)."
