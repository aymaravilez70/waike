const express = require('express');
const cors = require('cors');
const youtubedl = require('yt-dlp-exec');
const redis = require('redis');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

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

// Base URL del backend (Railway lo provee automáticamente)
const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://waike-production.up.railway.app';

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

        // DEVOLVER URL DEL PROXY (no la URL directa de YouTube)
        const streamUrl = `${BACKEND_URL}/api/stream/${videoId}`;

        console.log(`✅ Stream URL generated: ${streamUrl}`);
        res.json({
            url: streamUrl,
            videoId: videoId,
            title: title,
            artist: artist
        });

    } catch (err) {
        console.error('❌ Error in /api/song-url:', err.message);
        res.status(500).json({
            error: 'Error finding audio',
            detail: err.message
        });
    }
});

// ENDPOINT /api/stream/:videoId (MEJORADO - MEJOR MANEJO DE FORMATOS)
app.get('/api/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;

    if (!videoId) {
        return res.status(400).json({ error: 'Missing videoId' });
    }

    // Función helper para intentar obtener el stream con reintentos
    async function attemptStream(retryCount = 0) {
        try {
            console.log(`🎵 Streaming audio for videoId: ${videoId} (attempt ${retryCount + 1}/3)`);

            // MEJORA: Especificar formatos compatibles con expo-av
            const info = await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
                dumpSingleJson: true,
                format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio', // Formatos más compatibles
                noCheckCertificates: true,
                noWarnings: true,
                preferFreeFormats: true,
                extractAudio: true, // Asegurar que sea solo audio
                audioFormat: 'best', // Mejor calidad de audio
                addHeader: [
                    'referer:youtube.com',
                    'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                ]
            });

            if (!info.url) {
                throw new Error('No audio URL found');
            }

            return info.url;
        } catch (err) {
            // Si falla y no hemos agotado los reintentos (máximo 3 intentos)
            if (retryCount < 2) {
                console.log(`⚠️ Attempt ${retryCount + 1} failed: ${err.message}`);
                console.log(`🔄 Retrying in 1 second...`);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Aumentado a 1 segundo
                return attemptStream(retryCount + 1);
            }
            // Si agotamos los 3 intentos, lanzar el error
            throw err;
        }
    }

    try {
        // Intentar obtener URL del stream (con hasta 3 intentos)
        const streamUrl = await attemptStream();

        console.log(`📡 Proxying stream from YouTube...`);

        // Determinar protocolo (http o https)
        const protocol = streamUrl.startsWith('https') ? https : http;

        // Hacer request al stream de YouTube
        protocol.get(streamUrl, (audioStream) => {
            // MEJORA: Headers más compatibles
            res.setHeader('Content-Type', 'audio/mpeg'); // Forzar MPEG para compatibilidad
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive'); // Mantener conexión viva

            if (audioStream.headers['content-length']) {
                res.setHeader('Content-Length', audioStream.headers['content-length']);
            }

            // Pipe el stream de YouTube directamente al cliente
            audioStream.pipe(res);

            audioStream.on('error', (err) => {
                console.error('❌ Audio stream error:', err.message);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Stream error' });
                }
            });

            audioStream.on('end', () => {
                console.log(`✅ Stream completed for videoId: ${videoId}`);
            });
        }).on('error', (err) => {
            console.error('❌ Request error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Request error' });
            }
        });

    } catch (err) {
        console.error('❌ Error streaming after 3 attempts:', err.message);
        res.status(500).json({
            error: 'Error streaming audio',
            detail: err.message
        });
    }
});

// HANDLER UNIFICADO PARA DESCARGAS (GET Y POST)
const downloadHandler = async (req, res) => {
    // Support both query (GET) and body (POST)
    const title = req.query.title || req.body.title;
    const artist = req.query.artist || req.body.artist;
    const songId = req.query.songId || req.body.songId;

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
};

// REGISTRAR LA RUTA PARA GET (Nuevo) Y POST (Legacy)
app.get('/api/download', downloadHandler);
app.post('/api/download', downloadHandler);

// Servidor para Railway
const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Backend running on port ${PORT}`);
    console.log(`📡 Backend URL: ${BACKEND_URL}`);
});
