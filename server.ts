import express from "express";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import multer from "multer";
import dotenv from "dotenv";
import { GoogleGenAI, Type, ThinkingLevel, createPartFromUri } from "@google/genai";

dotenv.config();

const execFileAsync = promisify(execFile);

// Ensure local bin directory is in PATH for yt-dlp and ffmpeg
const binDir = path.resolve(process.cwd(), "bin");
process.env.PATH = `${binDir}:${process.env.PATH}`;
const ytdlpBin = fs.existsSync(path.join(binDir, "yt-dlp"))
  ? path.join(binDir, "yt-dlp")
  : "yt-dlp";

const publicDir = path.resolve(process.cwd(), "public");
const clipsDir = path.join(publicDir, "clips");
const uploadsDir = path.join(publicDir, "uploads");

if (!fs.existsSync(clipsDir)) {
  fs.mkdirSync(clipsDir, { recursive: true });
}
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";

app.use(express.json({ limit: "50mb" }));

// Configure Multer for real video file uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".mp4";
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 32);
    cb(null, `up_${Date.now()}_${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1500 * 1024 * 1024 }, // up to 1.5GB
});

// Initialize Gemini Client (Server-side only)
function getGeminiClient() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// Exponential backoff retry for transient Gemini errors (429 / 503 / network)
async function withGeminiRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.code;
      const msg = String(err?.message || "");
      const isTransient =
        status === 429 ||
        status === 503 ||
        status === 500 ||
        msg.includes("503") ||
        msg.includes("UNAVAILABLE") ||
        msg.includes("high demand") ||
        msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNRESET");

      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }

      const delayMs = Math.min(8000, 1000 * Math.pow(2, attempt - 1)) + Math.round(Math.random() * 400);
      console.warn(`Gemini transient error (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms:`, msg);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

function formatGeminiHttpError(error: any): { status: number; message: string; code: string } {
  const rawMsg = String(error?.message || "Unknown Gemini error");
  const statusNum = Number(error?.status || error?.statusCode) || 500;

  if (!process.env.GEMINI_API_KEY) {
    return {
      status: 500,
      code: "MISSING_API_KEY",
      message: "GEMINI_API_KEY is not configured. Please add your Gemini API key in Settings > Secrets.",
    };
  }
  if (statusNum === 403 || rawMsg.includes("PERMISSION_DENIED")) {
    return {
      status: 403,
      code: "PERMISSION_DENIED",
      message: "Gemini API permission denied. Please verify your API key in Settings > Secrets.",
    };
  }
  if (statusNum === 400 || rawMsg.includes("API_KEY_INVALID")) {
    return {
      status: 400,
      code: "API_KEY_INVALID",
      message: "Gemini API key or request is invalid. Please check your key in Settings > Secrets.",
    };
  }
  if (statusNum === 429 || rawMsg.includes("RESOURCE_EXHAUSTED")) {
    return {
      status: 429,
      code: "RESOURCE_EXHAUSTED",
      message: "Gemini API rate limit or quota reached. Wait a moment and retry, or check your quota in Settings > Secrets.",
    };
  }
  if (statusNum === 503 || rawMsg.includes("UNAVAILABLE")) {
    return {
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Gemini AI service is temporarily busy. Please click retry in a few seconds.",
    };
  }
  return {
    status: statusNum >= 400 && statusNum < 600 ? statusNum : 500,
    code: "GEMINI_ERROR",
    message: rawMsg,
  };
}

// Probe local video file with ffprobe
async function probeVideoFile(filePath: string): Promise<{
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath,
      ],
      { timeout: 10000 }
    );
    const parsed = JSON.parse(stdout || "{}");
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videoStream = streams.find((s: any) => s.codec_type === "video");
    const audioStream = streams.find((s: any) => s.codec_type === "audio");
    const rawDur =
      Number(parsed.format?.duration) ||
      Number(videoStream?.duration) ||
      120;
    return {
      duration: Math.max(1, Math.round(rawDur)),
      width: Number(videoStream?.width) || 1280,
      height: Number(videoStream?.height) || 720,
      hasAudio: Boolean(audioStream),
    };
  } catch (err) {
    console.warn("ffprobe warning for", filePath, err);
    return { duration: 120, width: 1280, height: 720, hasAudio: true };
  }
}

// Extract a real poster thumbnail frame from a local video file
async function extractVideoThumbnail(filePath: string, duration: number, prefix: string): Promise<string | null> {
  try {
    const seekSec = duration > 6 ? Math.min(Math.round(duration * 0.15), 15) : Math.max(0, duration * 0.2);
    const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
    const thumbName = `thumb_${safePrefix}_${Date.now()}.jpg`;
    const thumbPath = path.join(uploadsDir, thumbName);

    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-ss",
        String(seekSec.toFixed(1)),
        "-i",
        filePath,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(960,iw)':-2",
        "-q:v",
        "3",
        thumbPath,
      ],
      { timeout: 12000 }
    );

    if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 500) {
      return `/uploads/${thumbName}`;
    }
    return null;
  } catch (err) {
    console.warn("Thumbnail extraction warning:", err);
    return null;
  }
}

// Detect visual scene cuts and audio energy peaks across the entire video via FFmpeg
async function analyzeVideoSignals(
  filePath: string,
  duration: number,
  hasAudio: boolean
): Promise<{ sceneChanges: number[]; audioPeaks: number[] }> {
  const sceneChanges: number[] = [];
  const audioPeaks: number[] = [];

  try {
    const fpsSample = duration > 900 ? "fps=1" : "fps=2";
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-v",
        "info",
        "-i",
        filePath,
        "-vf",
        `${fpsSample},select='gt(scene,0.28)',showinfo`,
        "-f",
        "null",
        "-",
      ],
      { timeout: 35000, maxBuffer: 10 * 1024 * 1024 }
    );
    const matches = stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g);
    for (const m of matches) {
      const t = Math.round(Number(m[1]) * 10) / 10;
      if (t >= 0 && t <= duration && (sceneChanges.length === 0 || t - sceneChanges[sceneChanges.length - 1] >= 1.5)) {
        sceneChanges.push(t);
        if (sceneChanges.length >= 60) break;
      }
    }
  } catch (err) {
    console.warn("Scene detection notice:", err);
  }

  if (hasAudio) {
    try {
      const { stdout } = await execFileAsync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          filePath,
          "-af",
          "aresample=8000,asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
          "-f",
          "null",
          "-",
        ],
        { timeout: 35000, maxBuffer: 10 * 1024 * 1024 }
      );
      const samples: { t: number; rms: number }[] = [];
      let curTime = 0;
      for (const line of stdout.split("\n")) {
        const tMatch = line.match(/pts_time:(\d+(?:\.\d+)?)/);
        if (tMatch) {
          curTime = Number(tMatch[1]);
          continue;
        }
        const rmsMatch = line.match(/RMS_level=(-?\d+(?:\.\d+)?)/);
        if (rmsMatch) {
          const rms = Number(rmsMatch[1]);
          if (Number.isFinite(rms) && rms > -90) {
            samples.push({ t: Math.round(curTime), rms });
          }
        }
      }
      if (samples.length > 0) {
        const sortedRms = [...samples].map((s) => s.rms).sort((a, b) => a - b);
        const median = sortedRms[Math.floor(sortedRms.length / 2)];
        const threshold = median + 3.5;
        for (const s of samples) {
          if (s.rms >= threshold && (audioPeaks.length === 0 || s.t - audioPeaks[audioPeaks.length - 1] >= 4)) {
            audioPeaks.push(s.t);
            if (audioPeaks.length >= 40) break;
          }
        }
      }
    } catch (err) {
      console.warn("Audio energy analysis notice:", err);
    }
  }

  return { sceneChanges, audioPeaks };
}

// Create a lightweight full-duration MP4 proxy (visuals + audio) for fast Gemini Files API multimodal analysis
async function createAnalysisProxyVideo(
  filePath: string,
  duration: number,
  hasAudio: boolean
): Promise<string | null> {
  const proxyPath = `/tmp/analyze_proxy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp4`;
  try {
    const fps = duration <= 300 ? 2 : duration <= 1200 ? 1 : 0.5;
    const args = [
      "-y",
      "-i",
      filePath,
      "-vf",
      `scale='min(640,iw)':-2,fps=${fps}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "31",
      "-pix_fmt",
      "yuv420p",
    ];
    if (hasAudio) {
      args.push("-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "24k");
    } else {
      args.push("-an");
    }
    args.push("-movflags", "+faststart", proxyPath);

    await execFileAsync("ffmpeg", args, {
      timeout: 90000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (fs.existsSync(proxyPath) && fs.statSync(proxyPath).size > 1000) {
      return proxyPath;
    }
    return null;
  } catch (err) {
    console.warn("Analysis proxy creation warning:", err);
    if (fs.existsSync(proxyPath)) fs.unlink(proxyPath, () => {});
    return null;
  }
}

// Extract evenly-spaced timestamped JPEG frames across the full video as fallback multimodal visual context
async function extractKeyframeSamples(
  filePath: string,
  duration: number,
  maxFrames = 14
): Promise<{ time: number; base64: string }[]> {
  const frames: { time: number; base64: string }[] = [];
  const count = Math.max(3, Math.min(maxFrames, Math.ceil(duration / 4)));
  for (let i = 0; i < count; i++) {
    const t = Math.round(((i + 0.5) / count) * duration * 10) / 10;
    const outJpg = `/tmp/kf_${Date.now()}_${i}.jpg`;
    try {
      await execFileAsync(
        "ffmpeg",
        [
          "-y",
          "-ss",
          String(t),
          "-i",
          filePath,
          "-frames:v",
          "1",
          "-vf",
          "scale='min(640,iw)':-2",
          "-q:v",
          "5",
          outJpg,
        ],
        { timeout: 8000 }
      );
      if (fs.existsSync(outJpg) && fs.statSync(outJpg).size > 400) {
        frames.push({
          time: t,
          base64: fs.readFileSync(outJpg).toString("base64"),
        });
      }
    } catch {
      // skip individual frame error
    } finally {
      if (fs.existsSync(outJpg)) fs.unlink(outJpg, () => {});
    }
  }
  return frames;
}

// Resolve a client videoUrl (/samples/..., /uploads/..., /clips/...) to a verified local path
function resolveLocalVideoPath(videoUrl?: string): string | null {
  if (!videoUrl || typeof videoUrl !== "string") return null;
  if (videoUrl.startsWith("http://") || videoUrl.startsWith("https://") || videoUrl.startsWith("blob:")) {
    return null;
  }
  const cleanRel = videoUrl.replace(/^\/+/, "");
  const candidates = [
    path.resolve(publicDir, cleanRel.replace(/^public\//, "")),
    path.resolve(process.cwd(), cleanRel),
  ];
  for (const candidate of candidates) {
    if (
      (candidate.startsWith(publicDir) || candidate.startsWith("/tmp")) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).size > 1000
    ) {
      return candidate;
    }
  }
  return null;
}

// Extract YouTube video ID from URL
function extractYoutubeId(url: string): string {
  const regExp =
    /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  if (match && match[2] && match[2].length === 11) {
    return match[2];
  }
  return "";
}

// Parse WebVTT subtitles into clean timestamped transcript lines [MM:SS] Text
function parseVttToTranscript(vtt: string): string {
  const lines = vtt.split(/\r?\n/);
  const result: string[] = [];
  let currentSec = -1;
  let lastCleanText = "";

  const timeRegex = /^(?:(\d{1,2}):)?(\d{2}):(\d{2})\.\d{3}\s+-->/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === "WEBVTT" || line.startsWith("Kind:") || line.startsWith("Language:")) {
      continue;
    }
    const tMatch = line.match(timeRegex);
    if (tMatch) {
      const hrs = Number(tMatch[1] || 0);
      const mins = Number(tMatch[2] || 0);
      const secs = Number(tMatch[3] || 0);
      currentSec = hrs * 3600 + mins * 60 + secs;
      continue;
    }
    if (/^\d+$/.test(line)) continue;

    // Strip VTT tags like <00:00:05.120><c> and HTML entities
    const cleaned = line
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned || cleaned === lastCleanText) continue;
    // Avoid overlapping rolling YouTube captions where previous line is prefix of current
    if (lastCleanText && cleaned.startsWith(lastCleanText) && cleaned.length - lastCleanText.length < 40) {
      if (result.length > 0) {
        const mm = String(Math.floor(Math.max(0, currentSec) / 60)).padStart(2, "0");
        const ss = String(Math.max(0, currentSec) % 60).padStart(2, "0");
        result[result.length - 1] = `[${mm}:${ss}] ${cleaned}`;
        lastCleanText = cleaned;
        continue;
      }
    }

    lastCleanText = cleaned;
    const mm = String(Math.floor(Math.max(0, currentSec) / 60)).padStart(2, "0");
    const ss = String(Math.max(0, currentSec) % 60).padStart(2, "0");
    result.push(`[${mm}:${ss}] ${cleaned}`);
  }

  return result.slice(0, 400).join("\n");
}

