# CrowdPilot stem separation job: Demucs htdemucs (MIT) on CPU, weights baked in.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir demucs==4.0.1 soundfile numpy scipy azure-storage-blob==12.24.0 azure-storage-queue==12.12.0
# bake the htdemucs weights into the image (no download at run time)
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs')"
WORKDIR /app
COPY job.py .
ENV OMP_NUM_THREADS=4
CMD ["python", "job.py"]
