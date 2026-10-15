const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { createService, validateMatch, audioResult, publicAddress, audioHeaders, completeAudio, playbackSources, audioType, inspectAudio } = require('./unblock_helper.cjs');

const audio = { url: 'https://audio.example/song.flac', source: 'kuwo', br: 999000, size: 1234 };

async function fixture(context, options = {}) {
    const service = createService({ token: 'secret', ...options });
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    context.after(() => service.close());
    const base = `http://127.0.0.1:${service.server.address().port}`;
    return {
        ...service,
        base,
        request: (route, body, token = 'secret', signal) => fetch(`${base}${route}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'X-NEMusic-Token': token, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body), signal,
        }),
    };
}

test('validates ids and sources without accepting user-supplied URLs or executables', () => {
    for (const id of [0, -1, '123', 1.5, null]) assert.throws(() => validateMatch({ id, sources: ['kuwo'] }));
    for (const sources of [[], ['ytdlp'], ['qq'], ['kuwo', 'invalid'], 'kuwo']) assert.throws(() => validateMatch({ id: 123, sources }));
    assert.deepEqual(validateMatch({ id: 123, sources: ['kugou', 'kuwo', 'kugou'] }), { id: 123, sources: ['kugou', 'kuwo'] });
    assert.throws(() => audioResult({ ...audio, url: 'file:///tmp/song.mp3' }));
    assert.equal(audioResult(audio).type, 'flac');
});

test('requires a token, supports status and rejects invalid match requests', async context => {
    let calls = 0;
    const service = await fixture(context, { match: async () => { calls++; return audio; } });
    assert.equal((await service.request('/status', undefined, 'wrong')).status, 403);
    assert.equal((await service.request('/status')).status, 200);
    assert.equal((await service.request('/match', { id: 0, sources: ['kuwo'] })).status, 400);
    assert.equal((await service.request('/match', { id: 123, sources: ['ytdlp'] })).status, 400);
    assert.equal(calls, 0);
});

test('caches matches by song and source order and expires stale URLs', async context => {
    const calls = [];
    let now = 1000;
    const service = await fixture(context, { now: () => now, cacheTTL: 100, match: async (id, sources) => { calls.push({ id, sources }); return audio; } });
    const body = { id: 123, sources: ['kugou', 'kuwo'] };
    assert.equal((await (await service.request('/match', body)).json()).provider, 'kuwo');
    await service.request('/match', body);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], body);
    await service.request('/match', { ...body, sources: ['kuwo', 'kugou'] });
    assert.equal(calls.length, 2);
    now += 101;
    await service.request('/match', body);
    assert.equal(calls.length, 3);
});

test('bounds slow matching and cancels the upstream worker', async context => {
    let signal;
    const service = await fixture(context, { timeout: 25, match: (_id, _sources, nextSignal) => { signal = nextSignal; return new Promise(() => {}); } });
    const response = await service.request('/match', { id: 123, sources: ['kuwo'] });
    assert.equal(response.status, 504);
    assert.match((await response.json()).error, /超时/);
    assert.equal(signal.aborted, true);
});

test('does not cache failures and hides upstream details', async context => {
    let calls = 0;
    const service = await fixture(context, { match: async () => { calls++; throw new Error('private upstream detail'); } });
    for (let count = 0; count < 2; count++) {
        const response = await service.request('/match', { id: 123, sources: ['kuwo'] });
        assert.equal(response.status, 502);
        assert.doesNotMatch(JSON.stringify(await response.json()), /private upstream/);
    }
    assert.equal(calls, 2);
});

test('cancels matching when the HTTP client disconnects', async context => {
    let started;
    const running = new Promise(resolve => { started = resolve; });
    let cancelled;
    const aborted = new Promise(resolve => { cancelled = resolve; });
    const service = await fixture(context, { match: (_id, _sources, signal) => {
        signal.addEventListener('abort', cancelled, { once: true });
        started();
        return new Promise(() => {});
    } });
    const controller = new AbortController();
    const pending = service.request('/match', { id: 123, sources: ['kuwo'] }, 'secret', controller.signal);
    await running;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await aborted;
});

test('relays only matched audio handles and supports browser byte ranges without cookies', async context => {
    const calls = [];
    const service = await fixture(context, {
        match: async () => audio,
        media: async (url, headers, signal) => {
            calls.push({ url, headers, signal });
            const incoming = Readable.from([Buffer.from('audio')]);
            incoming.statusCode = 206;
            incoming.headers = { 'content-type': 'audio/flac', 'content-length': '5', 'content-range': 'bytes 10-14/99', 'accept-ranges': 'bytes' };
            return incoming;
        },
    });
    const matched = await (await service.request('/match', { id: 123, sources: ['kuwo'] })).json();
    assert.match(matched.mediaPath, /^\/media\/[a-f0-9]{48}\.flac$/);
    const response = await fetch(service.base + matched.mediaPath, { headers: { Range: 'bytes=10-14', Cookie: 'never-forward-this' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 10-14/99');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(await response.text(), 'audio');
    assert.equal(calls[0].url, audio.url);
    assert.deepEqual(calls[0].headers, { Range: 'bytes=10-14' });
    assert.equal((await fetch(service.base + '/media/' + 'b'.repeat(48))).status, 404);
    assert.equal((await fetch(service.base + '/media/https://example.com')).status, 404);
    assert.equal((await fetch(service.base + matched.mediaPath, { headers: { Range: 'bytes=0-1,4-5' } })).status, 416);
    assert.equal(calls.length, 1);
});

test('media relay rejects private destinations and supplies source-specific headers', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(publicAddress(ip), false);
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(publicAddress(ip), true);
    assert.equal(audioHeaders('https://xy.bilivideo.com/song.m4a').Referer, 'https://www.bilibili.com/');
    assert.equal(audioHeaders('https://audio.example/song.mp3').Referer, 'https://music.163.com/');
});

test('rejects short placeholder clips so matching continues with the next provider', () => {
    assert.equal(completeAudio({ size: 184320, br: 128000 }, 239000), false);
    assert.equal(completeAudio({ size: 3824000, br: 128000 }, 239000), true);
    assert.equal(completeAudio({ size: 9999999, br: null }, 239000), true);
    assert.equal(completeAudio({ size: 184320, br: 128000 }, 12000), true);
});

test('provides the source identity required by the webpage before it loads any audio', () => {
    const result = audioResult({ ...audio, url: 'https://audio.example/song.mp3' });
    assert.equal(result.md5, '985af1752e93238944bf082cb06e892c');
    assert.equal(audioResult({ ...audio, md5: '1'.repeat(32) }).md5, '1'.repeat(32));
    assert.equal(audioResult({ ...audio, md5: 'invalid' }).md5.length, 32);
});

test('keeps saved Bilibili music settings working with a video audio fallback', () => {
    assert.deepEqual(playbackSources(['kuwo', 'kugou', 'bilibili']), ['kuwo', 'kugou', 'bilibili', 'bilivideo']);
    assert.deepEqual(playbackSources(['bilivideo', 'bilibili']), ['bilivideo', 'bilibili']);
    assert.deepEqual(playbackSources(['kugou']), ['kugou']);
});

test('recognizes actual containers instead of treating a Bilibili m4s stream as MP3', async () => {
    const mp4 = Buffer.from('000000246674797069736f6d0000020069736f6d', 'hex');
    assert.equal(audioType(mp4), 'm4a');
    assert.equal(audioType(Buffer.from('fLaC')), 'flac');
    assert.equal(audioType(Buffer.from('ID3')), 'mp3');
    assert.equal(audioType(Buffer.from('fff15080', 'hex')), 'aac');
    assert.equal(audioType(Buffer.from('fffb9000', 'hex')), 'mp3');
    assert.equal(audioType(Buffer.from('<html>expired</html>')), '');
    let incoming;
    const inspect = body => inspectAudio({ ...audio, url: 'https://cdn.example/30216.m4s' }, new AbortController().signal, async (_url, headers) => {
        assert.deepEqual(headers, { Range: 'bytes=0-8191' });
        incoming = Readable.from([body]);
        incoming.statusCode = 206;
        return incoming;
    });
    assert.equal((await inspect(mp4)).type, 'm4a');
    assert.equal(incoming.destroyed, true);
    await assert.rejects(inspect(Buffer.from('<html>expired</html>')), /音频/);
});