// In-flight deduplication map for YouTube full MP4 caching
const ytCachePromises = new Map<string, Promise<string | null>>();

async function ensureYoutubeCached(
  youtubeUrl: string,
  videoId: string
): Promise<string | null> {
  const safeId = (videoId || "yt_" + Date.now()).replace(/[^a-zA-Z0-9_-]/g, "");
  const outFilename = `yt_${safeId}.mp4`;
  const outPath = path.join(uploadsDir, outFilename);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 50000) {
    return `/uploads/${outFilename}`;
  }

  if (ytCachePromises.has(safeId)) {
    return ytCachePromises.get(safeId)!;
  }

  const downloadPromise = (async () => {
    const tmpOut = path.join(uploadsDir, `yt_${safeId}.part.mp4`);
    try {
      await execFileAsync(
        ytdlpBin,
        [
          "--js-runtimes",
          "node",
          "--no-check-certificates",
          "--no-playlist",
          "-f",
          "best[height<=720][ext=mp4]/best[ext=mp4]/best",
          "--max-filesize",
          "250M",
          "-o",
          tmpOut,
          youtubeUrl,
        ],
        { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
      );
      if (fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 50000) {
        fs.renameSync(tmpOut, outPath);
        return `/uploads/${outFilename}`;
      }
      return null;
    } catch (err: any) {
      console.warn("YouTube full cache notice:", err?.message);
      if (fs.existsSync(tmpOut)) {
        fs.unlink(tmpOut, () => {});
      }
      return null;
    } finally {
      ytCachePromises.delete(safeId);
    }
  })();

  ytCachePromises.set(safeId, downloadPromise);
  return downloadPromise;
}

