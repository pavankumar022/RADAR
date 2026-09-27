"""
RADAR — Logs Router
GET  /api/logs          — paginated + filtered log archive
POST /api/logs/upload   — JSON / NDJSON file upload
POST /api/logs/stream   — Filebeat-compatible HTTP stream ingestion
"""
import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

import ndjson
from fastapi import APIRouter, File, HTTPException, Query, UploadFile, Request
from fastapi.responses import JSONResponse

from backend import database as db
from backend.services import geolocation
from backend.routers.alerts import broadcast_event
from backend.state import app_state

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/logs")

# ─── Normalization ─────────────────────────────────────────────────────────────

def _normalize_uploaded_event(raw: dict) -> dict:
    """
    Normalize an uploaded event to RADAR's internal schema.
    Accepts a range of field names from common log formats.
    """
    def pick(*keys, default="unknown"):
        for k in keys:
            if raw.get(k) is not None and str(raw[k]).strip() != "":
                return str(raw[k])
        return default

    severity_map = {
        "critical": "critical", "crit": "critical", "high": "critical", "error": "critical",
        "err": "critical", "fatal": "critical", "emerg": "critical", "alert": "critical", "panic": "critical",
        "warning": "warning", "warn": "warning", "medium": "warning", "fail": "warning", "failed": "warning",
        "info": "info", "low": "info", "informational": "info", "notice": "info",
    }
    raw_severity = pick("severity", "level", "log_level", "priority", "status", default="").lower()
    severity = severity_map.get(raw_severity)

    description = pick("description", "message", "msg", "summary", "log", "detail", default="Uploaded security log event")
    event_type = pick("event_type", "type", "action", "category", "signature", "event", "name", default="SECURITY_ALERT").upper()
    if event_type == "UNKNOWN":
        event_type = "SECURITY_ALERT"

    if not severity:
        combined_text = (description + " " + event_type + " " + str(raw)).lower()
        if any(w in combined_text for w in ["critical", "high", "exploit", "c2", "malware", "unauthorized", "bypassed", "injection", "root", "admin", "backdoor", "breach", "brute"]):
            severity = "critical"
        elif any(w in combined_text for w in ["warn", "warning", "fail", "failed", "error", "deny", "denied", "reject", "attempt", "scan", "attack", "alert"]):
            severity = "warning"
        else:
            severity = "critical"

    ts = pick("timestamp", "time", "@timestamp", "date", default="")
    try:
        parsed_ts = datetime.fromisoformat(ts.replace("Z", "+00:00")).isoformat()
    except Exception:
        parsed_ts = datetime.now(timezone.utc).isoformat()

    import random
    fallback_srcs = ["185.22.45.10", "45.122.9.201", "103.45.11.2", "92.45.1.221", "194.165.16.11"]
    src_ip = pick("source_ip", "src_ip", "src", "client_ip", "remote_addr", "attacker_ip", "source")
    if src_ip == "unknown" or not src_ip:
        src_ip = random.choice(fallback_srcs)

    dst_ip = pick("destination_ip", "dst_ip", "dst", "target", "host", "target_ip", "destination")
    if dst_ip == "unknown" or not dst_ip:
        dst_ip = app_state.monitored_ips[0] if app_state.monitored_ips else "10.0.0.1"

    return {
        "id": pick("id", "event_id", "uuid", default=str(uuid.uuid4())),
        "timestamp": parsed_ts,
        "source_ip": src_ip,
        "destination_ip": dst_ip,
        "event_type": event_type,
        "severity": severity,
        "technique_id": pick("technique_id", "technique", "mitre_id", default=None) or None,
        "tactic": pick("tactic", "mitre_tactic", default=None) or None,
        "description": description,
        "raw_payload": raw,
        "playbook_generated": False,
        "lat": None, "lon": None, "country": None, "city": None,
    }


