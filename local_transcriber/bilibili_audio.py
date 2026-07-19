from __future__ import annotations

import asyncio
import ipaddress
import socket
from pathlib import Path
from urllib.parse import urljoin, urlparse

ALLOWED_HOST_SUFFIXES = (".hdslb.com", ".bilivideo.cn", ".bilivideo.com", ".edge.mountaintoys.cn")
MAX_AUDIO_BYTES = 1_024 * 1_024 * 1024
MAX_REDIRECTS = 3


def _is_private_host(host: str) -> bool:
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except socket.gaierror:
            return True
        return any(ipaddress.ip_address(info[4][0]).is_private for info in infos)
    return address.is_private or address.is_loopback or address.is_link_local or address.is_reserved


def validate_audio_url(url: str) -> None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or not host:
        raise ValueError("音频地址必须使用 HTTPS。")
    if not (host.endswith(ALLOWED_HOST_SUFFIXES) or host == "bilivideo.com"):
        raise ValueError("音频地址不是受支持的 B 站 CDN。")
    if _is_private_host(host):
        raise ValueError("音频地址解析到了不安全的本机或内网地址。")
    if len(url) > 32_768:
        raise ValueError("音频地址过长。")


async def download_audio(url: str, target: Path, progress=None) -> int:
    import httpx

    current = url
    timeout = httpx.Timeout(30.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            validate_audio_url(current)
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Referer": "https://www.bilibili.com/",
                "Origin": "https://www.bilibili.com",
                "Accept": "*/*",
                "Accept-Encoding": "identity",
                "Range": "bytes=0-",
            }
            async with client.stream("GET", current, headers=headers) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("音频 CDN 返回了无效重定向。")
                    current = urljoin(current, location)
                    continue
                response.raise_for_status()
                length = int(response.headers.get("content-length", "0") or 0)
                if length > MAX_AUDIO_BYTES:
                    raise ValueError("音频文件超过大小限制。")
                size = 0
                with target.open("wb") as output:
                    async for chunk in response.aiter_bytes(1024 * 1024):
                        size += len(chunk)
                        if size > MAX_AUDIO_BYTES:
                            raise ValueError("音频文件超过大小限制。")
                        output.write(chunk)
                        if progress:
                            await progress(size, length)
                return size
        raise ValueError("音频重定向次数超过限制。")