// ---------------------------------------------------------------------------
// 1. Upload Local Video Endpoint
// ---------------------------------------------------------------------------
app.post("/api/upload-video", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No video file received." });
    }
    const meta = await probeVideoFile(req.file.path);
    const playableSourceUrl = `/uploads/${req.file.filename}`;
    const thumbnailUrl = await extractVideoThumbnail(
      req.file.path,
      meta.duration,
      req.file.filename
    );
    return res.json({
      success: true,
      filename: req.file.filename,
      originalName: req.file.originalname,
      playableSourceUrl,
      thumbnailUrl,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio,
    });
  } catch (err: any) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: err.message || "Video upload failed" });
  }
});

// ---------------------------------------------------------------------------
// 1b. Ingest Direct Video URL (.mp4 / .webm / .mov) into local storage
// ---------------------------------------------------------------------------
app.post("/api/ingest-url", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Video URL is required" });
    }
    const cleanUrl = url.trim();
    if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
      return res.status(400).json({ error: "URL must start with http:// or https://" });
    }

    const response = await fetch(cleanUrl, { redirect: "follow" });
    if (!response.ok) {
      return res.status(400).json({ error: `Remote server returned HTTP ${response.status}` });
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("video/") && !contentType.includes("octet-stream") && !/\.(mp4|mov|webm|m4v)(\?|$)/i.test(cleanUrl)) {
      return res.status(400).json({
        error: `URL did not return a direct video stream (content-type: ${contentType || "unknown"}). Please upload a video file or use a direct MP4/WebM URL.`,
      });
    }

    const extMatch = cleanUrl.match(/\.(mp4|mov|webm|m4v)(?:\?|$)/i);
    const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : ".mp4";
    const outName = `url_${Date.now()}${ext}`;
    const outPath = path.join(uploadsDir, outName);

    const arrayBuf = await response.arrayBuffer();
    if (arrayBuf.byteLength < 1000) {
      return res.status(400).json({ error: "Downloaded video file was empty or invalid." });
    }
    if (arrayBuf.byteLength > 500 * 1024 * 1024) {
      return res.status(400).json({ error: "Remote video exceeds 500MB URL ingest limit. Please upload the file directly." });
    }

    fs.writeFileSync(outPath, Buffer.from(arrayBuf));
    const meta = await probeVideoFile(outPath);
    const thumbnailUrl = await extractVideoThumbnail(outPath, meta.duration, outName);
    const urlPathName = (() => {
      try {
        const u = new URL(cleanUrl);
        return path.basename(u.pathname).replace(/\.[^/.]+$/, "") || "Imported Video";
      } catch {
        return "Imported Video";
      }
    })();

    return res.json({
      success: true,
      title: decodeURIComponent(urlPathName).replace(/[_-]+/g, " "),
      playableSourceUrl: `/uploads/${outName}`,
      thumbnailUrl,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio,
    });
  } catch (err: any) {
    console.error("URL ingest error:", err);
    return res.status(500).json({ error: err.message || "Failed to download video from URL" });
  }
});

