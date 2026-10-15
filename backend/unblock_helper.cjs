const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const dns = require('node:dns').promises;
const { isIP } = require('node:net');
const { randomBytes, createHash } = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const SOURCES = ['kuwo', 'kugou', 'bodian', 'bilibili', 'bilivideo'];

function matchSource(id, source, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('匹配已取消'));
        const worker = new Worker(__filename, { workerData: { id, sources: [source] } });
        const timer = setTimeout(() => {
            void worker.terminate();
            reject(new Error('音源响应超时'));
        }, 6000);
        const abort = () => { void worker.terminate(); reject(new Error('匹配已取消')); };
        signal.addEventListener('abort', abort, { once: true });
        worker.once('message', result => {
            if (result.error) reject(new Error(result.error));
            else resolve(result);
        });
        worker.once('error', reject);
        worker.once('exit', () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            reject(new Error('匹配进程已退出'));
        });
    });
}

async function matchInWorker(id, sources, signal) {
    for (const source of playbackSources(sources)) {
        if (signal.aborted) throw new Error('匹配已取消');
        try { return await matchSource(id, source, signal); }
        catch (error) { if (signal.aborted) throw error; }
    }
    throw new Error('没有找到可用音频');
}

function playbackSources(sources) {
    // The old default used Bilibili's music catalog, which no longer covers many songs.
    // Keep saved settings working by also trying video audio after that catalog fails.
    return [...new Set(sources.flatMap(source => source === 'bilibili' ? [source, 'bilivideo'] : [source]))];
}

function validateMatch(body) {
    if (!body || !Number.isSafeInteger(body.id) || body.id <= 0) throw new Error('无效的网易云歌曲 ID');
    if (!Array.isArray(body.sources) || !body.sources.length || body.sources.length > SOURCES.length
        || body.sources.some(source => !SOURCES.includes(source))) throw new Error('无效的匹配音源');
    return { id: body.id, sources: [...new Set(body.sources)] };
}

function audioResult(result) {
    const url = new URL(result.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('音源返回了无效地址');
    if (!SOURCES.includes(result.source)) throw new Error('音源返回了无效来源');
    const extension = /\.(mp3|flac|m4a|aac|ogg)(?:$|\?)/i.exec(url.href)?.[1]?.toLowerCase() || '';
    const type = ['mp3', 'flac', 'm4a', 'aac', 'ogg'].includes(result.type) ? result.type : extension;
    // The webpage rejects a source with no md5 before it ever creates an audio element.
    // Like upstream UnblockNeteaseMusic, use a URL identity when no content hash exists.
    const md5 = /^[a-f0-9]{32}$/i.test(result.md5 || '') ? result.md5 : createHash('md5').update(url.href).digest('hex');
    return { url: url.href, provider: result.source, br: Number(result.br) || 0, size: Number(result.size) || 0,
        type, md5, duration: Number(result.duration) || 0 };
}

function audioType(bytes) {
    if (bytes.subarray(0, 4).toString() === 'fLaC') return 'flac';
    if (bytes.subarray(4, 8).toString() === 'ftyp') return 'm4a';
    if (bytes.subarray(0, 4).toString() === 'OggS') return 'ogg';
    if (bytes.subarray(0, 3).toString() === 'ID3') return 'mp3';
    if (bytes.length > 3 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'aac';
    if (bytes.length > 3 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6)) return 'mp3';
    return '';
}

async function inspectAudio(result, signal, media = openMedia) {
    const incoming = await media(result.url, { Range: 'bytes=0-8191' }, signal);
    try {
        if (![200, 206].includes(incoming.statusCode)) throw new Error('音频地址不可读取');
        const chunks = [];
        let size = 0;
        for await (const chunk of incoming) {
            const bytes = Buffer.from(chunk).subarray(0, 8192 - size);
            chunks.push(bytes);
            size += bytes.length;
            if (size >= 8192) break;
        }
        const type = audioType(Buffer.concat(chunks));
        if (!type) throw new Error('音源没有返回可识别的音频');
        return { ...result, type };
    } finally { incoming.destroy(); }
}

function completeAudio(result, duration) {
    const seconds = Number(duration) / 1000;
    const estimated = Number(result.size) * 8 / Number(result.br);
    return !(seconds > 30 && Number.isFinite(estimated) && estimated > 0 && estimated < seconds * 0.4);
}

function publicAddress(address) {
    if (isIP(address) === 4) {
        const [a, b] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
            || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0)
            || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19));
    }
    if (isIP(address) === 6) return /^2[0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0):/i.test(address);
    return false;
}

