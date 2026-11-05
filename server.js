/*
 * Video Downloader API
 * Endpoints:
 *   GET /                 service status
 *   GET /health            health check
 *   GET /info?url=         video metadata and available output choices
 *   GET /download?url=&format=  download an allowed, accessible video
 *
 * Only use this service for content you own or are authorized to download.
 */
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_SEC = Number(process.env.MAX_SECONDS) || 3600;
// One concurrent job is safer on Render Free (0.1 CPU / 512 MB RAM).
const MAX_JOBS = Math.max(1, Number(process.env.MAX_JOBS) || 1);

const HOSTS = /^(?:[\w-]+\.)*(youtube\.com|youtu\.be|facebook\.com|fb\.watch|instagram\.com|tiktok\.com|twitter\.com|x\.com)$/i;
// Node 24 is installed in the Docker image and is supported by current yt-dlp EJS.
const base = ['--no-playlist', '--no-warnings', '--js-runtimes', 'node'];

app.set('trust proxy', 1);
app.disable('x-powered-by');

// CORS: set ALLOWED_ORIGIN to the exact Netlify site origin for production.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Simple in-memory rate limit: 20 requests per minute per IP.
const hits = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter(t => now - t < 60000);
  recent.push(now);
  hits.set(req.ip, recent);
  if (recent.length > 20) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }
  next();
});
setInterval(() => hits.clear(), 600000).unref();

function isAllowedUrl(value) {
  try {
    const parsed = new URL(value);
    return /^https?:$/.test(parsed.protocol) && HOSTS.test(parsed.hostname);
  } catch {
    return false;
  }
}