// Pure-Node fallback to extract YouTube metadata, chapters & TimedText captions when yt-dlp is unavailable
async function fetchYoutubeFallbackInfo(url: string, videoId: string): Promise<{
  title?: string;
  channelName?: string;
  description?: string;
  duration?: number;
  thumbnail?: string;
  transcript?: string;
  chapters?: any[];
}> {
  const result: any = {};

  try {
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (oembedRes.ok) {
      const oe: any = await oembedRes.json();
      result.title = oe.title;
      result.channelName = oe.author_name;
      result.thumbnail = oe.thumbnail_url;
    }
  } catch {
    // ignore oembed failure
  }

  try {
    const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
    const pageRes = await fetch(watchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|const\s|<\/script>)/s);
      if (playerMatch && playerMatch[1]) {
        const player = JSON.parse(playerMatch[1]);
        const vd = player?.videoDetails;
        if (vd) {
          result.title = vd.title || result.title;
          result.channelName = vd.author || result.channelName;
          result.description = vd.shortDescription || "";
          if (Number(vd.lengthSeconds) > 0) {
            result.duration = Number(vd.lengthSeconds);
          }
        }
        const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (Array.isArray(tracks) && tracks.length > 0) {
          const enTrack =
            tracks.find((t: any) => String(t.languageCode || "").startsWith("en") && !t.kind) ||
            tracks.find((t: any) => String(t.languageCode || "").startsWith("en")) ||
            tracks[0];
          if (enTrack?.baseUrl) {
            const vttUrl = enTrack.baseUrl.includes("fmt=")
              ? enTrack.baseUrl
              : `${enTrack.baseUrl}&fmt=vtt`;
            const vttRes = await fetch(vttUrl, { signal: AbortSignal.timeout(8000) });
            if (vttRes.ok) {
              const vttText = await vttRes.text();
              const parsed = parseVttToTranscript(vttText);
              if (parsed) result.transcript = parsed;
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("YouTube page fallback notice:", err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 2. Real YouTube Metadata + VTT Subtitles + Source Video Caching
// ---------------------------------------------------------------------------
app.post("/api/youtube-info", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "YouTube URL is required" });
    }

    const videoId = extractYoutubeId(url);
    const metaId = videoId || `yt_${Date.now()}`;
    const vttPrefix = `/tmp/yt_sub_${metaId}_${Date.now()}`;

    let info: any = null;
    let transcript = "";

    try {
      const { stdout } = await execFileAsync(
        ytdlpBin,
        [
          "--js-runtimes",
          "node",
          "--no-check-certificates",
          "--no-playlist",
          "--dump-json",
          "--write-auto-sub",
          "--write-sub",
          "--sub-langs",
          "en.*,en",
          "--sub-format",
          "vtt",
          "-o",
          vttPrefix,
          "--skip-download",
          url,
        ],
        { timeout: 20000, maxBuffer: 15 * 1024 * 1024 }
      );
      if (stdout) {
        const lastJsonLine = stdout
          .trim()
          .split("\n")
          .reverse()
          .find((l) => l.trim().startsWith("{"));
        if (lastJsonLine) {
          info = JSON.parse(lastJsonLine);
        }
      }
    } catch (ytErr: any) {
      console.warn("yt-dlp metadata fetch warning:", ytErr?.message);
    }

    // Look for any written .vtt subtitle file in /tmp matching prefix
    try {
      const tmpFiles = fs.readdirSync("/tmp");
      const basePrefix = path.basename(vttPrefix);
      const vttFiles = tmpFiles.filter((f) => f.startsWith(basePrefix) && f.endsWith(".vtt"));
      if (vttFiles.length > 0) {
        const vttPath = path.join("/tmp", vttFiles[0]);
        const vttRaw = fs.readFileSync(vttPath, "utf-8");
        transcript = parseVttToTranscript(vttRaw);
      }
      for (const f of vttFiles) {
        fs.unlink(path.join("/tmp", f), () => {});
      }
    } catch (vttErr) {
      console.warn("VTT parse warning:", vttErr);
    }

    // Fallback to pure-Node YouTube HTML/oEmbed extraction if yt-dlp missed metadata or captions
    let fallback: any = {};
    if (!info || !transcript) {
      fallback = await fetchYoutubeFallbackInfo(url, videoId);
      if (!transcript && fallback.transcript) {
        transcript = fallback.transcript;
      }
    }

    const resolvedId = info?.id || videoId || metaId;
    const duration = Math.max(
      10,
      Math.round(Number(info?.duration) || Number(fallback.duration) || 180)
    );

    // Cache full MP4 when duration <= 20 minutes so both Gemini multimodal analysis and FFmpeg clipping work
    let playableSourceUrl: string | null = null;
    if (videoId && duration <= 1200) {
      playableSourceUrl = await ensureYoutubeCached(url, resolvedId);
    }

    return res.json({
      id: resolvedId,
      title:
        info?.title ||
        fallback.title ||
        (videoId ? `YouTube Video (${videoId})` : "YouTube Video"),
      description: (info?.description || fallback.description || "").slice(0, 1500),
      duration,
      thumbnail:
        info?.thumbnail ||
        fallback.thumbnail ||
        (videoId
          ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
          : "https://images.unsplash.com/photo-1611162617474-5b21e879e113?auto=format&fit=crop&w=1200&q=80"),
      channelName: info?.uploader || info?.channel || fallback.channelName || "YouTube Creator",
      videoId: resolvedId,
      transcript,
      playableSourceUrl,
      streamAvailable: Boolean(playableSourceUrl),
      chapters: Array.isArray(info?.chapters) ? info.chapters.slice(0, 20) : [],
    });
  } catch (error: any) {
    console.error("Error in /api/youtube-info:", error);
    return res.status(500).json({ error: error.message || "Failed to fetch YouTube info" });
  }
});

// Shift [MM:SS] timestamps in chunked transcripts when the model starts from 00:00
function offsetTranscriptTimestamps(rawText: string, offsetSec: number): string {
  if (!rawText) return "";
  if (offsetSec <= 0) return rawText.trim();

  const lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // Check whether timestamps in this chunk appear relative (first timestamp < offsetSec * 0.6)
  let firstSec = -1;
  for (const line of lines) {
    const m = line.match(/^\[(\d{1,3}):(\d{2})\]/);
    if (m) {
      firstSec = Number(m[1]) * 60 + Number(m[2]);
      break;
    }
  }
  const needsOffset = firstSec >= 0 && firstSec < Math.max(30, offsetSec * 0.7);
  if (!needsOffset) return rawText.trim();

  return lines
    .map((line) =>
      line.replace(/^\[(\d{1,3}):(\d{2})\]/, (_full, mm, ss) => {
        const abs = Number(mm) * 60 + Number(ss) + offsetSec;
        const nMm = String(Math.floor(abs / 60)).padStart(2, "0");
        const nSs = String(abs % 60).padStart(2, "0");
        return `[${nMm}:${nSs}]`;
      })
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// 3. Gemini 3.5 Transcribe — Full-Duration Chunked Audio Speech-to-Text + Signal Telemetry
// ---------------------------------------------------------------------------
app.post("/api/transcribe-video", async (req, res) => {
  const tempFiles: string[] = [];
  try {
    const { videoUrl, playableSourceUrl, youtubeUrl } = req.body;

    let localFile =
      resolveLocalVideoPath(playableSourceUrl) || resolveLocalVideoPath(videoUrl);

    if (!localFile && youtubeUrl) {
      const ytId = extractYoutubeId(youtubeUrl);
      if (ytId) {
        const cached = await ensureYoutubeCached(youtubeUrl, ytId);
        if (cached) localFile = resolveLocalVideoPath(cached);
      }
    }

    if (!localFile) {
      return res.status(400).json({
        error: "No locally accessible video source available for full audio & visual capture.",
      });
    }

    const meta = await probeVideoFile(localFile);
    const signals = await analyzeVideoSignals(localFile, meta.duration, meta.hasAudio);

    if (!meta.hasAudio) {
      return res.json({
        transcript: "",
        noAudio: true,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        sceneChanges: signals.sceneChanges,
        audioPeaks: signals.audioPeaks,
      });
    }

    const ai = getGeminiClient();
    const chunkLenSec = 420; // 7-minute chunks so even 60+ minute videos are 100% transcribed
    const maxChunks = 10;
    const totalChunks = Math.min(maxChunks, Math.max(1, Math.ceil(meta.duration / chunkLenSec)));
    const chunkTranscripts: string[] = [];

    for (let idx = 0; idx < totalChunks; idx++) {
      const offsetSec = idx * chunkLenSec;
      const segDur = Math.min(chunkLenSec, Math.max(1, meta.duration - offsetSec));
      const tempMp3 = `/tmp/audio_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}.mp3`;
      tempFiles.push(tempMp3);

      await execFileAsync(
        "ffmpeg",
        [
          "-y",
          "-ss",
          String(offsetSec),
          "-i",
          localFile,
          "-t",
          String(segDur),
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-b:a",
          "24k",
          "-f",
          "mp3",
          tempMp3,
        ],
        { timeout: 45000 }
      );

      if (!fs.existsSync(tempMp3) || fs.statSync(tempMp3).size < 200) {
        continue;
      }

      const audioBase64 = fs.readFileSync(tempMp3).toString("base64");
      const offsetMm = String(Math.floor(offsetSec / 60)).padStart(2, "0");
      const offsetSs = String(offsetSec % 60).padStart(2, "0");

      const response = await withGeminiRetry(() =>
        ai.models.generateContent({
          model: "gemini-3.5-transcribe",
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/mp3",
                  data: audioBase64,
                },
              },
              {
                text: `Transcribe every spoken sentence and notable non-speech reaction (e.g., [laughter], [applause], [music]) accurately. This audio segment begins at [${offsetMm}:${offsetSs}] of the full video. Format each line strictly with its timestamp prefix like [MM:SS] Speaker: spoken text.`,
              },
            ],
          },
        })
      );

      const rawChunkText = (response.text || "").trim();
      if (rawChunkText) {
        chunkTranscripts.push(offsetTranscriptTimestamps(rawChunkText, offsetSec));
      }
    }

    const transcriptText = chunkTranscripts.join("\n").trim();
    return res.json({
      success: true,
      transcript: transcriptText,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio,
      noAudio: transcriptText.length === 0,
      sceneChanges: signals.sceneChanges,
      audioPeaks: signals.audioPeaks,
    });
  } catch (error: any) {
    console.error("Transcription error:", error);
    const formatted = formatGeminiHttpError(error);
    return res.status(formatted.status).json({ error: formatted.message, code: formatted.code });
  } finally {
    for (const f of tempFiles) {
      if (fs.existsSync(f)) {
        fs.unlink(f, () => {});
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Gemini 4 Hydrogen — Full-Video Multimodal Highlight & Clip Detection Engine
// ---------------------------------------------------------------------------
app.post("/api/analyze-highlights", async (req, res) => {
  const ai = getGeminiClient();
  let tempProxyPath: string | null = null;
  let uploadedGeminiFileName: string | null = null;

  try {
    const {
      title = "Viral Video",
      description = "",
      transcript = "",
      fullDuration = 180,
      filter = "all",
      targetLength = "auto",
      chapters = [],
      videoUrl = "",
      playableSourceUrl = "",
      youtubeUrl = "",
      sceneChanges = [],
      audioPeaks = [],
    } = req.body;

    // Resolve local video file so Gemini can visually watch & analyze the ENTIRE video
    let localFile =
      resolveLocalVideoPath(playableSourceUrl) || resolveLocalVideoPath(videoUrl);

    if (!localFile && youtubeUrl) {
      const ytId = extractYoutubeId(youtubeUrl);
      if (ytId) {
        const cached = resolveLocalVideoPath(`/uploads/yt_${ytId}.mp4`);
        if (cached) localFile = cached;
      }
    }

    let totalSec = Math.max(5, Math.round(Number(fullDuration) || 180));
    let probedHasAudio = true;
    let detectedScenes: number[] = Array.isArray(sceneChanges) ? sceneChanges : [];
    let detectedPeaks: number[] = Array.isArray(audioPeaks) ? audioPeaks : [];

    if (localFile) {
      const meta = await probeVideoFile(localFile);
      totalSec = Math.max(5, meta.duration);
      probedHasAudio = meta.hasAudio;
      if (detectedScenes.length === 0 && detectedPeaks.length === 0) {
        const sig = await analyzeVideoSignals(localFile, totalSec, meta.hasAudio);
        detectedScenes = sig.sceneChanges;
        detectedPeaks = sig.audioPeaks;
      }
    }

    const desiredClipCount = totalSec < 25 ? 2 : totalSec < 75 ? 3 : 5;

    let lengthInstruction = "15 to 55 seconds per clip (natural complete story arcs)";
    if (totalSec < 25) {
      lengthInstruction = `4 to ${Math.max(5, Math.min(20, totalSec))} seconds per clip`;
    } else if (targetLength === "<30s") {
      lengthInstruction = "12 to 29 seconds per clip (ultra-punchy fast TikTok hooks)";
    } else if (targetLength === "30-60s") {
      lengthInstruction = "30 to 58 seconds per clip (deep storytelling arc with setup + payoff)";
    }

    const chaptersHint =
      Array.isArray(chapters) && chapters.length > 0
        ? `\nVideo Chapters:\n${chapters
            .slice(0, 12)
            .map((c: any) => `- [${Math.round(c.start_time || 0)}s - ${Math.round(c.end_time || 0)}s] ${c.title}`)
            .join("\n")}`
        : "";

    const telemetryHint =
      detectedScenes.length > 0 || detectedPeaks.length > 0
        ? `\nFFmpeg Detected Timeline Signals:\n- Visual scene cuts (seconds): ${detectedScenes.slice(0, 35).join(", ") || "none"}\n- Audio energy spikes (seconds): ${detectedPeaks.slice(0, 25).join(", ") || "none"}`
        : "";

    // Build multimodal content parts: prefer uploading compressed full-duration video via Gemini Files API,
    // with automatic fallback to evenly-spaced visual keyframe JPEGs across the entire video.
    const contentParts: any[] = [];
    let analyzedModality: "multimodal_video" | "keyframes_and_audio" | "transcript_only" = "transcript_only";

    if (localFile) {
      const stat = fs.statSync(localFile);
      // Use direct file if <= 15MB and <= 4 mins, otherwise build fast 480p proxy covering 100% of duration
      let fileToUpload = localFile;
      if (stat.size > 15 * 1024 * 1024 || totalSec > 240) {
        tempProxyPath = await createAnalysisProxyVideo(localFile, totalSec, probedHasAudio);
        if (tempProxyPath) {
          fileToUpload = tempProxyPath;
        }
      }

      try {
        const uploadSize = fs.statSync(fileToUpload).size;
        if (uploadSize <= 180 * 1024 * 1024) {
          const uploaded = await ai.files.upload({
            file: fileToUpload,
            config: {
              mimeType: fileToUpload.endsWith(".webm") ? "video/webm" : "video/mp4",
              displayName: String(title).slice(0, 60),
            },
          });

          if (uploaded?.name) {
            uploadedGeminiFileName = uploaded.name;
            let fileInfo = uploaded;
            const maxWaitStart = Date.now();
            while (fileInfo.state === "PROCESSING" && Date.now() - maxWaitStart < 60000) {
              await new Promise((r) => setTimeout(r, 1500));
              fileInfo = await ai.files.get({ name: uploaded.name });
            }
            if (fileInfo.state === "ACTIVE" && fileInfo.uri && fileInfo.mimeType) {
              contentParts.push(createPartFromUri(fileInfo.uri, fileInfo.mimeType));
              analyzedModality = "multimodal_video";
            }
          }
        }
      } catch (fileErr: any) {
        console.warn("Gemini Files API video upload fallback to keyframes:", fileErr?.message);
      }

      // If full video upload did not succeed, extract evenly-spaced storyboard keyframes across 0%..100% of the video
      if (analyzedModality !== "multimodal_video") {
        const frames = await extractKeyframeSamples(localFile, totalSec, 14);
        if (frames.length > 0) {
          for (const frame of frames) {
            contentParts.push({ text: `[Video Frame at ${frame.time}s]` });
            contentParts.push({
              inlineData: {
                mimeType: "image/jpeg",
                data: frame.base64,
              },
            });
          }
          analyzedModality = "keyframes_and_audio";
        }
      }
    }

    const systemPrompt = `You are ClipForge AI, an elite multimodal viral short-form video editor and retention strategist (like OpusClip and Klap.ai).
You are analyzing the COMPLETE video (both its visual frames/actions AND its audio/dialogue) from 0s to ${totalSec}s.
Extract ${desiredClipCount} high-retention vertical 9:16 short clips optimized for TikTok, Instagram Reels, and YouTube Shorts.

STRICT RULES:
1. All clip startTime and endTime values MUST fall strictly between 0 and ${totalSec} seconds. Never exceed ${totalSec}.
2. Each clip duration MUST be ${lengthInstruction} (and never exceed ${totalSec}s).
3. Base your selection on BOTH what is visually happening on screen (facial reactions, physical comedy, action peaks, on-screen text, camera cuts) AND what is spoken/heard in audio.
4. Prioritize moments matching Target Focus: "${filter}" ("all" means a mix of the strongest funny, climax/highlight, educational insights, and heated debate moments).
5. Spread clips across distinct non-overlapping sections of the full 0..${totalSec}s timeline whenever possible.
6. Set "recommendedPanX" (-100 left, 0 center, +100 right) based on where the primary speaker or visual subject appears horizontally in the frame so 9:16 smart crop centers them cleanly.
7. Generate punchy 3-second opening hooks, genuine retention reasoning grounded in the video visuals + transcript, Virality/Hook/Flow/Emotion/Visual scores (75-99), a concise "visualCue" describing what happens on screen, best 9:16 framing suggestion ("smart_crop", "blur_fit", "split_screen", or "clean_box"), hashtags, and synchronized kinetic captions with relative start/end timestamps from 0 up to (endTime - startTime) and per-word tokens (if no speech is present, generate crisp descriptive/reaction caption overlays matching the visual action).`;

    const userPrompt = `Video Title: "${title}"
Context / Description: ${description || "User video"}
Exact Total Video Duration: ${totalSec} seconds
Target Category Focus: ${filter}
Target Clip Length: ${targetLength}${chaptersHint}${telemetryHint}

Timestamped Transcript:
"""
${(transcript || "No speech transcript detected — rely closely on the attached video frames, visual action, scene cuts, and audio peaks.").slice(0, 26000)}
"""

Analyze the full video and extract ${desiredClipCount} viral clips in strictly valid JSON matching the schema.`;

    contentParts.push({ text: userPrompt });

    const response = await withGeminiRetry(() =>
      ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: { parts: contentParts },
        config: {
          systemInstruction: systemPrompt,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING, description: "Concise visual and narrative viral analysis of the full video" },
              visualObservations: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "3-5 key visual moments, subjects, or scene highlights observed across the video",
              },
              clips: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    title: { type: Type.STRING, description: "Scroll-stopping short title with 1-2 relevant emojis" },
                    hook: { type: Type.STRING, description: "Punchy 3-second on-screen banner hook" },
                    reason: { type: Type.STRING, description: "Specific explanation citing both visuals and dialogue/audio" },
                    visualCue: { type: Type.STRING, description: "Brief description of what is visually happening on screen during this clip" },
                    category: {
                      type: Type.STRING,
                      description: "One of: funny, highlight, educational, debate",
                    },
                    startTime: { type: Type.NUMBER, description: `Start timestamp in seconds (0 to ${Math.max(0, totalSec - 5)})` },
                    endTime: { type: Type.NUMBER, description: `End timestamp in seconds (strictly <= ${totalSec})` },
                    viralityScore: { type: Type.INTEGER, description: "Overall virality score 78 to 99" },
                    hookScore: { type: Type.INTEGER, description: "Opening 3s hook score 78 to 100" },
                    flowScore: { type: Type.INTEGER, description: "Narrative pacing & payoff score 78 to 100" },
                    emotionScore: { type: Type.INTEGER, description: "Emotional / comedic intensity score 75 to 100" },
                    visualScore: { type: Type.INTEGER, description: "Visual engagement & motion score 75 to 100" },
                    recommendedPanX: { type: Type.INTEGER, description: "Horizontal framing offset -100 (left) to 100 (right), 0 for center" },
                    framingSuggestion: {
                      type: Type.STRING,
                      description: "Recommended 9:16 framing: smart_crop, blur_fit, split_screen, or clean_box",
                    },
                    emojis: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    hashtags: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    recommendedMusicTempo: { type: Type.STRING },
                    captions: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          start: { type: Type.NUMBER, description: "Relative seconds from clip start (0..clipDuration)" },
                          end: { type: Type.NUMBER, description: "Relative seconds from clip start" },
                          text: { type: Type.STRING },
                          emphasisWord: { type: Type.STRING },
                          words: {
                            type: Type.ARRAY,
                            items: {
                              type: Type.OBJECT,
                              properties: {
                                w: { type: Type.STRING },
                                start: { type: Type.NUMBER },
                                end: { type: Type.NUMBER },
                              },
                            },
                          },
                        },
                        required: ["start", "end", "text"],
                      },
                    },
                  },
                  required: [
                    "id",
                    "title",
                    "hook",
                    "reason",
                    "category",
                    "startTime",
                    "endTime",
                    "viralityScore",
                    "hashtags",
                    "captions",
                  ],
                },
              },
            },
            required: ["summary", "clips"],
          },
        },
      })
    );

    const parsed = JSON.parse((response.text || "{}").trim());
    const rawClips = Array.isArray(parsed.clips) ? parsed.clips : [];
    if (rawClips.length === 0) {
      return res.status(502).json({
        error: "Gemini returned zero clips for this video. Please try again with a different focus or video.",
        code: "EMPTY_MODEL_RESPONSE",
      });
    }

    const allowedCats = new Set(["funny", "highlight", "educational", "debate"]);
    const allowedFraming = new Set(["smart_crop", "split_screen", "blur_fit", "clean_box"]);

    const normalizedClips = rawClips.map((c: any, idx: number) => {
      const minLen = Math.min(4, totalSec);
      let s = Math.max(0, Math.min(Number(c.startTime) || 0, Math.max(0, totalSec - minLen)));
      let e = Math.min(totalSec, Math.max(s + minLen, Number(c.endTime) || Math.min(totalSec, s + 25)));
      if (e - s > 65 && targetLength !== "auto") {
        e = Math.min(totalSec, s + (targetLength === "<30s" ? 28 : 55));
      }
      s = Math.round(s * 10) / 10;
      e = Math.round(e * 10) / 10;
      const clipDur = Math.max(3, e - s);

      const rawCaptions = Array.isArray(c.captions) && c.captions.length > 0
        ? c.captions
        : [{ start: 0, end: Math.min(4, clipDur), text: c.hook || c.title || "Watch this moment", emphasisWord: "WATCH" }];

      const normalizedCaptions = rawCaptions.map((cap: any, cIdx: number) => {
        const capStart = Math.max(0, Math.min(clipDur - 0.4, Number(cap.start) || Math.min(clipDur - 0.5, cIdx * 3.0)));
        const capEnd = Math.max(capStart + 0.4, Math.min(clipDur, Number(cap.end) || Math.min(clipDur, capStart + 3.0)));
        const textStr = String(cap.text || "").trim() || "Key highlight";
        const tokens =
          Array.isArray(cap.words) && cap.words.length > 0
            ? cap.words.map((wt: any, wIdx: number) => {
                const seg = (capEnd - capStart) / cap.words.length;
                return {
                  w: String(wt.w || ""),
                  start: Math.max(capStart, Math.min(capEnd, Number(wt.start) ?? capStart + wIdx * seg)),
                  end: Math.max(capStart, Math.min(capEnd, Number(wt.end) ?? capStart + (wIdx + 1) * seg)),
                };
              })
            : textStr.split(/\s+/).map((w, wIdx, arr) => {
                const seg = (capEnd - capStart) / Math.max(1, arr.length);
                return {
                  w,
                  start: Math.round((capStart + wIdx * seg) * 10) / 10,
                  end: Math.round((capStart + (wIdx + 1) * seg) * 10) / 10,
                };
              });

        return {
          start: Math.round(capStart * 10) / 10,
          end: Math.round(capEnd * 10) / 10,
          text: textStr,
          emphasisWord: cap.emphasisWord || undefined,
          words: tokens,
        };
      });

      const cat = allowedCats.has(c.category) ? c.category : "highlight";
      const framing = allowedFraming.has(c.framingSuggestion) ? c.framingSuggestion : "smart_crop";

      return {
        id: `clip-${Date.now()}-${idx + 1}`,
        title: String(c.title || `Viral Clip #${idx + 1}`),
        hook: String(c.hook || "Wait till you see what happens next!"),
        reason: String(c.reason || "Strong opening curiosity gap and emotional payoff."),
        visualCue: c.visualCue ? String(c.visualCue) : undefined,
        category: cat,
        startTime: s,
        endTime: e,
        viralityScore: Math.max(70, Math.min(99, Math.round(Number(c.viralityScore) || 92))),
        hookScore: Math.max(70, Math.min(100, Math.round(Number(c.hookScore) || 94))),
        flowScore: Math.max(70, Math.min(100, Math.round(Number(c.flowScore) || 91))),
        emotionScore: Math.max(70, Math.min(100, Math.round(Number(c.emotionScore) || 90))),
        visualScore: Math.max(70, Math.min(100, Math.round(Number(c.visualScore) || 91))),
        recommendedPanX: Math.max(-100, Math.min(100, Math.round(Number(c.recommendedPanX) || 0))),
        framingSuggestion: framing,
        emojis: Array.isArray(c.emojis) && c.emojis.length > 0 ? c.emojis : ["🔥", "👀"],
        hashtags: Array.isArray(c.hashtags) && c.hashtags.length > 0 ? c.hashtags : ["#shorts", "#viral", "#fyp"],
        recommendedMusicTempo: c.recommendedMusicTempo || "upbeat",
        captions: normalizedCaptions,
      };
    });

    return res.json({
      summary: parsed.summary || `Analyzed ${totalSec}s video and extracted ${normalizedClips.length} viral moments with Gemini AI.`,
      clips: normalizedClips,
      analysisMetadata: {
        analyzedModality,
        sceneCount: detectedScenes.length,
        audioPeakCount: detectedPeaks.length,
        analyzedDuration: totalSec,
        visualObservations: Array.isArray(parsed.visualObservations) ? parsed.visualObservations.slice(0, 6) : [],
      },
    });
  } catch (error: any) {
    console.error("Gemini analyze-highlights error:", error);
    const formatted = formatGeminiHttpError(error);
    return res.status(formatted.status).json({ error: formatted.message, code: formatted.code });
  } finally {
    if (tempProxyPath && fs.existsSync(tempProxyPath)) {
      fs.unlink(tempProxyPath, () => {});
    }
    if (uploadedGeminiFileName) {
      ai.files.delete({ name: uploadedGeminiFileName }).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Gemini 4 Hydrogen — Re-sync Kinetic Captions
// ---------------------------------------------------------------------------
app.post("/api/generate-captions", async (req, res) => {
  try {
    const { text, duration = 30 } = req.body;
    if (!text) {
      return res.status(400).json({ error: "Text is required to generate captions" });
    }

    const ai = getGeminiClient();
    const response = await withGeminiRetry(() =>
      ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: `Generate viral Hormozi/MrBeast style timed captions for this speech transcript of duration ${duration} seconds:
"""
${text}
"""
Break into natural 3-5 word animated subtitle chunks. Calculate exact relative timestamps (start and end in seconds from 0 to ${duration}). Include word-level timestamps and identify one key high-impact emphasis word per chunk.`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              captions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    start: { type: Type.NUMBER },
                    end: { type: Type.NUMBER },
                    text: { type: Type.STRING },
                    emphasisWord: { type: Type.STRING },
                    words: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          w: { type: Type.STRING },
                          start: { type: Type.NUMBER },
                          end: { type: Type.NUMBER },
                        },
                      },
                    },
                  },
                  required: ["start", "end", "text"],
                },
              },
            },
            required: ["captions"],
          },
        },
      })
    );

    const parsed = JSON.parse((response.text || "{}").trim());
    return res.json(parsed);
  } catch (error: any) {
    console.error("Error generating captions:", error);
    const formatted = formatGeminiHttpError(error);
    return res.status(formatted.status).json({ error: formatted.message, code: formatted.code });
  }
});