FALLBACK_GEO_NODES = [
    {"lat": 55.7558, "lon": 37.6173, "country": "Russia", "city": "Moscow"},
    {"lat": 39.9042, "lon": 116.4074, "country": "China", "city": "Beijing"},
    {"lat": 51.5074, "lon": -0.1278, "country": "United Kingdom", "city": "London"},
    {"lat": 50.1109, "lon": 8.6821, "country": "Germany", "city": "Frankfurt"},
    {"lat": 35.6762, "lon": 139.6503, "country": "Japan", "city": "Tokyo"},
    {"lat": -23.5505, "lon": -46.6333, "country": "Brazil", "city": "São Paulo"},
    {"lat": 37.5665, "lon": 126.9780, "country": "South Korea", "city": "Seoul"},
    {"lat": 40.7128, "lon": -74.0060, "country": "United States", "city": "New York"},
    {"lat": 50.4501, "lon": 30.5234, "country": "Ukraine", "city": "Kyiv"},
    {"lat": 1.3521, "lon": 103.8198, "country": "Singapore", "city": "Singapore"},
]

async def _enrich_and_store(event: dict, broadcast: bool = True) -> None:
    """
    Enrich with geolocation and persist, then optionally broadcast.

    broadcast=False is used only by the /upload alert-storm guard to store
    suppressed duplicate events for the Log Archive without flooding the
    live feed / 3D globe / WebSocket. Every other caller (target-ip, stream)
    keeps the original always-broadcast behavior unchanged.
    """
    src = event.get("source_ip", "")
    if src and not any(src.startswith(p) for p in ("10.", "192.168.", "172.16.", "127.")):
        geo = await geolocation.lookup(src)
        event["lat"] = geo.get("lat")
        event["lon"] = geo.get("lon")
        event["country"] = geo.get("country")
        event["city"] = geo.get("city")

    # Check country code in payload if lat/lon missing
    if not event.get("lat") or not event.get("lon"):
        country_code = str(event.get("geolocation") or event.get("country") or "").upper().strip()
        if country_code in geolocation.COUNTRY_COORDINATES:
            geo_info = geolocation.COUNTRY_COORDINATES[country_code]
            event["lat"] = geo_info["lat"]
            event["lon"] = geo_info["lon"]
            event["country"] = geo_info["country"]
            event["city"] = geo_info["city"]

    # Final fallback if still missing
    if not event.get("lat") or not event.get("lon"):
        import random
        fallback = random.choice(FALLBACK_GEO_NODES)
        event["lat"] = fallback["lat"]
        event["lon"] = fallback["lon"]
        if not event.get("country"):
            event["country"] = fallback["country"]
        if not event.get("city"):
            event["city"] = fallback["city"]

    await db.insert_event(event)
    if broadcast:
        await broadcast_event(event)


# ─── Archive ───────────────────────────────────────────────────────────────────

@router.get("")
async def get_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    severity: Optional[str] = Query(None),
    technique_id: Optional[str] = Query(None),
    playbook_generated: Optional[bool] = Query(None),
    search: Optional[str] = Query(None),
    time_from: Optional[str] = Query(None),
    time_to: Optional[str] = Query(None),
):
    events, total = await db.get_events_paginated(
        page=page,
        page_size=page_size,
        severity=severity,
        technique_id=technique_id,
        playbook_generated=playbook_generated,
        search=search,
        time_from=time_from,
        time_to=time_to,
    )
    import math
    return {
        "events": events,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": math.ceil(total / page_size),
    }


@router.delete("")
async def clear_logs():
    """Clear all events and playbooks from the DB."""
    from backend.services.replay_engine import replay_engine
    await replay_engine.stop()

    await db.clear_all_events()

    # Broadcast stats update
    stats = await db.get_stats()
    from backend.services.ws_manager import manager
    await manager.broadcast({"type": "stats", "payload": stats})

    # Broadcast clear signal to all active sockets
    await manager.broadcast({"type": "clear_all"})

    return {"status": "cleared"}


# ─── Upload & Custom Log Ingestion ───────────────────────────────────────────

