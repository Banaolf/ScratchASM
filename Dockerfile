# For macOS / Windows users (or anyone who doesn't want NASM on their machine).
#   docker build --platform linux/amd64 -t scratchasm .
#   docker run --rm --platform linux/amd64 -p 127.0.0.1:3000:3000 -v scratchasm-data:/data scratchasm
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends nasm binutils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
VOLUME /data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
