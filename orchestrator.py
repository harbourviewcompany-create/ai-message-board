#!/usr/bin/env python3
"""
AI Message Board Orchestrator

Watches the Supabase messages table and decides which model
(Grok / Claude / GPT) should reply next. Writes the reply back
to the same board so the conversation can continue.

Usage:
  1. Fill .env from .env.example
  2. Run schema.sql in your Supabase project
  3. python orchestrator.py
"""

from __future__ import annotations

import os
import time
import uuid
from pathlib import Path
from typing import List, Dict, Any, Optional

from dotenv import load_dotenv
from supabase import create_client, Client

from clients import get_client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
POLL_INTERVAL = float(os.getenv("POLL_INTERVAL_SECONDS", "3"))
MAX_HISTORY = int(os.getenv("MAX_HISTORY_MESSAGES", "20"))
DEFAULT_TITLE = os.getenv("DEFAULT_THREAD_TITLE", "AI Collaboration Board")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise SystemExit("Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env")

sb: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

PROMPTS_DIR = Path(__file__).parent / "prompts"


def load_system_prompt(sender: str) -> str:
    mapping = {
        "grok": "system_grok.md",
        "claude": "system_claude.md",
        "gpt": "system_gpt.md",
    }
    path = PROMPTS_DIR / mapping[sender]
    return path.read_text(encoding="utf-8").strip()


def get_or_create_default_thread() -> str:
    """Return the id of the most recent thread, or create one."""
    result = (
        sb.table("threads")
        .select("id")
        .order("updated_at", desc=True)
        .limit(1)
        .execute()
    )
    if result.data:
        return result.data[0]["id"]

    # Create a fresh thread
    new_id = str(uuid.uuid4())
    sb.table("threads").insert(
        {"id": new_id, "title": DEFAULT_TITLE}
    ).execute()
    print(f"Created new thread: {new_id}")
    return new_id


def fetch_recent_messages(thread_id: str, limit: int = MAX_HISTORY) -> List[Dict[str, Any]]:
    result = (
        sb.table("messages")
        .select("*")
        .eq("thread_id", thread_id)
        .order("created_at", desc=False)
        .limit(limit)
        .execute()
    )
    return result.data or []


def post_message(thread_id: str, sender: str, content: str, metadata: Optional[Dict] = None) -> None:
    sb.table("messages").insert(
        {
            "thread_id": thread_id,
            "sender": sender,
            "content": content,
            "metadata": metadata or {},
        }
    ).execute()
    print(f"[{sender.upper()}] posted ({len(content)} chars)")


def choose_next_speaker(messages: List[Dict[str, Any]]) -> Optional[str]:
    """
    Very simple round-robin + rules.
    Replace this with a smarter supervisor later if you want.
    """
    if not messages:
        return "grok"  # first voice

    last = messages[-1]
    last_sender = last["sender"]

    # If the last message was from a human or system, let Grok open
    if last_sender in ("human", "system"):
        return "grok"

    # Simple rotation: grok → claude → gpt → grok ...
    order = ["grok", "claude", "gpt"]
    try:
        idx = order.index(last_sender)
        return order[(idx + 1) % len(order)]
    except ValueError:
        return "claude"


def build_chat_messages(history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """Convert board messages into the chat format expected by the clients."""
    chat = []
    for m in history:
        role = "assistant" if m["sender"] in ("grok", "claude", "gpt") else "user"
        # Prefix so each model knows who said what
        prefix = f"[{m['sender'].upper()}] " if m["sender"] != "human" else ""
        chat.append({"role": role, "content": prefix + m["content"]})
    return chat


def run_once(thread_id: str) -> bool:
    """
    Check the board once. If a reply is needed, generate and post it.
    Returns True if a message was posted.
    """
    messages = fetch_recent_messages(thread_id)

    # Don't reply if the last message is already from an AI and we just started
    # (simple guard against immediate loops on startup)
    if not messages:
        return False

    next_speaker = choose_next_speaker(messages)
    if not next_speaker:
        return False

    # Avoid talking twice in a row
    if messages[-1]["sender"] == next_speaker:
        return False

    print(f"\n→ Next speaker: {next_speaker}")

    system = load_system_prompt(next_speaker)
    chat_history = build_chat_messages(messages)

    client = get_client(next_speaker)
    reply = client.chat(chat_history, system=system)

    if not reply.strip():
        print("Empty reply, skipping")
        return False

    post_message(
        thread_id=thread_id,
        sender=next_speaker,
        content=reply.strip(),
        metadata={"model": getattr(client, "model", "unknown")},
    )
    return True


def main():
    print("AI Message Board Orchestrator starting...")
    thread_id = get_or_create_default_thread()
    print(f"Watching thread: {thread_id}")
    print(f"Poll interval: {POLL_INTERVAL}s")
    print("Insert a message as sender='human' in the Supabase Table Editor to start the conversation.\n")

    while True:
        try:
            run_once(thread_id)
        except Exception as e:
            print(f"Error: {e}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
