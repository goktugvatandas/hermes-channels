"""Turn Hermes image-generation output into stored member avatars.

The Hermes image cache is janitor-cleaned after ~24h, so generated avatars are
re-encoded as small self-contained data URLs and persisted in channels.db instead
of referencing the original file.
"""

from __future__ import annotations

import base64
import io
import mimetypes
from pathlib import Path
from urllib.request import urlopen

_MAX_SOURCE_BYTES = 25 * 1024 * 1024
_AVATAR_EDGE = 256
_FETCH_TIMEOUT_S = 60


def avatar_prompt(
    display_name: str,
    role: str = "",
    description: str = "",
    soul_excerpt: str = "",
) -> str:
    """A stable portrait brief derived from the agent's profile."""

    traits = "; ".join(
        part.strip()
        for part in (role, description, soul_excerpt)
        if part and part.strip()
    )
    identity = f"an AI teammate named {display_name.strip() or 'Agent'}"
    if traits:
        identity += f". Personality and role: {traits[:400]}"
    return (
        f"Square profile avatar portrait for {identity}. "
        "Minimal modern flat vector illustration with bold simple shapes, "
        "a friendly distinctive character, head and shoulders centered on a "
        "plain single-color background. No text, no letters, no watermark."
    )


def enhance_user_prompt(prompt: str) -> str:
    """Wrap a user's free-form idea in avatar framing the model needs.

    Deterministic on purpose: an LLM rewrite would add latency and cost to a
    call that is already slow, and the scaffold below is what makes results
    usable as avatars (square, centered, no text).
    """

    cleaned = " ".join(prompt.split())[:600].rstrip(".")
    return (
        f"Square profile avatar portrait: {cleaned}. "
        "Composed as a clean modern illustration with the subject centered in "
        "head-and-shoulders framing on a simple single-color background, bold "
        "shapes and harmonious colors. No text, no letters, no watermark."
    )


def user_avatar_prompt(display_name: str) -> str:
    """Default brief for the human user when no custom prompt is given."""

    name = display_name.strip() or "the user"
    return (
        f"Square profile avatar portrait for a person who goes by {name}. "
        "Friendly stylized modern illustration, head and shoulders centered "
        "on a plain single-color background, warm approachable expression. "
        "No text, no letters, no watermark."
    )


def load_image_bytes(image_ref: str) -> bytes:
    """Read generated image content from an absolute path or http(s) URL."""

    if image_ref.startswith(("http://", "https://")):
        with urlopen(image_ref, timeout=_FETCH_TIMEOUT_S) as response:  # noqa: S310
            data = response.read(_MAX_SOURCE_BYTES + 1)
    else:
        path = Path(image_ref)
        if not path.is_file():
            raise ValueError(f"generated image not found: {image_ref}")
        if path.stat().st_size > _MAX_SOURCE_BYTES:
            raise ValueError("generated image exceeds the 25 MB avatar limit")
        data = path.read_bytes()
    if len(data) > _MAX_SOURCE_BYTES:
        raise ValueError("generated image exceeds the 25 MB avatar limit")
    return data


def to_avatar_data_url(image_ref: str) -> str:
    """Downscale to a small square and encode as a data URL.

    Pillow ships with Hermes; if it is ever missing the original bytes are
    stored unscaled rather than failing the request.
    """

    data = load_image_bytes(image_ref)
    try:
        from PIL import Image
    except ImportError:
        mime = mimetypes.guess_type(image_ref)[0] or "image/png"
        return f"data:{mime};base64,{base64.b64encode(data).decode()}"

    with Image.open(io.BytesIO(data)) as image:
        image = image.convert("RGB")
        width, height = image.size
        edge = min(width, height)
        left = (width - edge) // 2
        top = (height - edge) // 2
        image = image.crop((left, top, left + edge, top + edge))
        if edge > _AVATAR_EDGE:
            image = image.resize((_AVATAR_EDGE, _AVATAR_EDGE), Image.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="WEBP", quality=85)
    return f"data:image/webp;base64,{base64.b64encode(buffer.getvalue()).decode()}"