// ---------------------------------------------------------------------------
// 6. Gemini 4 Hydrogen — Viral Hook Rewriter
// ---------------------------------------------------------------------------
app.post("/api/suggest-hooks", async (req, res) => {
  try {
    const { clipTitle, quote, category } = req.body;

    const ai = getGeminiClient();
    const response = await withGeminiRetry(() =>
      ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: `Create 5 ultra-engaging TikTok/Shorts opening hooks (max 10 words each) for this clip:
Title: "${clipTitle || "Viral Short"}"
Key Quote / Current Hook: "${quote || ""}"
Category: "${category || "highlight"}"

Provide 5 distinct psychological angles:
1. Curiosity Gap
2. Contrarian / Debate
3. Comedy / Meme
4. Secret Knowledge
5. Story Climax`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              hooks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    angle: { type: Type.STRING },
                    text: { type: Type.STRING },
                    emoji: { type: Type.STRING },
                  },
                  required: ["angle", "text", "emoji"],
                },
              },
            },
            required: ["hooks"],
          },
        },
      })
    );

    const parsed = JSON.parse((response.text || "{}").trim());
    return res.json(parsed);
  } catch (error: any) {
    console.error("Error suggesting hooks:", error);
    const formatted = formatGeminiHttpError(error);
    return res.status(formatted.status).json({ error: formatted.message, code: formatted.code });
  }
});

