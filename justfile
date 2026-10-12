[unix]
set shell := ["sh", "-eu", "-c"]

[windows]
set shell := ["cmd.exe", "/d", "/c"]

default:
    @just --list

start:
    {{ if os() == "macos" { "python3 tools/apple_worker.py start" } else { "" } }}
    docker compose up -d --wait

stop:
    docker compose stop app
    docker compose stop transcription db
    {{ if os() == "macos" { "python3 tools/apple_worker.py stop" } else { "" } }}

update:
    {{ if os() == "macos" { "python3 tools/apple_worker.py stop" } else { "" } }}
    {{ if os() == "macos" { "python3 tools/apple_worker.py start" } else { "" } }}
    docker compose up -d --build --wait

status:
    docker compose ps
    {{ if os() == "macos" { "python3 tools/apple_worker.py status" } else { "" } }}

logs:
    docker compose logs --tail 200 -f app

worker-logs:
    docker compose logs --tail 200 -f transcription

check:
    poetry check --lock
    poetry run ruff check app tests
    poetry run ruff format --check app tests

format:
    poetry run ruff format app tests

build:
    npm run build --prefix frontend

test-backend:
    docker compose build test
    docker compose run --rm test

test-browser:
    npm test --prefix frontend

test: test-backend test-browser

verify: check build test

[macos]
apple-install:
    POETRY_VIRTUALENVS_IN_PROJECT=true poetry -C workers/apple install

[macos]
apple-logs:
    tail -n 200 -f .runtime/apple-worker/worker.log
