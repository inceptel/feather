#!/usr/bin/env python3
"""Card image for a Super Feed publication, from whichever image provider this
box has credentials for.

usage: room-visual.py OUT.png "<prompt>"

Providers are tried in order until one returns an image; the last resort is a
rendered text card so a publication can always ship. Order comes from
ROOM_VISUAL_PROVIDERS (comma-separated, default "openrouter,google,openai").
Keys come from the environment or ~/keyvault.txt (KEY=value lines):

  openrouter  OPENROUTER_API_KEY   google/gemini image model via OpenRouter
  google      GOOGLE_API_KEY or GEMINI_API_KEY   Gemini API directly
  openai      OPENAI_API_KEY       gpt-image-1

Prints "<provider> <path>" on success. Never prints a key.
"""
import base64
import io
import os
import sys
import textwrap
from pathlib import Path

try:
    import httpx
    from PIL import Image, ImageDraw, ImageFont
except ImportError as error:
    print(f"room-visual: missing python package: {error}", file=sys.stderr)
    sys.exit(1)

TIMEOUT = float(os.environ.get("ROOM_VISUAL_TIMEOUT", "180"))
DEFAULT_ORDER = "openrouter,google,openai"
OPENROUTER_MODELS = ["google/gemini-3.1-flash-image-preview", "google/gemini-2.5-flash-image"]
GOOGLE_MODELS = ["gemini-3.1-flash-image-preview", "gemini-2.5-flash-image"]
OPENAI_MODELS = ["gpt-image-1-mini", "gpt-image-1"]


def read_key(*names):
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    vault = Path.home() / "keyvault.txt"
    if vault.exists():
        for line in vault.read_text().splitlines():
            for name in names:
                if line.startswith(f"{name}=") and line[len(name) + 1:].strip():
                    return line[len(name) + 1:].strip()
    return None


def decode_data_url(url):
    if url.startswith("data:"):
        return base64.b64decode(url.split(",", 1)[1])
    return httpx.get(url, timeout=TIMEOUT).content


def via_openrouter(prompt):
    key = read_key("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError("no OPENROUTER_API_KEY")
    errors = []
    for model in OPENROUTER_MODELS:
        response = httpx.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": model, "messages": [{"role": "user", "content": prompt}], "modalities": ["image", "text"]},
            timeout=TIMEOUT,
        )
        if response.status_code != 200:
            errors.append(f"{model}: HTTP {response.status_code} {' '.join(response.text.split())[:120]}")
            continue
        message = response.json().get("choices", [{}])[0].get("message", {})
        for image in message.get("images") or []:
            url = image.get("image_url", {}).get("url") or image.get("url")
            if url:
                return decode_data_url(url)
        errors.append(f"{model}: no image in response")
    raise RuntimeError("; ".join(errors))


def via_google(prompt):
    key = read_key("GOOGLE_API_KEY", "GEMINI_API_KEY")
    if not key:
        raise RuntimeError("no GOOGLE_API_KEY")
    errors = []
    for model in GOOGLE_MODELS:
        response = httpx.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            headers={"x-goog-api-key": key},
            json={"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]}},
            timeout=TIMEOUT,
        )
        if response.status_code != 200:
            errors.append(f"{model}: HTTP {response.status_code} {' '.join(response.text.split())[:120]}")
            continue
        for candidate in response.json().get("candidates") or []:
            for part in candidate.get("content", {}).get("parts") or []:
                data = part.get("inlineData") or part.get("inline_data")
                if data and data.get("data"):
                    return base64.b64decode(data["data"])
        errors.append(f"{model}: no image in response")
    raise RuntimeError("; ".join(errors))


def via_openai(prompt):
    key = read_key("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("no OPENAI_API_KEY")
    errors = []
    for model in OPENAI_MODELS:
        response = httpx.post(
            "https://api.openai.com/v1/images/generations",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": model, "prompt": prompt, "size": "1536x1024", "n": 1},
            timeout=TIMEOUT,
        )
        if response.status_code != 200:
            errors.append(f"{model}: HTTP {response.status_code} {' '.join(response.text.split())[:120]}")
            continue
        data = response.json().get("data") or []
        if data and data[0].get("b64_json"):
            return base64.b64decode(data[0]["b64_json"])
        if data and data[0].get("url"):
            return httpx.get(data[0]["url"], timeout=TIMEOUT).content
        errors.append(f"{model}: no image in response")
    raise RuntimeError("; ".join(errors))


PROVIDERS = {"openrouter": via_openrouter, "google": via_google, "openai": via_openai}


def text_card(out, prompt):
    W, H = 1200, 675
    img = Image.new("RGB", (W, H), (13, 17, 23))
    draw = ImageDraw.Draw(img)
    for y in range(H):
        shade = 13 + int(18 * y / H)
        draw.line([(0, y), (W, y)], fill=(shade, shade + 4, shade + 10))
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 40)
    except Exception:
        font = ImageFont.load_default()
    lines = textwrap.wrap(prompt, width=48)[:8]
    y = (H - len(lines) * 54) // 2
    for line in lines:
        w = draw.textlength(line, font=font)
        draw.text(((W - w) / 2, y), line, fill=(226, 231, 238), font=font)
        y += 54
    draw.rectangle([(40, 40), (W - 40, H - 40)], outline=(42, 52, 66), width=3)
    img.save(out, "PNG")


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    out, prompt = sys.argv[1], sys.argv[2]
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    order = [name.strip() for name in os.environ.get("ROOM_VISUAL_PROVIDERS", DEFAULT_ORDER).split(",") if name.strip()]
    reasons = []
    for name in order:
        provider = PROVIDERS.get(name)
        if not provider:
            reasons.append(f"{name}: unknown provider")
            continue
        try:
            raw = provider(prompt)
            image = Image.open(io.BytesIO(raw))
            image.load()
            image.convert("RGB").save(out, "PNG")  # providers return JPEG/WebP; the feed wants PNG
            print(f"{name} {out}")
            return
        except Exception as error:  # a provider failing is normal on boxes without its key
            reasons.append(f"{name}: {str(error)[:200]}")
    text_card(out, prompt)
    print(f"fallback {out} ({'; '.join(reasons)})")


if __name__ == "__main__":
    main()
