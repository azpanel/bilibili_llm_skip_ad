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
ACTIVE_JOB_STATUSES = {"queued", "downloading", "transcribing", "awaiting_continue"}
TERMINAL_JOB_STATUSES = {"completed", "failed", "cancelled"}


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
    processing_started_at: float | None = None
    completed_ranges: list[dict] = field(default_factory=list)
    current_range: int = 0
    continue_event: asyncio.Event = field(default_factory=asyncio.Event)


class JobManager:
    def __init__(self, model_name: str = "small"):
        self.jobs: dict[str, Job] = {}
        self.lock = asyncio.Lock()
        self.worker = asyncio.Semaphore(1)
        self.transcriber = Transcriber(model_name=model_name)
        self.received_jobs = 0
        self.received_audio_seconds = 0.0
        self.completed_processing_seconds = 0.0
        self.completed_audio_seconds = 0.0
        logger.info("转录器配置：模型=%s，设备=%s，计算类型=%s，beam_size=%d，设备索引=%d，workers=%d", self.transcriber.model_name, self.transcriber.device, self.transcriber.compute_type, self.transcriber.beam_size, self.transcriber.device_index, self.transcriber.num_workers)

    async def create(self, request: dict) -> Job:
        async with self.lock:
            return self._create(request)

    async def create_if_capacity(self, request: dict, limit: int) -> Job | None:
        async with self.lock:
            active_count = sum(job.status in ACTIVE_JOB_STATUSES for job in self.jobs.values())
            if active_count >= limit:
                return None
            return self._create(request)

    def _create(self, request: dict) -> Job:
        job = Job(uuid.uuid4().hex, request)
        self.jobs[job.id] = job
        self.received_jobs = getattr(self, "received_jobs", 0) + 1
        self.received_audio_seconds = getattr(self, "received_audio_seconds", 0.0) + self._audio_duration(job)
        job.task = asyncio.create_task(self._run(job))
        return job

    @staticmethod
    def _audio_duration(job: Job) -> float:
        return sum(value["end"] - value["start"] for value in JobManager._ranges(job))

    def statistics(self) -> dict:
        efficiency = self.completed_audio_seconds / self.completed_processing_seconds if self.completed_processing_seconds else 0
        return {
            "received_jobs": self.received_jobs,
            "received_audio_seconds": self.received_audio_seconds,
            "completed_processing_seconds": self.completed_processing_seconds,
            "efficiency": efficiency,
        }

    async def get(self, job_id: str) -> Job | None:
        async with self.lock:
            return self.jobs.get(job_id)

    async def cancel(self, job_id: str) -> bool:
        async with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return False
            if job.status in TERMINAL_JOB_STATUSES:
                return True
            if job.task and not job.task.done():
                job.task.cancel()
            job.status = "cancelled"
            job.message = "已取消"
            return True

    async def continue_job(self, job_id: str) -> bool:
        async with self.lock:
            job = self.jobs.get(job_id)
            if not job or job.status != "awaiting_continue":
                return False
            job.continue_event.set()
            return True

    async def cleanup_expired(self) -> None:
        now = time.time()
        async with self.lock:
            expired = [
                job
                for job in self.jobs.values()
                if now - job.created_at > JOB_TTL and job.status in TERMINAL_JOB_STATUSES
            ]
            for job in expired:
                self.jobs.pop(job.id, None)
        for job in expired:
            await self._cleanup(job)

    async def _run(self, job: Job) -> None:
        job.directory = Path(tempfile.mkdtemp(prefix=f"bili-transcribe-{job.id}-"))
        source = job.directory / "audio.m4s"
        wav = job.directory / "audio.wav"
        try:
            logger.info("任务 %s 开始，候选音频 %d 个", job.id, len(job.request["audio"]["urls"]))
            async with self.worker:
                job.processing_started_at = time.time()
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
                ranges = self._ranges(job)
                job.transcription_started_at = time.monotonic()
                all_segments = []
                for index, selected_range in enumerate(ranges):
                    job.current_range = index
                    job.status, job.message = "transcribing", f"正在识别第 {index + 1}/{len(ranges)} 个范围"
                    logger.info("任务 %s 开始识别范围 %d/%d", job.id, index + 1, len(ranges))
                    range_wav = wav.with_name(f"audio-{index}.wav")
                    segments = await self.transcriber.run(source, range_wav, job.request.get("options", {}).get("language", "zh"), self._transcribe_progress(job, ranges, index), selected_range["start"], selected_range["end"])
                    completed = {"index": index, "start": selected_range["start"], "end": selected_range["end"], "segments": segments}
                    job.completed_ranges.append(completed)
                    all_segments.extend(segments)
                    job.result = {"duration": job.request.get("video", {}).get("duration"), "language": "zh", "segments": all_segments, "completedRanges": job.completed_ranges}
                    if index < len(ranges) - 1:
                        job.status, job.message = "awaiting_continue", f"第 {index + 1}/{len(ranges)} 个范围识别完成，等待检查结果"
                        job.continue_event.clear()
                        waiting_started_at = time.monotonic()
                        await job.continue_event.wait()
                        job.transcription_started_at += time.monotonic() - waiting_started_at
                job.status, job.message, job.progress = "completed", "识别完成", 100
                self.completed_processing_seconds += time.time() - job.processing_started_at
                self.completed_audio_seconds += self._audio_duration(job)
                logger.info("任务 %s 识别完成，共 %d 段", job.id, len(all_segments))
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

    @staticmethod
    def _ranges(job: Job) -> list[dict]:
        duration = float(job.request.get("video", {}).get("duration") or 0)
        values = job.request.get("options", {}).get("ranges") or [{"start": 0, "end": duration}]
        ranges = []
        for value in values:
            start, end = float(value.get("start", 0)), float(value.get("end", duration))
            end = min(end, duration) if duration else end
            if start >= 0 and end > start:
                ranges.append({"start": start, "end": end})
        return ranges or [{"start": 0, "end": duration}]

    def _transcribe_progress(self, job, ranges, range_index):
        selected_duration = sum(value["end"] - value["start"] for value in ranges)
        prior_duration = sum(value["end"] - value["start"] for value in ranges[:range_index])

        async def update(seconds: float):
            previous = job.progress
            job.transcription_seconds = prior_duration + seconds
            job.progress = min(69, 35 + int(job.transcription_seconds / selected_duration * 34)) if selected_duration else 35
            elapsed = max(0, time.monotonic() - job.transcription_started_at) if job.transcription_started_at is not None else 0
            if job.transcription_started_at is not None and seconds > 0:
                job.transcription_eta = max(0, elapsed * (selected_duration / job.transcription_seconds - 1)) if job.transcription_seconds else None
            if job.progress != previous:
                logger.info("任务 %s 识别进度 %d%%（识别耗时 %.0f 秒，已处理音频 %.0f/%.0f 秒，ETA %s）", job.id, job.progress, elapsed, job.transcription_seconds, selected_duration, f"{job.transcription_eta:.0f} 秒" if job.transcription_eta is not None else "估算中")
        return update

    def transcription_details(self, job: Job) -> dict:
        duration = sum(value["end"] - value["start"] for value in self._ranges(job))
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
