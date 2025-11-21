FROM node:18

# Instalar yt-dlp y ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp \
    && apt-get clean

WORKDIR /app

# Copiar package.json y package-lock.json
COPY package*.json ./

# Instalar dependencias de Node.js
RUN npm install

# Copiar el código fuente
COPY . .

# Exponer el puerto
EXPOSE 8080

# Comando para iniciar el servidor
CMD ["node", "server.js"]
