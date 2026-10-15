from urllib.parse import urlsplit


def audio_headers(url):
    host = (urlsplit(url).hostname or "").lower()
    bilibili = any(host == domain or host.endswith("." + domain) for domain in ("bilivideo.com", "bilivideo.cn", "upos-hz-mirrorakam.akamaized.net"))
    return {
        "User-Agent": "okhttp/3.4.1" if bilibili else "NEMusicOnSteam",
        "Referer": "https://www.bilibili.com/" if bilibili else "https://music.163.com/",
    }
