[unix]
set shell := ["sh", "-eu", "-c"]

[windows]
set shell := ["cmd.exe", "/d", "/c"]

default:
    @just --list

start:
    docker compose up -d --wait

stop:
    docker compose stop app
    docker compose stop transcription db

update:
    docker compose up -d --build --wait

status:
    docker compose ps

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
