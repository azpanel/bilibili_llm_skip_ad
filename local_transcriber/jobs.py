from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
import time
import uuid


logger = logging.getLogger(__name__)
from dataclasses import dataclass, field
from pathlib import Path

from .bilibili_audio import download_audio
from .transcribe import Transcriber

JOB_TTL = 3600


@dataclass
class Job:
    id: str
    request: dict
    status: str = "queued"
    progress: int = 0
    message: str = "排队中"
    transcription_seconds: float = 0
    transcription_eta: float | None = None
    transcription_started_at: float | None = None
    result: dict | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    task: asyncio.Task | None = None
    directory: Path | None = None


class JobManager:
    def __init__(self, model_name: str = "small"):
        self.jobs: dict[str, Job] = {}
        self.lock = asyncio.Lock()
        self.worker = asyncio.Semaphore(1)
        self.transcriber = Transcriber(model_name=model_name)
        logger.info("转录器配置：模型=%s，设备=%s，计算类型=%s，beam_size=%d，设备索引=%d，workers=%d", self.transcriber.model_name, self.transcriber.device, self.transcriber.compute_type, self.transcriber.beam_size, self.transcriber.device_index, self.transcriber.num_workers)

    async def create(self, request: dict) -> Job:
        async with self.lock:
            job = Job(uuid.uuid4().hex, request)
            self.jobs[job.id] = job
            job.task = asyncio.create_task(self._run(job))
            return job

    async def get(self, job_id: str) -> Job | None:
        async with self.lock:
            return self.jobs.get(job_id)

    async def cancel(self, job_id: str) -> bool:
        job = await self.get(job_id)
        if not job:
            return False
        if job.task and not job.task.done():
            job.task.cancel()
        job.status = "cancelled"
        job.message = "已取消"
        await self._cleanup(job)
        return True

    async def cleanup_expired(self) -> None:
        now = time.time()
        for job in list(self.jobs.values()):
            if now - job.created_at > JOB_TTL and job.status in {"completed", "failed", "cancelled"}:
                await self._cleanup(job)
                self.jobs.pop(job.id, None)

    async def _run(self, job: Job) -> None:
        job.directory = Path(tempfile.mkdtemp(prefix=f"bili-transcribe-{job.id}-"))
        source = job.directory / "audio.m4s"
        wav = job.directory / "audio.wav"
        try:
            logger.info("任务 %s 开始，候选音频 %d 个", job.id, len(job.request["audio"]["urls"]))
            async with self.worker:
                job.status, job.message, job.progress = "downloading", "正在下载音频", 5
                errors = []
                for index, audio_url in enumerate(job.request["audio"]["urls"], 1):
                    logger.info("任务 %s 下载候选源 %d/%d：%s", job.id, index, len(job.request["audio"]["urls"]), audio_url.split("?", 1)[0])
                    try:
                        await download_audio(audio_url, source, self._download_progress(job))
                        logger.info("任务 %s 音频下载完成，大小约 %.1f MB", job.id, source.stat().st_size / 1024 / 1024)
                        break
                    except Exception as error:
                        logger.warning("任务 %s 候选源 %d 失败：%s", job.id, index, error)
                        errors.append(str(error))
                else:
                    raise RuntimeError("所有音频地址均下载失败：" + "；".join(errors))
                job.status, job.message, job.progress = "transcribing", "正在进行语音识别", 35
                job.transcription_started_at = time.time()
                logger.info("任务 %s 开始 FFmpeg 转码和模型识别", job.id)
                segments = await self.transcriber.run(source, wav, job.request.get("options", {}).get("language", "zh"), self._transcribe_progress(job))
                job.status, job.message, job.progress = "completed", "识别完成", 100
                logger.info("任务 %s 识别完成，共 %d 段", job.id, len(segments))
                job.result = {"duration": job.request.get("video", {}).get("duration"), "language": "zh", "segments": segments}
        except asyncio.CancelledError:
            job.status, job.message = "cancelled", "已取消"
            logger.info("任务 %s 已取消", job.id)
        except Exception as error:
            job.status, job.message, job.error = "failed", "识别失败", str(error)
            logger.exception("任务 %s 失败", job.id)
        finally:
            await self._cleanup(job)

    @staticmethod
    def _format_mb(size: int) -> str:
        return f"{size / 1024 / 1024:.1f} MB"

    def _download_progress(self, job):
        async def update(size: int, total: int):
            previous = job.progress
            job.progress = min(34, 5 + int(size / total * 29)) if total else min(34, job.progress + 1)
            if job.progress != previous and job.progress % 5 == 0:
                logger.info("任务 %s 下载进度 %d%%（%s）", job.id, job.progress, self._format_mb(size))
        return update

    def _transcribe_progress(self, job):
        duration = float(job.request.get("video", {}).get("duration") or 0)

        async def update(seconds: float):
            previous = job.progress
            job.transcription_seconds = seconds
            job.progress = min(69, 35 + int(seconds / duration * 34)) if duration else min(69, 35 + int(seconds / 60))
            if job.transcription_started_at and seconds > 0:
                elapsed = max(0.001, time.time() - job.transcription_started_at)
                job.transcription_eta = max(0, elapsed * (duration / seconds - 1)) if duration else None
            if job.progress != previous:
                logger.info("任务 %s 识别进度 %d%%（已处理 %.0f 秒，ETA %.0f 秒）", job.id, job.progress, seconds, job.transcription_eta or 0)
        return update

    def transcription_details(self, job: Job) -> dict:
        duration = float(job.request.get("video", {}).get("duration") or 0)
        return {
            "seconds": round(job.transcription_seconds, 1),
            "duration": round(duration, 1) if duration else None,
            "progress": round(job.transcription_seconds / duration * 100, 1) if duration else None,
            "eta": round(job.transcription_eta, 1) if job.transcription_eta is not None else None,
        }

    async def _cleanup(self, job: Job) -> None:
        if job.directory:
            await asyncio.to_thread(shutil.rmtree, job.directory, True)
            job.directory = None