function audioHeaders(url) {
    const hostname = new URL(url).hostname;
    const bili = /(?:^|\.)bilivideo\.(?:com|cn)$/.test(hostname) || hostname === 'upos-hz-mirrorakam.akamaized.net';
    return { 'User-Agent': bili ? 'okhttp/3.15.1' : 'NEMusicOnSteam/0.1',
        Referer: bili ? 'https://www.bilibili.com/' : 'https://music.163.com/', 'Accept-Encoding': 'identity' };
}

async function openMedia(raw, headers, signal, redirects = 0) {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || redirects > 4) throw new Error('无效音频地址');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('无效音频主机');
    const chosen = addresses[0];
    return new Promise((resolve, reject) => {
        const upstream = (url.protocol === 'https:' ? https : http).request(url, {
            headers: { ...audioHeaders(raw), ...headers }, signal,
            lookup: (_hostname, options, callback) => options.all
                ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family),
        }, incoming => {
            if ([301, 302, 303, 307, 308].includes(incoming.statusCode) && incoming.headers.location) {
                incoming.resume();
                resolve(openMedia(new URL(incoming.headers.location, url).href, headers, signal, redirects + 1));
            } else resolve(incoming);
        });
        upstream.setTimeout(30000, () => upstream.destroy(new Error('音频连接超时')));
        upstream.once('error', reject);
        upstream.end();
    });
}

