from argparse import ArgumentParser

import uvicorn

from app.config import get_settings
from app.main import create_app

if __name__ == "__main__":
    parser = ArgumentParser()
    parser.add_argument("--resume-channel", default=None)
    args = parser.parse_args()
    settings = get_settings()
    uvicorn.run(
        create_app(settings, resume_channel_id=args.resume_channel),
        host=settings.host,
        port=settings.port,
        workers=1,
        access_log=False,
    )
