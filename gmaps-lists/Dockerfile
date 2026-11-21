# Image Playwright officielle : Node 22 + Chromium et ses dépendances (nécessaires à l'export F7).
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
