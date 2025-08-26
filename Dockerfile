FROM node:20-bookworm-slim

# Install Chromium and required libs for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    curl \
    procps \        # <— adds pkill/pgrep
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libxkbcommon0 \
    libxshmfence1 \
    wget \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV XDG_CONFIG_HOME=/tmp/xdg
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["npm","start"]
