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

// --- HELPER FUNCIONS ---

// Función centralizada para resolver y cachear URL (con Redis)
// Se usa tanto en /stream (si falta caché) como en /pre-cache (prefetch)
async function resolveAndCache(videoId) {
    const streamKey = `stream_url:${videoId}`;

    console.log(`🔄 Resolving fresh URL for ${videoId}...`);
    const info = await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
        dumpSingleJson: true,
        format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        extractAudio: true,
        addHeader: [
            'referer:youtube.com',
            'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        ]
    });

    if (!info.url) throw new Error('No audio URL found');

    // Cachear la URL real por 45 minutos
    await client.set(streamKey, info.url, { EX: 2700 });
    console.log(`✅ Cached stream URL for ${videoId} (TTL 45m)`);

    return info.url;
}

// --- ENDPOINTS ---

// NEW ENDPOINT: /api/pre-cache/:videoId (PREFETCH + LOCKING)
// Este endpoint es llamado por el frontend 5s después de empezar una canción
// para preparar la siguiente sin descargarla aún.
app.post('/api/pre-cache/:videoId', async (req, res) => {
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

    const streamKey = `stream_url:${videoId}`;
    const lockKey = `resolving:${videoId}`;

    try {
        // 1. Check Cache
        const exists = await client.exists(streamKey);
        if (exists) {
            console.log(`✨ Pre-cache Hit (Already cached): ${videoId}`);
            return res.status(200).json({ status: 'cached' });
        }

        // 2. Check Lock (Concurrency Protection)
        // SetNX devuelve true si seteó la key (no existía), false si ya existía
        const isLocked = await client.set(lockKey, '1', { NX: true, EX: 30 }); // TTL 30s para el lock

        if (!isLocked) {
            console.log(`🔒 Resource locked (Already resolving): ${videoId}`);
            return res.status(202).json({ status: 'resolving' }); // 202 Accepted
        }

        // 3. Resolve (Critical Section)
        await resolveAndCache(videoId);

        // 4. Release Lock
        await client.del(lockKey);

        res.status(200).json({ status: 'resolved' });

    } catch (err) {
        console.error(`❌ Pre-cache error for ${videoId}:`, err.message);
        // Clean lock on error
        await client.del(lockKey);
        res.status(500).json({ error: 'Pre-cache failed' });
    }
});


// ENDPOINT /api/stream/:videoId (OPTIMIZED - CACHING + RANGE SUPPORT)
app.get('/api/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const range = req.headers.range;

    if (!videoId) {
        return res.status(400).json({ error: 'Missing videoId' });
    }

    const streamKey = `stream_url:${videoId}`;

    // Helper to pipe stream
    function pipeStream(url, isRetry = false) {
        const protocol = url.startsWith('https') ? https : http;

        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        };

        // Forward Range header if present
        if (range) {
            options.headers['Range'] = range;
            // console.log(`⏩ Seeking: ${range}`);
        }

        const request = protocol.get(url, options, (streamRes) => {
            // Check for valid response (YouTube returns 403 if URL expired)
            if (streamRes.statusCode === 403 || streamRes.statusCode === 404) {
                console.warn(`⚠️ Cached URL expired/invalid (${streamRes.statusCode})...`);
                if (!isRetry) {
                    // Retry with fresh URL logic
                    // We invalidate cache explicitely here? 
                    // resolveAndCache will overwrite old cache key.
                    return resolveAndCache(videoId)
                        .then(newUrl => pipeStream(newUrl, true))
                        .catch(err => {
                            console.error('❌ Retry failed:', err.message);
                            if (!res.headersSent) res.status(500).json({ error: 'Retry failed' });
                        });
                } else {
                    if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
                    return;
                }
            }

            // Forward crucial headers
            const headersArgs = {
                'Content-Type': 'audio/mpeg', // Force MPEG specifically for React Native Track Player/Expo AV
                'Content-Length': streamRes.headers['content-length'],
                'Content-Range': streamRes.headers['content-range'],
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache'
            };

            // Only set headers that exist (avoid undefined)
            Object.keys(headersArgs).forEach(key => {
                if (headersArgs[key]) res.setHeader(key, headersArgs[key]);
            });

            // Set correct status code (206 for Partial Content, 200 for full)
            if (streamRes.statusCode === 206 || streamRes.statusCode === 200) {
                res.status(streamRes.statusCode);
            }

            streamRes.pipe(res);

            streamRes.on('end', () => {
                // console.log(`✅ Stream finished: ${videoId}`);
            });

        }).on('error', (err) => {
            console.error('❌ Request error:', err.message);
            if (!res.headersSent) res.status(500).json({ error: 'Stream request error' });
        });
    }

    try {
        // 3. Main Flow
        // Try Cache First
        let streamUrl = await client.get(streamKey);

        if (streamUrl) {
            console.log(`⚡ Instant Play (Cache Hit): ${videoId}`);
            pipeStream(streamUrl);
        } else {
            console.log(`🐢 Cache Miss: ${videoId}`);
            // Use shared helper
            streamUrl = await resolveAndCache(videoId);
            pipeStream(streamUrl);
        }

    } catch (err) {
        console.error('❌ Critical Error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Server error' });
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