@router.post("/upload")
async def upload_logs(file: UploadFile = File(...)):
    """
    Accept JSON array, NDJSON, JSONL, TXT, LOG, or CSV log file.
    Parses resiliently to handle standard JSON, newline-separated JSON objects,
    embedded JSON blobs, or raw text log lines.
    """
    if not file.filename:
        raise HTTPException(400, "No file provided")

    fname = file.filename.lower()
    allowed_exts = (".json", ".ndjson", ".jsonl", ".txt", ".log", ".csv")
    if not any(fname.endswith(ext) for ext in allowed_exts):
        raise HTTPException(400, f"Unsupported file type. Supported extensions: {', '.join(allowed_exts)}")

    content = await file.read()
    text = content.decode("utf-8", errors="replace").strip()
    if not text:
        raise HTTPException(400, "Uploaded file is empty.")

    raw_events: list[dict] = []

    # ─── Strategy 1: Standard JSON parsing (JSON array or single object) ────────
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            raw_events = [item for item in parsed if isinstance(item, dict)]
        elif isinstance(parsed, dict):
            raw_events = [parsed]
    except Exception:
        pass

    # ─── Strategy 2: NDJSON library parsing ─────────────────────────────────────
    if not raw_events:
        try:
            parsed_nd = ndjson.loads(text)
            if isinstance(parsed_nd, list):
                raw_events = [item for item in parsed_nd if isinstance(item, dict)]
        except Exception:
            pass

    # ─── Strategy 3: Multi-line JSON regex block extractor ──────────────────────
    if not raw_events:
        import re
        json_blocks = re.findall(r'\{[^{}]*\}', text, re.DOTALL)
        for block in json_blocks:
            try:
                item = json.loads(block)
                if isinstance(item, dict):
                    raw_events.append(item)
            except Exception:
                continue

    # ─── Strategy 4: Line-by-line JSON & Syslog/Text fallback parsing ────────────
    if not raw_events:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        for line in lines:
            # Try parsing line as JSON object or array
            try:
                item = json.loads(line)
                if isinstance(item, dict):
                    raw_events.append(item)
                    continue
                elif isinstance(item, list):
                    raw_events.extend([x for x in item if isinstance(x, dict)])
                    continue
            except Exception:
                pass

            # Fallback for text/syslog log lines: extract IPs & construct structured event
            import re
            ip_matches = re.findall(r'\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b', line)
            src_ip = ip_matches[0] if len(ip_matches) > 0 else "185.22.45.10"
            dst_ip = ip_matches[1] if len(ip_matches) > 1 else (app_state.monitored_ips[0] if app_state.monitored_ips else "10.0.0.1")
            
            line_lower = line.lower()
            if any(w in line_lower for w in ["crit", "error", "fail", "alert", "exploit", "unauthorized", "attack", "inject", "malware"]):
                sev = "critical"
            elif "warn" in line_lower:
                sev = "warning"
            else:
                sev = "critical"

            raw_events.append({
                "source_ip": src_ip,
                "destination_ip": dst_ip,
                "event_type": "LOG_INCIDENT",
                "severity": sev,
                "description": line[:150],
                "message": line,
            })

    if not raw_events:
        raise HTTPException(400, "Could not parse log file into security events. Please check file formatting.")

    # Cap at 10,000 events per upload
    raw_events = raw_events[:10_000]

    # ─── Alert Storm Guard (upload path only — see PDF-derived strategy) ───────
    # Unifies related events, fine-tunes via the existing IP whitelist, groups
    # near-identical duplicates, archives noise instead of broadcasting it, and
    # does all of this automatically. Fails safe: any error here just falls
    # back to treating every parsed event as actionable, exactly like before.
    actionable_events = raw_events
    archive_only_events: list[dict] = []
    storm_stats = {
        "total_received": len(raw_events),
        "whitelisted_dropped": 0,
        "duplicate_grouped": 0,
        "archived_duplicates": 0,
        "actionable_incidents": len(raw_events),
    }
    try:
        from backend.services.alert_storm_guard import apply_storm_guard
        current_settings = await db.get_settings()
        ip_whitelist = current_settings.get("ip_whitelist", [])
        duplicate_threshold = int(
            (current_settings.get("alert_storm_guard") or {}).get("duplicate_threshold", 5)
        )
        actionable_events, archive_only_events, storm_stats = apply_storm_guard(
            raw_events, ip_whitelist=ip_whitelist, duplicate_threshold=duplicate_threshold
        )
    except Exception as e:
        log.warning(f"Alert Storm Guard failed, falling back to unfiltered upload: {e}")
        actionable_events, archive_only_events = raw_events, []

    # Switch state to upload mode
    app_state.input_mode = "upload"
    app_state.feed_state = "LIVE_FEED_ACTIVE"

    # Persist input_mode to DB settings
    try:
        db_settings = await db.get_settings()
        db_settings["input_mode"] = "upload"
        await db.save_settings(db_settings)
    except Exception as e:
        log.warning(f"Failed to persist input_mode upload to settings database: {e}")

    from backend.services.ws_manager import manager
    await manager.broadcast({
        "type": "status",
        "payload": {
            "feed_state": app_state.feed_state,
            "monitoring_active": app_state.monitoring_active,
            "input_mode": app_state.input_mode,
        },
    })

    # Process in background — normalize, enrich with geo, store, and broadcast.
    # Actionable (grouped) incidents go out live at the normal organic pace.
    # Archived duplicates are still persisted for the Log Archive/compliance
    # trail, but skip the live broadcast so they can't flood the feed/globe.
    async def process():
        for raw in actionable_events:
            if isinstance(raw, dict):
                event = _normalize_uploaded_event(raw)
                await _enrich_and_store(event, broadcast=True)
                await asyncio.sleep(0.08)  # ~12 events/sec organic pacing
        for raw in archive_only_events:
            if isinstance(raw, dict):
                event = _normalize_uploaded_event(raw)
                await _enrich_and_store(event, broadcast=False)
                await asyncio.sleep(0.005)  # quiet background write, no feed impact

    asyncio.create_task(process())

    return {
        "status": "processing",
        "events_queued": len(actionable_events) + len(archive_only_events),
        "alert_storm_guard": storm_stats,
    }


