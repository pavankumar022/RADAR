"""
RADAR — Alerts Router
WebSocket /ws/alerts — pushes live security events to all dashboard clients.
GET /api/alerts/latest — REST fallback if WebSocket is unavailable.
GET /api/alerts/stats — current aggregate statistics.
"""
import asyncio
import logging
import time
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query, HTTPException

from backend import database as db
from backend.models import TriageRequest
from backend.services.ws_manager import manager

log = logging.getLogger(__name__)
router = APIRouter()

# Shared alert counter (in-process; resets on restart)
_alert_counter: int = 0
_last_stats_broadcast = 0.0
_STATS_INTERVAL = 5.0   # broadcast stats every 5 seconds


@router.websocket("/ws/alerts")
async def websocket_alerts(websocket: WebSocket):
    """
    Main real-time alert WebSocket endpoint.
    On connect: sends current status + last 20 events immediately.
    Then receives live broadcasts from the event loop.
    """
    await manager.connect(websocket)
    try:
        # Send connection ack + recent history
        await _send_status(websocket)
        await _send_recent_events(websocket, limit=20)

        # Keep connection alive; actual events are pushed by the generator loop
        while True:
            try:
                # Receive with timeout — handles ping/pong and client disconnects
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
                # Handle client-side ping
                if msg == "ping":
                    await websocket.send_text('{"type":"pong"}')
            except asyncio.TimeoutError:
                # Send keepalive ping
                await websocket.send_text('{"type":"ping"}')
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.debug(f"WS error: {e}")
    finally:
        await manager.disconnect(websocket)


async def _send_status(ws: WebSocket) -> None:
    from backend.state import app_state
    await ws.send_json({
        "type": "status",
        "payload": {
            "feed_state": app_state.feed_state,
            "monitoring_active": app_state.monitoring_active,
            "input_mode": app_state.input_mode,
            "uptime_seconds": time.monotonic() - app_state.start_time,
            "ws_clients": manager.count,
        },
    })


async def _send_recent_events(ws: WebSocket, limit: int = 20) -> None:
    events, _ = await db.get_events_paginated(page=1, page_size=limit)
    for ev in reversed(events):  # oldest first
        await ws.send_json({
            "type": "alert",
            "payload": {"event": ev, "alert_id": ev.get("id")},
        })


@router.get("/api/alerts/latest")
async def get_latest_alerts(limit: int = Query(20, ge=1, le=100)):
    """REST fallback — returns most recent N events."""
    events, _ = await db.get_events_paginated(page=1, page_size=limit)
    return {"events": events, "count": len(events)}


@router.get("/api/alerts/stats")
async def get_stats():
    """Live aggregate stats for stat cards."""
    return await db.get_stats()


@router.patch("/api/alerts/{alert_id}/triage")
async def triage_alert(alert_id: str, request: TriageRequest):
    """
    Analyst triage action: sets an alert's disposition (New / Investigating /
    True Positive / False Positive / Benign / Resolved) with an optional note.
    On first transition into a terminal status, the backend stamps
    triaged_at and computes resolution_seconds (real MTTR, not an estimate).
    Broadcasts the update to all connected dashboards.
    """
    try:
        updated = await db.triage_event(alert_id, request.status, request.notes)
    except ValueError as e:
        raise HTTPException(400, str(e))

    if not updated:
        raise HTTPException(404, f"Alert {alert_id} not found")

    # Push to every connected client so the live feed / incident view / stats
    # all reflect the disposition immediately, without a page refresh.
    await manager.broadcast({
        "type": "alert_update",
        "payload": {"event": updated, "alert_id": updated.get("id")},
    })
    stats = await db.get_stats()
    await manager.broadcast({"type": "stats", "payload": stats})

    return updated


# ─── Broadcast helpers (called by the main event loop) ────────────────────────

async def broadcast_event(event: dict) -> None:
    """Called by event_generator and replay_engine to push to all WS clients."""
    global _alert_counter, _last_stats_broadcast
    _alert_counter += 1

    await manager.broadcast({
        "type": "alert",
        "payload": {"event": event, "alert_id": event.get("id")},
    })

    # Periodically broadcast stats update
    now = time.monotonic()
    if now - _last_stats_broadcast >= _STATS_INTERVAL:
        _last_stats_broadcast = now
        stats = await db.get_stats()
        await manager.broadcast({"type": "stats", "payload": stats})

        # Also broadcast status
        from backend.state import app_state
        await manager.broadcast({
            "type": "status",
            "payload": {
                "feed_state": app_state.feed_state,
                "monitoring_active": app_state.monitoring_active,
                "input_mode": app_state.input_mode,
                "uptime_seconds": time.monotonic() - app_state.start_time,
                "ws_clients": manager.count,
            },
        })
