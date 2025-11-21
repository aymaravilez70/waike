FROM node:20

WORKDIR /app
COPY . .

# Instala yt-dlp directamente desde apt (sin pip)
RUN apt-get update && apt-get install -y yt-dlp

RUN npm install
CMD ["node", "server.js"]
