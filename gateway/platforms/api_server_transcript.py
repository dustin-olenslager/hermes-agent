"""Transcript payload shaping: the list-row projection and the gzip that carries a page.

A list row is a preview of a message, not the message. This module owns three decisions the
``/api/sessions/{id}/messages`` caller sees: which fields a row may carry, what a caller is
allowed to drop or cap, and whether a page is compressed on the wire.

It sits beside the facade rather than inside it because every shaping knob added there grows a
file that is already past its line cap; the rules belong to one topic and are testable without
an adapter instance.

Compaction scaffolding stays invisible: a standalone handoff becomes a hidden empty row with a
stable id, a merged handoff keeps only the real prior-tail content, inherited tool calls are
dropped (``agent.compaction_display`` owns those rules). Compression is decided from headers
alone — only a buffered text/JSON body the caller asked for, never media, an archive, an
already-encoded body or a server-sent stream.
"""

from __future__ import annotations

import gzip
from typing import Any, Optional

_SAFE_LIST_ROW_KEYS = (
    "id", "session_id", "role", "content", "tool_call_id", "tool_calls", "tool_name",
    "timestamp", "token_count", "finish_reason", "reasoning", "reasoning_content",
    "display_kind")
_CAPPABLE_FIELDS = ("content", "tool_calls", "reasoning", "reasoning_content")

# Below this size the gzip framing and the header churn cost more than the payload they save.
GZIP_MIN_BYTES = 1024
_GZIP_SKIP_TYPES = ("application/zip", "application/gzip", "application/octet-stream")
_GZIP_SKIP_PREFIXES = ("image/", "audio/", "video/", "font/")
_GZIP_LEVEL = 6


def project_client_message(message: dict[str, Any]) -> dict[str, Any]:
    """Strip compaction scaffolding: standalone handoffs become hidden empty rows (stable
    ids), merged handoffs keep only the real prior-tail content; inherited tool calls dropped."""
    from agent.compaction_display import (
        _COMPACTION_INTERNAL_FIELDS, project_compaction_message_for_display)
    if (message.get("display_kind") == "hidden"
            and (message.get("display_metadata") or {}).get("notification_category") == "diagnostic"):
        # Retain row identity and execution evidence in storage, not in the notification UI.
        return {k: v for k, v in message.items() if k in {
            "id", "session_id", "role", "timestamp", "display_kind", "platform_message_id",
        }} | {"content": ""}
    projected = project_compaction_message_for_display(message)
    if projected is None:
        projected = {k: v for k, v in message.items() if k not in _COMPACTION_INTERNAL_FIELDS}
        projected["content"] = ""
        projected["display_kind"] = "hidden"
    return projected


def cap_message_fields(message: dict[str, Any], limit: int) -> dict[str, Any]:
    """Cap the long text fields of a list row and name what was cut, so a caller never has to
    guess whether it is holding the whole value. The cap is a guardrail against one pathological
    message, not the page-size lever (a page is many messages, not one giant)."""
    truncated: list[str] = []
    for key in _CAPPABLE_FIELDS:
        value = message.get(key)
        if isinstance(value, str) and len(value) > limit:
            omitted = len(value) - limit
            message[key] = f"{value[:limit]}\n[truncated: {omitted} characters omitted]"
            truncated.append(key)
    if truncated:
        message["truncated_fields"] = truncated
    return message


def message_response(
        message: dict[str, Any], *, include_reasoning: bool = True,
        max_content_chars: int = 0) -> dict[str, Any]:
    """One list row. ``include_reasoning=False`` drops the model's private reasoning, which is
    the bulk of a page and is not renderable in a transcript; ``max_content_chars`` caps the long
    text fields and names them in ``truncated_fields``. Both defaults keep the historical shape."""
    message = project_client_message(message)
    projected = {key: message.get(key) for key in _SAFE_LIST_ROW_KEYS if key in message}
    if not include_reasoning:
        projected.pop("reasoning", None)
        projected.pop("reasoning_content", None)
    if max_content_chars > 0:
        projected = cap_message_fields(projected, max_content_chars)
    return projected


def accepts_gzip(header_value: Optional[str]) -> bool:
    """True when the client advertises gzip (or ``*``) with a non-zero quality."""
    if not header_value:
        return False
    for part in header_value.split(","):
        name, _, params = part.partition(";")
        if name.strip().lower() not in ("gzip", "*"):
            continue
        quality = 1.0
        for param in params.split(";"):
            key, _, value = param.partition("=")
            if key.strip().lower() == "q":
                try:
                    quality = float(value.strip())
                except ValueError:
                    quality = 0.0
        if quality > 0:
            return True
    return False


def allows_gzip_type(content_type: str) -> bool:
    """Compress text/JSON only: media, archives and opaque bytes pass through."""
    value = (content_type or "").split(";", 1)[0].strip().lower()
    if not value:
        return False
    if value.startswith(_GZIP_SKIP_PREFIXES):
        return False
    # A server-sent stream must never be buffered through a compressor, even if a future
    # streaming path hands this middleware a body.
    if value == "text/event-stream":
        return False
    return value not in _GZIP_SKIP_TYPES


def compress_body(body: bytes) -> bytes:
    return gzip.compress(body, compresslevel=_GZIP_LEVEL)


def make_gzip_middleware(web):
    """Build the aiohttp gzip middleware. Takes the ``web`` module so this file imports no server
    library and its decisions stay testable as plain functions."""
    @web.middleware
    async def gzip_middleware(request, handler):
        """gzip a fully-buffered text/JSON body when the caller asked for it.

        A transcript page is multi-megabyte JSON; uncompressed it is the whole cost of a phone
        paging a long conversation, and the slow link starves the same client's chat socket.
        Streaming (SSE) responses have no body here and pass through untouched, as do media,
        already-encoded bodies and anything under ``GZIP_MIN_BYTES``. Any failure to compress
        returns the original response.
        """
        response = await handler(request)
        body = getattr(response, "body", None)
        if not body or len(body) < GZIP_MIN_BYTES:
            return response
        if response.headers.get("Content-Encoding"):
            return response
        if not allows_gzip_type(response.content_type or ""):
            return response
        if not accepts_gzip(request.headers.get("Accept-Encoding", "")):
            return response
        if response.headers.get("Cache-Control") == "no-transform":
            return response
        compressed = compress_body(body)
        if len(compressed) >= len(body):
            return response
        response.body = compressed
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Vary"] = ", ".join(
            v for v in (response.headers.get("Vary"), "Accept-Encoding") if v)
        return response

    return gzip_middleware