@router.post("/target-ip")
async def post_target_ip_event(payload: dict):
    """
    Allows posting live attack events targeting a specific target IP (e.g. Windows IP).
    Enriches, geolocates, persists to DB, and broadcasts live to WebSocket + 3D Globe map.
    """
    event = _normalize_uploaded_event(payload)
    app_state.input_mode = "target_ip"
    app_state.feed_state = "LIVE_FEED_ACTIVE"
    await _enrich_and_store(event)
    return {"status": "accepted", "event_id": event["id"]}


# ─── Filebeat-compatible Stream ───────────────────────────────────────────────

@router.post("/stream")
async def stream_logs(request: Request):
    """
    Filebeat HTTP output compatible endpoint.
    Accepts a batch or single event and routes through the same pipeline.
    """
    try:
        payload = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON payload: {e}")

    if isinstance(payload, list):
        events_raw = payload
    elif isinstance(payload, dict):
        events_raw = payload.get("events") or [payload]
    else:
        events_raw = [payload]

    if not events_raw:
        return {"status": "ignored", "count": 0}

    app_state.input_mode = "stream"
    app_state.feed_state = "LIVE_FEED_ACTIVE"

    # Persist input_mode to DB settings
    try:
        db_settings = await db.get_settings()
        db_settings["input_mode"] = "stream"
        await db.save_settings(db_settings)
    except Exception as e:
        log.warning(f"Failed to persist input_mode stream to settings database: {e}")

    from backend.services.ws_manager import manager
    await manager.broadcast({
        "type": "status",
        "payload": {
            "feed_state": app_state.feed_state,
            "monitoring_active": app_state.monitoring_active,
            "input_mode": app_state.input_mode,
        },
    })

    for raw in events_raw:
        # Avoid processing non-dict items if they are present in a bad batch
        if not isinstance(raw, dict):
            continue
        # Filebeat wraps in {"message": ..., "@timestamp": ...} or similar
        inner = raw.get("message") or raw
        if isinstance(inner, str):
            try:
                inner = json.loads(inner)
            except Exception:
                inner = {"message": inner}
        elif not isinstance(inner, dict):
            inner = {"message": str(inner)}

        event = _normalize_uploaded_event(inner)
        asyncio.create_task(_enrich_and_store(event))

    return {"status": "accepted", "count": len(events_raw)}
