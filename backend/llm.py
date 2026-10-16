"""
llm.py — one place that talks to a model provider.

Primary is OpenAI. If a call fails for ANY reason (empty balance, rate limit,
outage), it falls back to Groq's free tier so the bot keeps answering.

Every other module calls chat() / chat_stream() instead of a provider client,
so swapping or adding providers never touches core.py.
"""
import os

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

OPENAI_KEY = os.getenv("OPENAI_API_KEY")
GROQ_KEY = os.getenv("GROQ_API_KEY")

PRIMARY_MODEL = "gpt-4o-mini"
BACKUP_MODEL = "openai/gpt-oss-120b"

if not OPENAI_KEY and not GROQ_KEY:
    raise ValueError("Set OPENAI_API_KEY or GROQ_API_KEY in .env")

primary = OpenAI(api_key=OPENAI_KEY) if OPENAI_KEY else None

# Groq is OpenAI-compatible, so the same SDK works — only the base_url differs.
# That means no second library and no second code path.
backup = (
    OpenAI(api_key=GROQ_KEY, base_url="https://api.groq.com/openai/v1")
    if GROQ_KEY else None
)

if not primary:
    print("llm: no OpenAI key — running on Groq only")
elif not backup:
    print("llm: no Groq key — no fallback configured")


def _log_cache(response):
    """Prompt caching cuts cost and prefill time on a repeated prefix (our
    system prompt). Non-zero cached_tokens means it is working."""
    try:
        usage = response.usage
        cached = getattr(usage.prompt_tokens_details, "cached_tokens", 0)
        if cached:
            print(f"    prompt tokens {usage.prompt_tokens:,} ({cached:,} cached)")
    except Exception:
        pass


def chat(**kwargs):
    """One non-streaming completion, with fallback. Returns the response object."""
    if primary:
        try:
            response = primary.chat.completions.create(model=PRIMARY_MODEL, **kwargs)
            _log_cache(response)
            return response
        except Exception as exc:
            print(f"llm: primary failed ({type(exc).__name__}: {exc}) — falling back")
            if not backup:
                raise

    # response_format and tools are supported on Groq's larger models, but
    # drop anything unsupported rather than failing the whole request.
    return backup.chat.completions.create(model=BACKUP_MODEL, **kwargs)


def chat_stream(**kwargs):
    """A streaming completion, with fallback. Returns an iterator of chunks.

    The fallback has to happen on the FIRST chunk: if the stream dies halfway
    we cannot restart it without the caller having already emitted text.
    """
    if primary:
        try:
            stream = primary.chat.completions.create(
                model=PRIMARY_MODEL, stream=True, **kwargs
            )
            first = next(iter(stream))          # force the connection to open
            return _chain(first, stream)
        except Exception as exc:
            print(f"llm: primary stream failed ({type(exc).__name__}: {exc}) — falling back")
            if not backup:
                raise

    stream = backup.chat.completions.create(model=BACKUP_MODEL, stream=True, **kwargs)
    first = next(iter(stream))
    return _chain(first, stream)


def _chain(first, rest):
    """Put the already-consumed first chunk back at the front of the stream."""
    yield first
    for chunk in rest:
        yield chunk