// ---------------------------------------------------------------------------
// 7. Gemini 4 Hydrogen — Platform Social Copy Pack (TikTok / Reels / Shorts)
// ---------------------------------------------------------------------------
app.post("/api/ai-social-pack", async (req, res) => {
  try {
    const { title, hook, reason, dialogue, hashtags = [] } = req.body;
    const ai = getGeminiClient();

    const response = await withGeminiRetry(() =>
      ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: `Generate a ready-to-publish short-form social media copy pack for this clipped video segment.
Clip Title: "${title || ""}"
Opening Hook: "${hook || ""}"
Why Viral: "${reason || ""}"
Dialogue Snippet: "${dialogue || ""}"
Existing Tags: ${Array.isArray(hashtags) ? hashtags.join(" ") : ""}

Return tailored titles, captions, pinned comment prompts, thumbnail cover text, and optimal hashtag sets for TikTok, Instagram Reels, and YouTube Shorts.`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              coverText: { type: Type.STRING, description: "3-5 punchy ALL-CAPS words for video cover frame" },
              pinnedComment: { type: Type.STRING, description: "Question to pin in comments to boost engagement" },
              tiktokCaption: { type: Type.STRING, description: "TikTok post description + hashtags" },
              reelsCaption: { type: Type.STRING, description: "Instagram Reels caption + SEO hashtags" },
              shortsTitle: { type: Type.STRING, description: "YouTube Shorts SEO title under 70 chars" },
            },
            required: ["coverText", "pinnedComment", "tiktokCaption", "reelsCaption", "shortsTitle"],
          },
        },
      })
    );

    const parsed = JSON.parse((response.text || "{}").trim());
    return res.json(parsed);
  } catch (error: any) {
    console.error("Error generating social pack:", error);
    const formatted = formatGeminiHttpError(error);
    return res.status(formatted.status).json({ error: formatted.message, code: formatted.code });
  }
});