function run(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      // Metadata JSON is small; cap captured output to prevent runaway memory use.
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', err => finish(reject, err));
    child.on('close', code => {
      if (code === 0) return finish(resolve, stdout);
      finish(reject, new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

function logFailure(scope, error) {
  // Details stay in Render Logs, not in the public API response.
  console.error(`[${scope}]`, String(error?.stack || error?.message || error).slice(-8000));
}

function toMB(bytes) {
  return bytes > 0 ? +(bytes / 1048576).toFixed(1) : 0;
}

app.get('/', (req, res) => {
  res.type('text').send('Video Downloader API is running.');
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'video-downloader-api' });
});

app.get('/info', async (req, res) => {
  const url = req.query.url;
  if (!isAllowedUrl(url)) {
    return res.status(400).json({ error: 'Unsupported link', code: 'INVALID_URL' });
  }

  try {
    const raw = await run([...base, '-J', '--', url], 120000);
    const data = JSON.parse(raw);
    const duration = Number(data.duration) || 0;
    const formats = Array.isArray(data.formats) ? data.formats : [];

    if (duration > MAX_SEC) {
      return res.status(413).json({ error: 'This video is too long.', code: 'VIDEO_TOO_LONG' });
    }

    const videoFormats = formats.filter(f => f.vcodec && f.vcodec !== 'none' && Number(f.height) > 0);
    const maxHeight = Math.max(0, ...videoFormats.map(f => Number(f.height) || 0));
    const audioFormats = formats.filter(f => f.vcodec === 'none');
    const largestAudioBytes = Math.max(0, ...audioFormats.map(f => Number(f.filesize || f.filesize_approx) || 0));
    const estimateBytes = f => Number(f.filesize || f.filesize_approx) || (Number(f.tbr) > 0 && duration > 0 ? Number(f.tbr) * 125 * duration : 0);

    const choices = [];
    for (const [height, tag] of [[1080, 'Full HD'], [720, 'HD'], [480, 'SD'], [360, 'Low']]) {
      if (height > maxHeight) continue;
      const candidate = videoFormats
        .filter(f => Number(f.height) <= height)
        .sort((a, b) => (Number(b.height) - Number(a.height)) || ((Number(b.tbr) || 0) - (Number(a.tbr) || 0)))[0];
      if (!candidate) continue;
      const candidateHasAudio = candidate.acodec && candidate.acodec !== 'none';
      const totalBytes = estimateBytes(candidate) + (candidateHasAudio ? 0 : largestAudioBytes);
      choices.push({
        id: `${height}p`, label: `${height}p`, tag, audio: false,
        size: toMB(totalBytes) || (duration > 0 ? toMB(duration * height * 600) : 0)
      });
    }

    if (!choices.length && maxHeight > 0) {
      const candidate = videoFormats.sort((a, b) => Number(b.height) - Number(a.height))[0];
      const candidateHasAudio = candidate.acodec && candidate.acodec !== 'none';
      choices.push({
        id: `${maxHeight}p`, label: `${maxHeight}p`, tag: 'Available', audio: false,
        size: toMB(estimateBytes(candidate) + (candidateHasAudio ? 0 : largestAudioBytes))
      });
    }

    if (duration > 0) {
      choices.push({ id: 'MP3 192 kbps', label: 'MP3 192 kbps', tag: 'Audio', audio: true, size: toMB(duration * 24000) });
      choices.push({ id: 'M4A', label: 'M4A', tag: 'Audio', audio: true, size: toMB(largestAudioBytes || duration * 16000) });
    }

    if (!choices.length) {
      throw new Error('No downloadable audio/video formats were returned by yt-dlp.');
    }

    res.json({
      title: data.title || 'Untitled video',
      duration,
      thumbnail: data.thumbnail || '',
      formats: choices
    });
  } catch (error) {
    logFailure('info extraction failed', error);
    res.status(422).json({
      error: 'Could not read this video. It may be private, unavailable, unsupported, or blocked by the source platform.',
      code: 'EXTRACTION_FAILED'
    });
  }
});

let activeJobs = 0;
app.get('/download', async (req, res) => {
  const url = req.query.url;
  const format = String(req.query.format || '');
  if (!isAllowedUrl(url)) return res.status(400).send('Unsupported link');

  const match = format.match(/^(\d{3,4})p$/);
  let formatArgs;
  if (match) {
    const height = Number(match[1]);
    if (height < 144 || height > 4320) return res.status(400).send('Bad format');
    formatArgs = ['-f', `bv*[height<=${height}]+ba/b[height<=${height}]/b`, '--merge-output-format', 'mp4'];
  } else if (format === 'MP3 192 kbps') {
    formatArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '192K'];
  } else if (format === 'M4A') {
    formatArgs = ['-x', '--audio-format', 'm4a'];
  } else {
    return res.status(400).send('Bad format');
  }

  if (activeJobs >= MAX_JOBS) {
    return res.status(503).send('Server is busy. Please try again in a moment.');
  }

  activeJobs++;
  const id = `vd-${crypto.randomBytes(8).toString('hex')}`;
  const tempDir = os.tmpdir();
  const cleanup = () => {
    try {
      fs.readdirSync(tempDir)
        .filter(name => name.startsWith(id))
        .forEach(name => fs.rmSync(path.join(tempDir, name), { force: true }));
    } catch (error) {
      logFailure('temporary-file cleanup failed', error);
    }
  };
  let released = false;
  const releaseJob = () => {
    if (released) return;
    released = true;
    cleanup();
    activeJobs = Math.max(0, activeJobs - 1);
  };

  try {
    await run([
      ...base,
      '--match-filter', `duration<=${MAX_SEC}`,
      ...formatArgs,
      '-o', path.join(tempDir, `${id}.%(ext)s`),
      '--', url
    ], 600000);

    const filename = fs.readdirSync(tempDir).find(name => name.startsWith(id) && !/\.(part|ytdl)$/.test(name));
    if (!filename) throw new Error('yt-dlp finished but no output file was found.');

    res.download(path.join(tempDir, filename), `video-downloader${path.extname(filename)}`, error => {
      if (error) logFailure('download response failed', error);
      releaseJob();
    });
  } catch (error) {
    logFailure('download failed', error);
    releaseJob();
    if (!res.headersSent) {
      res.status(422).send('Download failed. The video may be private, unsupported, too long, or unavailable. Check Render Logs for the technical reason.');
    }
  }
});

app.listen(PORT, () => console.log(`Video Downloader API listening on port ${PORT}`));
