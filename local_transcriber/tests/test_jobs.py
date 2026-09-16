import asyncio
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch

from local_transcriber.jobs import JOB_TTL, Job, JobManager


class JobManagerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.manager = JobManager.__new__(JobManager)
        self.manager.jobs = {}
        self.manager.lock = asyncio.Lock()
        self.manager.worker = asyncio.Semaphore(1)
        self.release_jobs = asyncio.Event()

        async def run(job):
            try:
                await self.release_jobs.wait()
            except asyncio.CancelledError:
                job.status = "cancelled"
                job.message = "已取消"
                raise

        self.manager._run = run

    async def asyncTearDown(self):
        self.release_jobs.set()
        await asyncio.gather(
            *(job.task for job in self.manager.jobs.values() if job.task),
            return_exceptions=True,
        )

    async def test_terminal_jobs_do_not_consume_capacity(self):
        for index, status in enumerate(("completed", "failed", "cancelled", "completed")):
            self.manager.jobs[str(index)] = Job(str(index), {}, status=status)

        job = await self.manager.create_if_capacity({"audio": {"urls": []}}, 4)

        self.assertIsNotNone(job)
        self.assertEqual(job.status, "queued")

    async def test_four_active_jobs_reject_new_job(self):
        for index, status in enumerate(("queued", "downloading", "transcribing", "queued")):
            self.manager.jobs[str(index)] = Job(str(index), {}, status=status)

        job = await self.manager.create_if_capacity({"audio": {"urls": []}}, 4)

        self.assertIsNone(job)

    async def test_concurrent_admission_does_not_exceed_limit(self):
        jobs = await asyncio.gather(
            *(self.manager.create_if_capacity({"audio": {"urls": []}}, 4) for _ in range(8))
        )

        self.assertEqual(sum(job is not None for job in jobs), 4)
        self.assertEqual(sum(job.status == "queued" for job in self.manager.jobs.values()), 4)

    async def test_cleanup_expired_removes_only_terminal_jobs(self):
        expired = Job("expired", {}, status="completed", created_at=time.time() - JOB_TTL - 1)
        active = Job("active", {}, status="downloading", created_at=time.time() - JOB_TTL - 1)
        recent = Job("recent", {}, status="failed")
        self.manager.jobs = {job.id: job for job in (expired, active, recent)}

        await self.manager.cleanup_expired()

        self.assertNotIn(expired.id, self.manager.jobs)
        self.assertIn(active.id, self.manager.jobs)
        self.assertIn(recent.id, self.manager.jobs)

    async def test_cancelled_job_releases_capacity_and_remains_queryable(self):
        job = await self.manager.create_if_capacity({"audio": {"urls": []}}, 1)

        self.assertTrue(await self.manager.cancel(job.id))
        self.assertEqual((await self.manager.get(job.id)).status, "cancelled")

        replacement = await self.manager.create_if_capacity({"audio": {"urls": []}}, 1)
        self.assertIsNotNone(replacement)

    def test_ranges_are_clamped_to_video_duration(self):
        job = Job("ranges", {"video": {"duration": 100}, "options": {"ranges": [
            {"start": 0, "end": 20}, {"start": 90, "end": 120}, {"start": 40, "end": 40}, {"start": 110, "end": 120}
        ]}})
        self.assertEqual(self.manager._ranges(job), [{"start": 0.0, "end": 20.0}, {"start": 90.0, "end": 100.0}])

    async def test_waiting_job_can_be_resumed(self):
        job = Job("waiting", {}, status="awaiting_continue")
        self.manager.jobs[job.id] = job
        self.assertTrue(await self.manager.continue_job(job.id))
        self.assertTrue(job.continue_event.is_set())

    async def test_progress_distinguishes_elapsed_time_from_cumulative_audio(self):
        job = Job("timing", {}, transcription_started_at=0)
        ranges = [{"start": 0, "end": 200}, {"start": 400, "end": 800}]
        with patch("local_transcriber.jobs.time", Mock(monotonic=Mock(return_value=20))), \
                self.assertLogs("local_transcriber.jobs", level="INFO") as logs:
            await self.manager._transcribe_progress(job, ranges, 1)(100)

        self.assertEqual(job.transcription_seconds, 300)
        self.assertEqual(job.transcription_eta, 20)
        self.assertIn("识别耗时 20 秒，已处理音频 300/600 秒，ETA 20 秒", logs.output[0])

    async def test_waiting_between_ranges_is_excluded_from_recognition_time(self):
        job = Job("paused", {"audio": {"urls": ["test"]}, "video": {"duration": 200},
                             "options": {"ranges": [{"start": 0, "end": 100},
                                                    {"start": 100, "end": 200}]}})
        self.manager.completed_processing_seconds = 0
        self.manager.completed_audio_seconds = 0
        clock = [0]
        manager = self.manager

        class FakeTranscriber:
            async def run(self, _source, _wav, _language, progress, start, _end):
                clock[0] += 10
                await progress(100)
                if start == 0:
                    async def resume():
                        clock[0] += 1000
                        job.continue_event.set()
                    asyncio.create_task(resume())
                return []

        manager.transcriber = FakeTranscriber()
        with patch("local_transcriber.jobs.tempfile.mkdtemp", return_value="test-audio"), \
                patch("local_transcriber.jobs.Path.stat", return_value=Mock(st_size=5)), \
                patch.object(manager, "_cleanup", new_callable=AsyncMock), \
                patch("local_transcriber.jobs.download_audio", new_callable=AsyncMock), \
                patch("local_transcriber.jobs.time", Mock(time=time.time, monotonic=Mock(side_effect=lambda: clock[0]))), \
                self.assertLogs("local_transcriber.jobs", level="INFO") as logs:
            await JobManager._run(manager, job)

        self.assertEqual(job.status, "completed", job.error)
        self.assertTrue(any("识别耗时 20 秒，已处理音频 200/200 秒" in line for line in logs.output))


if __name__ == "__main__":
    unittest.main()