// Serve static public folder (samples, uploads, clips) with byte-range seeking support
const staticHeaders = (res: express.Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Accept-Ranges", "bytes");
};
app.use(express.static(publicDir, { setHeaders: staticHeaders }));
app.use("/public", express.static(publicDir, { setHeaders: staticHeaders }));

// ---------------------------------------------------------------------------
// 8. Real FFmpeg 9:16 Video Clipping Engine
// ---------------------------------------------------------------------------
function buildVerticalFilter(
  resolution: string,
  framingMode: string,
  panX: number
): string {
  const outW = resolution === "1080p" ? 1080 : 720;
  const outH = resolution === "1080p" ? 1920 : 1280;

  if (framingMode === "blur_fit") {
    return `[0:v]split=2[bg][fg];[bg]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},boxblur=20:5,eq=brightness=-0.12[bgb];[fg]scale=${outW}:-2:force_original_aspect_ratio=decrease[fgb];[bgb][fgb]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  }
  if (framingMode === "clean_box") {
    return `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=#09090b,setsar=1`;
  }

  // Default smart_crop (or split_screen fallback on FFmpeg): full 9:16 crop with optional pan offset
  const clampedPan = Math.max(-100, Math.min(100, Number(panX) || 0));
  const panFactor = (clampedPan + 100) / 200; // 0.0 (left) .. 0.5 (center) .. 1.0 (right)
  return `scale=-2:${outH},crop='min(iw,${outW})':${outH}:'(iw-min(iw,${outW}))*${panFactor.toFixed(3)}':0,scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},setsar=1`;
}

