"""MonitorStatus dataclass and push helper."""

import os
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Literal, Optional

from ..util.http import http_post

# The Rust server's internal HTTP listener port (single listener, not per-phone).
_SERVER_INTERNAL_PORT = int(os.environ.get('INTERNAL_PORT', '8081'))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class StepStatus:
    attempted: bool = False
    succeeded: bool = False
    attempted_at: Optional[str] = None
    succeeded_at: Optional[str] = None
    error: Optional[str] = None


@dataclass
class HealStatus:
    last_at: Optional[str] = None
    last_result: Optional[Literal["ok", "failed", "in_progress"]] = None
    count_today: int = 0
    last_error: Optional[str] = None


@dataclass
class MonitorStatus:
    phase: Literal["setup", "monitoring", "stopped"] = "setup"
    setup: dict[str, StepStatus] = field(default_factory=dict)
    health: dict[str, bool] = field(default_factory=dict)
    heals: dict[str, HealStatus] = field(default_factory=dict)
    loop_iteration: int = 0
    last_check_at: Optional[str] = None


def push_status(status: 'MonitorStatus', phone_id: str | None, internal_port: int = 0):
    """Push MonitorStatus to the Rust server via internal event channel.

    Uses the server's single internal HTTP listener (INTERNAL_PORT env,
    default 8081), NOT the per-phone internal_port from port allocation.
    """
    if not phone_id:
        return
    http_post(f'http://127.0.0.1:{_SERVER_INTERNAL_PORT}/phones/{phone_id}/api/internal/event', {
        'event': 'monitor_status',
        'data': {
            'phone_id': phone_id,
            'status': asdict(status),
        },
    })
