from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from rich.live import Live
from rich.layout import Layout
from rich.panel import Panel
from rich.text import Text


class DashboardHandler(logging.Handler):
    def __init__(self, dashboard, name: str):
        super().__init__()
        self.dashboard = dashboard
        self.name = name

    def emit(self, record):
        self.dashboard.add(self.name, self.format(record))


class Dashboard:
    def __init__(self):
        self.lines = {"transcription": [], "http": []}
        self.live = Live(self.render(), refresh_per_second=5, screen=False)
        self.handlers = []

    def render(self):
        transcription = Text("\n".join(self.lines["transcription"]) or "等待识别任务…", overflow="ellipsis")
        http = Text("\n".join(self.lines["http"]) or "等待 HTTP 请求…", overflow="ellipsis")
        layout = Layout(name="root")
        layout.split_column(Layout(Panel(transcription, title="语音识别", border_style="cyan"), name="transcription", ratio=2), Layout(Panel(http, title="HTTP 请求", border_style="green"), name="http", ratio=1))
        return layout

    def add(self, name, message):
        self.lines[name].append(message)
        self.lines[name] = self.lines[name][-12:]
        self.live.update(self.render())

    def start(self):
        self.live.start()

    def stop(self):
        self.live.stop()


_dashboard = Dashboard()
logger = logging.getLogger("local_transcriber")
logger.setLevel(logging.INFO)
logger.propagate = False
access_logger = logging.getLogger("uvicorn.access")
access_logger.propagate = False


def configure_dashboard_logging():
    for target, name, formatter in ((logger, "transcription", "%(asctime)s %(levelname)s: %(message)s"), (access_logger, "http", "%(asctime)s %(message)s")):
        target.handlers.clear()
        handler = DashboardHandler(_dashboard, name)
        handler.setFormatter(logging.Formatter(formatter))
        target.addHandler(handler)


configure_dashboard_logging()
from pydantic import BaseModel, Field, HttpUrl

from .jobs import JobManager

PORT = int(os.getenv("BILI_TRANSCRIBER_PORT", "8765"))
TOKEN = os.getenv("BILI_TRANSCRIBER_TOKEN", "")
MODEL = os.getenv("BILI_TRANSCRIBER_MODEL", "small")
manager = JobManager(MODEL)


class Audio(BaseModel):
    urls: list[HttpUrl] = Field(min_length=1, max_length=5)

    @property
    def url_values(self) -> list[str]:
        return [str(url) for url in self.urls]


class RequestBody(BaseModel):
    requestId: str = Field(min_length=8, max_length=100)
    video: dict = Field(default_factory=dict)
    audio: Audio
    options: dict = Field(default_factory=dict)


def authorize(request: Request) -> None:
    if TOKEN and request.headers.get("authorization") != f"Bearer {TOKEN}":
        raise HTTPException(401, "本机服务令牌无效。")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _dashboard.start()
    configure_dashboard_logging()
    try:
        yield
    finally:
        for job in list(manager.jobs.values()):
            await manager.cancel(job.id)
        _dashboard.stop()


app = FastAPI(title="B 站本机音频转写", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["chrome-extension://"], allow_methods=["GET", "POST", "DELETE"], allow_headers=["Authorization", "Content-Type"])


@app.get("/v1/health")
async def health():
    return {"status": "ok", "service": "bilibili-local-transcriber", "version": "0.1.0", "model": MODEL}


@app.post("/v1/transcriptions", status_code=202)
async def create_transcription(body: RequestBody, request: Request):
    authorize(request)
    if len(manager.jobs) >= 4:
        raise HTTPException(429, "本机转写任务过多。")
    job = await manager.create(body.model_dump(mode="json"))
    return {"jobId": job.id, "status": job.status}


@app.get("/v1/transcriptions/{job_id}")
async def get_transcription(job_id: str, request: Request):
    authorize(request)
    job = await manager.get(job_id)
    if not job:
        raise HTTPException(404, "找不到转写任务。")
    return {"jobId": job.id, "status": job.status, "progress": job.progress, "message": job.message, "transcription": manager.transcription_details(job), "duration": job.result.get("duration") if job.result else None, "language": job.result.get("language") if job.result else None, "segments": job.result.get("segments") if job.result else None, "error": job.error}


@app.delete("/v1/transcriptions/{job_id}", status_code=204)
async def cancel_transcription(job_id: str, request: Request):
    authorize(request)
    if not await manager.cancel(job_id):
        raise HTTPException(404, "找不到转写任务。")
    return Response(status_code=204)


async def cleanup_loop():
    while True:
        await asyncio.sleep(300)
        await manager.cleanup_expired()
