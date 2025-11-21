const express = require('express');
const cors = require('cors');
const youtubedl = require('yt-dlp-exec');
const redis = require('redis');
const fs = require('fs');
const path = require('path');

// Depuración: imprime la URL que está usando
console.log('REDIS_URL:', process.env.REDIS_URL);

// Conexión segura a Redis (solo la URL que da Railway)
const client = redis.createClient({
  url: process.env.REDIS_URL
});

client.on('error', (err) => console.log('Redis Client Error', err));

(async () => {
  await client.connect();
  console.log('✅ Redis connection successful!');
})();

const app = express();
app.use(cors());
app.use(express.json());

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR);
}

// ENDPOINT /api/song-url
app.post('/api/song-url', async (req, res) => {
  const { title, artist } = req.body;
  if (!title || !artist) {
    return res.status(400).json({ error: 'Missing info' });
  }
  const searchKey = `${title.toLowerCase()}-${artist.toLowerCase()}-ytid`;

  try {
    let videoId = await client.get(searchKey);

    // Buscar video si no está en caché
    if (!videoId) {
      const query = `${title} ${artist} audio`;
      console.log(`🔍 Searching: ${query}`);
      
      const result = await youtubedl(`ytsearch1:${query}`, {
        dumpSingleJson: true,
        defaultSearch: "ytsearch",
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        addHeader: [
          'referer:youtube.com',
          'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        ]
      });
      
      const first = result.entries && result.entries[0];
      if (!first || !first.id) {
        return res.status(404).json({ error: 'No video found' });
      }
      videoId = first.id;
      
      // Cachear videoId por 7 días
      await client.set(searchKey, videoId, { EX: 604800 });
      console.log(`✅ Cached videoId: ${videoId}`);
    } else {
      console.log(`📦 Using cached videoId: ${videoId}`);
    }

    // IMPORTANTE: Siempre generar URL fresca (no cachear)
    console.log(`🎵 Getting fresh stream URL for: ${videoId}`);
    const streamRes = await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
      dumpSingleJson: true,
      format: 'bestaudio/best',
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      ]
    });
    
    if (!streamRes.url) {
      return res.status(404).json({ error: 'No audio URL found' });
    }

    console.log(`✅ Stream URL generated successfully`);
    res.json({
      url: streamRes.url,
      title: streamRes.title,
      videoUrl: streamRes.webpage_url,
      duration: streamRes.duration,
      thumbnail: streamRes.thumbnail
    });
    
  } catch (err) {
    console.error('❌ Error in /api/song-url:', err.message);
    res.status(500).json({ 
      error: 'Error finding audio', 
      detail: err.message 
    });
  }
});

// ENDPOINT /api/download
app.post('/api/download', async (req, res) => {
  const { title, artist, songId } = req.body;

  if (!title || !artist || !songId) {
    return res.status(400).json({ error: 'Missing title, artist or songId' });
  }

  const searchKey = `${title.toLowerCase()}-${artist.toLowerCase()}-ytid`;

  try {
    let videoId = await client.get(searchKey);

    if (!videoId) {
      const query = `${title} ${artist} audio`;
      console.log(`🔍 Searching for download: ${query}`);
      
      const result = await youtubedl(`ytsearch1:${query}`, {
        dumpSingleJson: true,
        defaultSearch: "ytsearch",
        noCheckCertificates: true,
        noWarnings: true
      });
      
      const first = result.entries && result.entries[0];
      if (!first || !first.id) {
        return res.status(404).json({ error: 'No video found' });
      }
      videoId = first.id;
      await client.set(searchKey, videoId, { EX: 604800 });
    }

    const outputPath = path.join(TEMP_DIR, `${songId}.mp3`);

    console.log(`📥 Downloading: ${title} - ${artist}`);

    await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
      output: outputPath,
      format: 'bestaudio[ext=m4a]/bestaudio',
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      noCheckCertificates: true,
      noWarnings: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0'
      ]
    });

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Download failed' });
    }

    const stats = fs.statSync(outputPath);
    const fileSize = stats.size;

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Disposition', `attachment; filename="${songId}.mp3"`);

    const fileStream = fs.createReadStream(outputPath);

    fileStream.pipe(res);

    fileStream.on('end', () => {
      fs.unlinkSync(outputPath);
      console.log(`✅ Download sent and cleaned: ${songId}`);
    });

    fileStream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream error' });
      }
    });

  } catch (err) {
    console.error('❌ Download error:', err.message);
    res.status(500).json({ 
      error: 'Error downloading', 
      detail: err.message 
    });
  }
});

// Servidor para Railway
const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
