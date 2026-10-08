FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim AS dependencies
RUN --mount=type=cache,target=/root/.cache/pip pip install poetry
RUN python -m venv /opt/venv
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /build
COPY pyproject.toml poetry.lock ./
RUN --mount=type=cache,target=/root/.cache/pypoetry poetry install --only main --no-interaction

FROM python:3.12-slim AS app
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libopus0 && useradd --uid 1000 --create-home app
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY --from=dependencies /opt/venv /opt/venv
COPY app/ ./app/
COPY --from=frontend /build/dist ./frontend/dist
USER app
EXPOSE 8687
CMD ["python", "-m", "app"]

FROM app AS test
USER root
RUN --mount=type=cache,target=/root/.cache/pip pip install pytest==9.1.1 httpx==0.28.1 ruff==0.16.10
COPY tests/ ./tests/
USER app
CMD ["pytest", "-o", "cache_dir=/tmp/pytest-cache"]

FROM dependencies AS transcription-dependencies
RUN --mount=type=cache,target=/root/.cache/pypoetry poetry install --only main,worker,gpu --no-interaction

FROM app AS transcription
USER root
COPY --from=transcription-dependencies /opt/venv /opt/venv
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && mkdir /models && chown app:app /models
ENV LD_LIBRARY_PATH="/opt/venv/lib/python3.12/site-packages/nvidia/cublas/lib:/opt/venv/lib/python3.12/site-packages/nvidia/cudnn/lib"
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility
USER app
CMD ["python", "-m", "app.transcription_worker"]