async function clipVideoSegment(options: {
  videoUrl?: string;
  playableSourceUrl?: string;
  youtubeUrl?: string;
  startTime: number;
  duration: number;
  resolution?: string;
  framingMode?: string;
  panX?: number;
  title?: string;
  clipId?: string;
}): Promise<{ downloadUrl: string; filename: string; duration: number }> {
  const {
    videoUrl = "",
    playableSourceUrl = "",
    youtubeUrl = "",
    startTime = 0,
    duration = 30,
    resolution = "720p",
    framingMode = "smart_crop",
    panX = 0,
    title = "clip",
    clipId = `clip_${Date.now()}`,
  } = options;

  const safeClipId = clipId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const cleanTitle = title.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase().slice(0, 20) || "clip";
  const clipFilename = `${safeClipId}_${cleanTitle}_${resolution}_${framingMode}.mp4`;
  const finalOut = path.join(clipsDir, clipFilename);

  if (fs.existsSync(finalOut) && fs.statSync(finalOut).size > 10000) {
    return {
      downloadUrl: `/clips/${clipFilename}`,
      filename: clipFilename,
      duration: Math.round(duration),
    };
  }

  const startSec = Math.max(0, Math.floor(startTime));
  const durSec = Math.max(3, Math.min(120, Math.ceil(duration)));
  const endSec = startSec + durSec;

  // Prefer locally accessible file (uploads, samples, or cached YouTube file)
  let localInput =
    resolveLocalVideoPath(playableSourceUrl) || resolveLocalVideoPath(videoUrl);

  const targetYt =
    youtubeUrl ||
    (videoUrl && (videoUrl.includes("youtube.com") || videoUrl.includes("youtu.be"))
      ? videoUrl
      : "");

  if (!localInput && targetYt) {
    const ytId = extractYoutubeId(targetYt);
    if (ytId) {
      const existingCached = resolveLocalVideoPath(`/uploads/yt_${ytId}.mp4`);
      if (existingCached) {
        localInput = existingCached;
      }
    }
  }

  let tempYtDownload: string | null = null;
  if (!localInput && targetYt) {
    const rawTemp = `/tmp/yt_sec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp4`;
    await execFileAsync(
      ytdlpBin,
      [
        "--js-runtimes",
        "node",
        "--no-check-certificates",
        "--no-playlist",
        "--download-sections",
        `*${startSec}-${endSec}`,
        "-f",
        "best[height<=720][ext=mp4]/best[ext=mp4]/best",
        "-o",
        rawTemp,
        targetYt,
      ],
      { timeout: 45000, maxBuffer: 10 * 1024 * 1024 }
    );
    if (!fs.existsSync(rawTemp) || fs.statSync(rawTemp).size < 1000) {
      throw new Error(`Failed to extract section ${startSec}s-${endSec}s from YouTube source.`);
    }
    tempYtDownload = rawTemp;
    localInput = rawTemp;
  }

  if (!localInput || !fs.existsSync(localInput)) {
    throw new Error("Source video file is unavailable for server clipping.");
  }

  try {
    const probe = await probeVideoFile(localInput);
    const clampedStart = tempYtDownload
      ? 0
      : Math.max(0, Math.min(startSec, Math.max(0, probe.duration - 2)));
    const clampedDur = Math.max(
      2,
      Math.min(durSec, Math.max(2, probe.duration - clampedStart))
    );

    const vf = buildVerticalFilter(resolution, framingMode, panX);
    const usesFilterComplex = framingMode === "blur_fit";

    const ffArgs: string[] = ["-y"];
    if (!tempYtDownload) {
      // For local/cached full file, seek directly to clampedStart
      ffArgs.push("-ss", String(clampedStart));
    }
    ffArgs.push("-i", localInput, "-t", String(clampedDur));

    if (usesFilterComplex) {
      ffArgs.push("-filter_complex", vf);
    } else {
      ffArgs.push("-vf", vf);
    }

    ffArgs.push(
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p"
    );

    if (probe.hasAudio) {
      ffArgs.push("-c:a", "aac", "-b:a", "128k");
    } else {
      ffArgs.push("-an");
    }

    ffArgs.push("-movflags", "+faststart", finalOut);

    await execFileAsync("ffmpeg", ffArgs, {
      timeout: 45000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (!fs.existsSync(finalOut) || fs.statSync(finalOut).size < 1000) {
      throw new Error("FFmpeg produced an empty clip output.");
    }

    return {
      downloadUrl: `/clips/${clipFilename}`,
      filename: clipFilename,
      duration: clampedDur,
    };
  } finally {
    if (tempYtDownload && fs.existsSync(tempYtDownload)) {
      fs.unlink(tempYtDownload, () => {});
    }
  }
}

// Auto-clip all viral moments into playable 9:16 vertical MP4s (bounded concurrency)
app.post("/api/auto-clip", async (req, res) => {
  try {
    const {
      videoUrl = "",
      playableSourceUrl = "",
      youtubeUrl = "",
      clips = [],
    } = req.body;

    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "Clips array is required" });
    }

    const clippedResults: any[] = new Array(clips.length);
    const concurrency = 2;
    let cursor = 0;

    const worker = async () => {
      while (cursor < clips.length) {
        const idx = cursor++;
        const clip = clips[idx];
        const dur = Math.max(3, Math.round((clip.endTime || 30) - (clip.startTime || 0)));
        try {
          const result = await clipVideoSegment({
            videoUrl,
            playableSourceUrl,
            youtubeUrl,
            startTime: clip.startTime || 0,
            duration: dur,
            resolution: "720p",
            framingMode: clip.framingSuggestion || "smart_crop",
            panX: Number(clip.recommendedPanX) || 0,
            title: clip.title || `clip_${idx + 1}`,
            clipId: clip.id || `clip_${Date.now()}_${idx}`,
          });
          clippedResults[idx] = {
            ...clip,
            clipVideoUrl: result.downloadUrl,
            downloadUrl: result.downloadUrl,
          };
        } catch (clipErr: any) {
          console.warn(`Clip #${idx + 1} render warning:`, clipErr?.message);
          clippedResults[idx] = {
            ...clip,
            clipError: clipErr?.message || "Clip render failed",
          };
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, clips.length) }, () => worker())
    );

    const validCount = clippedResults.filter((c) => Boolean(c?.clipVideoUrl)).length;
    if (validCount === 0) {
      const firstErr = clippedResults.find((c) => c?.clipError)?.clipError || "Unable to clip video segments.";
      return res.status(500).json({ error: firstErr, clips: clippedResults });
    }

    return res.json({ success: true, clips: clippedResults });
  } catch (err: any) {
    console.error("Auto-clip error:", err);
    return res.status(500).json({ error: err.message || "Failed to auto-clip" });
  }
});

// Single 9:16 Video Clipper / Re-clipper endpoint
app.post("/api/clip-video", async (req, res) => {
  try {
    const {
      videoUrl = "",
      playableSourceUrl = "",
      youtubeUrl = "",
      startTime = 0,
      duration = 30,
      resolution = "1080p",
      framingMode = "smart_crop",
      panX = 0,
      title = "clip",
      clipId,
    } = req.body;

    const result = await clipVideoSegment({
      videoUrl,
      playableSourceUrl,
      youtubeUrl,
      startTime,
      duration,
      resolution,
      framingMode,
      panX,
      title,
      clipId: clipId || `clip_${Date.now()}`,
    });

    return res.json({
      success: true,
      downloadUrl: result.downloadUrl,
      filename: result.filename,
      duration: result.duration,
      resolution,
    });
  } catch (err: any) {
    console.error("Clip endpoint error:", err);
    return res.status(500).json({ error: err.message || "Failed to clip video" });
  }
});

// Setup Vite middleware in dev or static files in production
async function startServer() {
  if (!isProduction) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`ClipForge server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