function createService({ token, match = matchInWorker, timeout = 25000, cacheTTL = 120000, now = Date.now, media = openMedia }) {
    const cache = new Map();
    const mediaHandles = new Map();
    const active = new Set();
    const streams = new Set();
    let lastSeen = now();
    const server = http.createServer(async (request, response) => {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-NEMusic-Token, Range');
        response.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
        response.setHeader('Cache-Control', 'no-store');
        const reply = (status, payload) => {
            if (response.destroyed || response.writableEnded) return;
            response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify(payload));
        };
        if (request.method === 'OPTIONS') { reply(204, {}); return; }
        if (request.url?.startsWith('/media/')) {
            const entry = mediaHandles.get(request.url);
            if (!entry || now() - entry.time > 7200000) { reply(404, {}); return; }
            if (!['GET', 'HEAD'].includes(request.method)) { reply(405, {}); return; }
            if (streams.size >= 4) { reply(429, {}); return; }
            const range = request.headers.range;
            if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) { reply(416, {}); return; }
            lastSeen = now();
            entry.time = now();
            const controller = new AbortController();
            streams.add(controller);
            const disconnected = () => controller.abort();
            response.once('close', disconnected);
            try {
                const incoming = await media(entry.url, range ? { Range: range } : {}, controller.signal);
                incoming.once('error', () => response.destroy());
                if (controller.signal.aborted) { incoming.destroy(); return; }
                const status = incoming.statusCode;
                if (![200, 206, 416].includes(status)) { incoming.destroy(); reply(502, { error: '音频读取失败' }); return; }
                for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
                    if (incoming.headers[name]) response.setHeader(name, incoming.headers[name]);
                }
                response.writeHead(status);
                if (request.method === 'HEAD') { incoming.destroy(); response.end(); }
                else await new Promise(resolve => {
                    incoming.once('end', resolve);
                    incoming.once('close', resolve);
                    response.once('close', () => { incoming.destroy(); resolve(); });
                    incoming.pipe(response);
                });
            } catch { reply(502, { error: '音频读取失败' }); }
            finally {
                controller.abort();
                streams.delete(controller);
                response.removeListener('close', disconnected);
            }
            return;
        }
        if (request.headers['x-nemusic-token'] !== token) { reply(403, { error: '无效令牌' }); return; }
        lastSeen = now();
        if (request.method === 'GET' && request.url === '/status') {
            reply(200, { ready: true, sources: SOURCES });
            return;
        }
        if (request.method === 'POST' && request.url === '/shutdown') {
            reply(200, {});
            setImmediate(close);
            return;
        }
        if (request.method !== 'POST' || request.url !== '/match') { reply(404, {}); return; }
        let input;
        try {
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
                size += chunk.length;
                if (size > 4096) { reply(413, { error: '请求过大' }); return; }
                chunks.push(chunk);
            }
            input = validateMatch(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
            reply(400, { error: '无效的歌曲 ID 或匹配音源' });
            return;
        }
        const key = `${input.id}:${input.sources.join(',')}`;
        const cached = cache.get(key);
        if (cached && now() - cached.time < cacheTTL) { reply(200, cached.result); return; }
        if (active.size >= 2) { reply(429, { error: '音源正在匹配，请稍后重试' }); return; }
        const controller = new AbortController();
        active.add(controller);
        const disconnected = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', disconnected);
        let expired = false;
        let timer;
        let abortMatch;
        try {
            const result = await Promise.race([
                match(input.id, input.sources, controller.signal),
                new Promise((resolve, reject) => {
                    abortMatch = () => reject(new Error('匹配已取消'));
                    controller.signal.addEventListener('abort', abortMatch, { once: true });
                    if (controller.signal.aborted) abortMatch();
                }),
                new Promise((resolve, reject) => {
                    timer = setTimeout(() => {
                        expired = true;
                        reject(new Error('音源匹配超时，可调整音源顺序后重试'));
                        controller.abort();
                    }, timeout);
                }),
            ]);
            if (controller.signal.aborted) return;
            const audio = audioResult(result);
            audio.mediaPath = '/media/' + randomBytes(24).toString('hex') + '.' + (audio.type || 'mp3');
            mediaHandles.set(audio.mediaPath, { url: audio.url, time: now() });
            while (mediaHandles.size > 128) mediaHandles.delete(mediaHandles.keys().next().value);
            cache.delete(key);
            cache.set(key, { time: now(), result: audio });
            while (cache.size > 64) cache.delete(cache.keys().next().value);
            reply(200, audio);
        } catch (error) {
            reply(expired ? 504 : 502, { error: expired ? error.message : '所选音源没有找到可用音频，可调整音源后重试' });
        } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', abortMatch);
            response.removeListener('close', disconnected);
            controller.abort();
            active.delete(controller);
        }
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    function close() {
        for (const controller of active) controller.abort();
        for (const controller of streams) controller.abort();
        server.close();
        server.closeAllConnections();
    }
    return { server, close, idle: () => active.size === 0 && streams.size === 0 && now() - lastSeen > 120000 };
}

if (!isMainThread) {
    process.env.LOG_LEVEL = 'silent';
    process.env.JSON_LOG = 'true';
    delete process.env.LOG_FILE;
    process.env.FOLLOW_SOURCE_ORDER = 'true';
    delete process.env.SELECT_MAX_BR;
    const match = require('@unblockneteasemusic/server');
    const find = require('@unblockneteasemusic/server/src/provider/find');
    find(workerData.id).then(async info => {
        const result = await inspectAudio(await match(workerData.id, workerData.sources, info), AbortSignal.timeout(5000));
        if (!completeAudio(result, info.duration)) throw new Error('音源返回了过短的片段');
        return { ...result, duration: info.duration };
    }).then(
        result => parentPort.postMessage(result),
        () => parentPort.postMessage({ error: '没有找到可用音源' }),
    ).finally(() => process.exit());
} else if (require.main === module) {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('UnblockNeteaseMusic 需要 Node.js 22 或以上版本');
    const directory = process.argv[2];
    const token = fs.readFileSync(path.join(directory, 'token'), 'utf8').trim();
    if (!token) throw new Error('缺少本地服务令牌');
    const service = createService({ token });
    const portFile = path.join(directory, 'port');
    const idleTimer = setInterval(() => { if (service.idle()) service.close(); }, 10000);
    service.server.once('close', () => {
        clearInterval(idleTimer);
        fs.rmSync(portFile, { force: true });
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, service.close);
    service.server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(service.server.address().port), { mode: 0o600 }));
}

module.exports = { createService, validateMatch, audioResult, publicAddress, audioHeaders, completeAudio, playbackSources, audioType, inspectAudio };
