from __future__ import annotations

import asyncio
import os
import queue
import subprocess
from pathlib import Path


def _configure_cuda_dlls() -> list[object]:
    if os.name != "nt":
        return []
    import ctypes
    import nvidia

    nvidia_root = Path(next(iter(nvidia.__path__)))
    dll_dirs = [nvidia_root / "cublas" / "bin", nvidia_root / "cudnn" / "bin", nvidia_root / "cuda_nvrtc" / "bin"]
    handles = []
    for directory in dll_dirs:
        if directory.is_dir():
            handles.append(os.add_dll_directory(str(directory)))
    cublas = next((directory / "cublas64_12.dll" for directory in dll_dirs if (directory / "cublas64_12.dll").exists()), None)
    if cublas:
        ctypes.WinDLL(str(cublas))
    return handles


class TranscriptionError(RuntimeError):
    pass


class Transcriber:
    def __init__(self, model_name: str = "small", device: str | None = None, compute_type: str | None = None):
        self.model_name = model_name
        self.device = device or os.getenv("BILI_TRANSCRIBER_DEVICE", "cuda")
        self.compute_type = compute_type or os.getenv("BILI_TRANSCRIBER_COMPUTE_TYPE", "float16")
        self.beam_size = int(os.getenv("BILI_TRANSCRIBER_BEAM_SIZE", "1"))
        self.cpu_threads = int(os.getenv("BILI_TRANSCRIBER_CPU_THREADS", "0"))
        self.num_workers = int(os.getenv("BILI_TRANSCRIBER_NUM_WORKERS", "1"))
        self.device_index = int(os.getenv("BILI_TRANSCRIBER_DEVICE_INDEX", "0"))
        self._model = None
        self._cuda_dll_handles = []
        if self.device == "cuda":
            self._cuda_dll_handles = _configure_cuda_dlls()

    def _load_model(self):
        if self._model is None:
            from faster_whisper import WhisperModel
            model_options = {
                "device": self.device,
                "device_index": self.device_index,
                "compute_type": self.compute_type,
                "num_workers": self.num_workers,
            }
            if self.cpu_threads:
                model_options["cpu_threads"] = self.cpu_threads
            self._model = WhisperModel(self.model_name, **model_options)
        return self._model

    async def run(self, source: Path, wav_path: Path, language: str = "zh", progress=None) -> list[dict]:
        await asyncio.to_thread(self._convert, source, wav_path)
        model = await asyncio.to_thread(self._load_model)
        updates = queue.Queue()
        worker = asyncio.create_task(asyncio.to_thread(self._transcribe, model, wav_path, language, updates))
        while not worker.done():
            try:
                seconds = updates.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.1)
            else:
                if progress:
                    await progress(seconds)
        result = await worker
        while True:
            try:
                seconds = updates.get_nowait()
            except queue.Empty:
                break
            if progress:
                await progress(seconds)
        return result

    def _transcribe(self, model, wav_path: Path, language: str, updates: queue.Queue) -> list[dict]:
        segments, _info = model.transcribe(
            str(wav_path),
            language=language or None,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
            beam_size=self.beam_size,
        )
        result = []
        for segment in segments:
            text = " ".join(segment.text.split())
            if text and segment.end > segment.start:
                result.append({"start": round(float(segment.start), 3), "end": round(float(segment.end), 3), "text": text})
            updates.put(float(segment.end))
        return result


    @staticmethod
    def _convert(source: Path, target: Path) -> None:
        command = ["ffmpeg", "-y", "-i", str(source), "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "wav", str(target)]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=600)
        if completed.returncode:
            raise TranscriptionError(f"FFmpeg 转码失败：{completed.stderr[-500:]}")
