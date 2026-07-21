import asyncio
import time
import unittest

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


if __name__ == "__main__":
    unittest.main()
