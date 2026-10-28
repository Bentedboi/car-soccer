# The online server plus a headless Godot to run every match (server.js starts one per match).
# The game itself isn't baked in: server.js downloads the newest game.pck from the repo's
# GitHub Releases, so publishing a new game version updates the match servers too.
FROM node:20-bookworm-slim

ARG GODOT_VERSION=4.7.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    libfontconfig1 libx11-6 libxcursor1 libxinerama1 libxrandr2 libxi6 libxext6 libxrender1 libgl1 \
 && curl -fsSL -o /tmp/godot.zip \
    "https://github.com/godotengine/godot-builds/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip" \
 && unzip -q /tmp/godot.zip -d /tmp \
 && mv /tmp/Godot_v${GODOT_VERSION}-stable_linux.x86_64 /usr/local/bin/godot \
 && chmod +x /usr/local/bin/godot \
 && rm -rf /tmp/godot.zip /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./

ENV GODOT_BIN=/usr/local/bin/godot \
    GAME_DIR=/app/game \
    MAX_SIMS=4
EXPOSE 8080
CMD ["node", "server.js"]
