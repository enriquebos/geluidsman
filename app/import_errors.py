from __future__ import annotations


def download_error(message: str) -> str:
    message = message.casefold()
    reasons = (
        (
            ("confirm you're not a bot", "confirm you\u2019re not a bot"),
            (
                "YouTube blocked this download with a bot verification challenge. "
                "Wait before retrying or use another source."
            ),
        ),
        (
            ("private video", "members-only", "sign in", "login required", "age-restricted"),
            "This video requires sign-in or restricted access. Import a publicly accessible video.",
        ),
        (
            ("video unavailable", "removed", "not available", "copyright"),
            "This video is unavailable, removed, or restricted in this region.",
        ),
        (("429", "too many requests"), "The source is rate-limiting downloads. Wait before retrying."),
        (("403", "forbidden"), "The source refused the download (HTTP 403). Retry later or use another source."),
        (
            ("timed out", "timeout", "connection", "resolve"),
            "The source could not be reached. Check the network and retry.",
        ),
        (("requested format", "no video formats"), "No supported video/audio format is available for this source."),
    )
    for patterns, reason in reasons:
        if any(pattern in message for pattern in patterns):
            return reason
    return (
        "The downloader could not retrieve this source. Its exact cause was not available. "
        "Try opening the source and retrying later."
    )


def import_guidance(error: str) -> str:
    message = error.casefold()
    if "duration" in message or "length" in message:
        return (
            "Check the video's duration and the maximum video length on the Admin page. "
            "Videos with unknown duration cannot be imported."
        )
    if "storage" in message or "size limit" in message:
        return "Free media storage or increase the import/storage limit on the Admin page, then retry."
    if "interrupted" in message:
        return "The app stopped before this import finished. Retry to download it again."
    if "known duration within" in message or "may be unavailable" in message:
        return (
            "This older failure has no more detailed downloader diagnosis. "
            "Retry to record a new result, or check the source in your browser."
        )
    return (
        "Check the source URL in your browser. Retry if the problem is temporary; "
        "use another source if it remains unavailable."
    )
