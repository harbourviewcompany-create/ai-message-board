"""Thin clients for the three model providers."""

from __future__ import annotations

import os
from typing import List, Dict, Any

from openai import OpenAI
from anthropic import Anthropic


def _get_env(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


class GrokClient:
    """xAI Grok via the OpenAI-compatible endpoint."""

    def __init__(self):
        self.client = OpenAI(
            api_key=_get_env("XAI_API_KEY"),
            base_url="https://api.x.ai/v1",
        )
        self.model = os.getenv("GROK_MODEL", "grok-4")

    def chat(self, messages: List[Dict[str, str]], system: str | None = None) -> str:
        full_messages = []
        if system:
            full_messages.append({"role": "system", "content": system})
        full_messages.extend(messages)

        response = self.client.chat.completions.create(
            model=self.model,
            messages=full_messages,
            temperature=0.7,
        )
        return response.choices[0].message.content or ""


class OpenAIClient:
    def __init__(self):
        self.client = OpenAI(api_key=_get_env("OPENAI_API_KEY"))
        self.model = os.getenv("OPENAI_MODEL", "gpt-4o")

    def chat(self, messages: List[Dict[str, str]], system: str | None = None) -> str:
        full_messages = []
        if system:
            full_messages.append({"role": "system", "content": system})
        full_messages.extend(messages)

        response = self.client.chat.completions.create(
            model=self.model,
            messages=full_messages,
            temperature=0.7,
        )
        return response.choices[0].message.content or ""


class ClaudeClient:
    def __init__(self):
        self.client = Anthropic(api_key=_get_env("ANTHROPIC_API_KEY"))
        self.model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")

    def chat(self, messages: List[Dict[str, str]], system: str | None = None) -> str:
        # Anthropic expects system as a separate parameter
        response = self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            system=system or "",
            messages=messages,
            temperature=0.7,
        )
        # content is a list of content blocks
        parts = [block.text for block in response.content if hasattr(block, "text")]
        return "".join(parts)


def get_client(sender: str):
    if sender == "grok":
        return GrokClient()
    if sender == "gpt":
        return OpenAIClient()
    if sender == "claude":
        return ClaudeClient()
    raise ValueError(f"Unknown sender: {sender}")
