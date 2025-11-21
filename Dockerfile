FROM node:20

WORKDIR /app
COPY . .

# Instala Python y pip
RUN apt-get update && apt-get install -y python3 python3-pip

# Instala yt-dlp
RUN pip3 install yt-dlp

# Instala dependencias Node.js
RUN npm install

CMD ["node", "server.js"]
