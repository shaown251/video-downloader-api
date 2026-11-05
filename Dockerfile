# Node 24 satisfies the current yt-dlp EJS Node runtime requirement (Node >= 22).
FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]" \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
