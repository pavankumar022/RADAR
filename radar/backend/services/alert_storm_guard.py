"""
RADAR — Alert Storm Guard
=========================
Implements the 5 SOC alert-storm-avoidance strategies from the
"5 Ways to Avoid Alert Storms in a SOC" playbook, applied ONLY to the
FILE UPLOAD ingestion path (POST /api/logs/upload).

    1. Unify Threat Monitoring   -> tag related events with one correlation_id
    2. Fine-Tune Detection Rules -> drop events from IPs on the existing ip_whitelist
    3. Group Alerts Intelligently-> collapse near-identical duplicates into 1 incident
    4. Alert Hygiene             -> duplicates still archived, but not broadcast live
    5. Automate Repetitive Tasks -> grouping/suppression happens automatically, no manual triage

Deliberately isolated / self-contained:
- Does NOT touch live_capture.py, routers/live.py, the synthetic generator,
  /api/logs/target-ip, or /api/logs/stream.
- Pure function, no DB or network calls — safe to unit test, safe to fail
  closed (any error just returns the original batch untouched, see
  routers/logs.py's try/except around the call site).
"""
import logging
from collections import defaultdict
from datetime import datetime, timezone

log = logging.getLogger(__name__)

DEFAULT_DUPLICATE_THRESHOLD = 5  # >5 near-identical events from one source => group + archive the rest


def _pick(raw: dict, *keys: str) -> str:
    for k in keys:
        v = raw.get(k)
        if v not in (None, ""):
            return str(v).strip().lower()
    return ""


def _signature(raw: dict) -> tuple:
    """Grouping key for near-duplicate detection: same source + destination + event type."""
    src = _pick(raw, "source_ip", "src_ip", "src", "client_ip", "remote_addr", "attacker_ip", "source")
    dst = _pick(raw, "destination_ip", "dst_ip", "dst", "target", "host", "target_ip", "destination")
    etype = _pick(raw, "event_type", "type", "action", "category", "signature", "event", "name")
    return (src, dst, etype)


def apply_storm_guard(
    raw_events: list[dict],
    ip_whitelist: list[str] | None = None,
    duplicate_threshold: int = DEFAULT_DUPLICATE_THRESHOLD,
) -> tuple[list[dict], list[dict], dict]:
    """
    Runs alert-storm mitigation over a batch of *raw* uploaded log dicts,
    BEFORE they are normalized/stored/broadcast by routers/logs.py.

    Returns:
        actionable    — raw dicts to fully process: normalize, store, AND broadcast live
                         (one representative per group, tagged with occurrence_count)
        archive_only  — raw dicts to store for the Log Archive / compliance trail,
                         but NOT broadcast to the live feed / 3D globe / WebSocket
        stats         — counters describing what the guard did, safe to show in the UI
    """
    ip_whitelist_set = {(ip or "").strip() for ip in (ip_whitelist or []) if ip}
    threshold = max(1, int(duplicate_threshold or DEFAULT_DUPLICATE_THRESHOLD))

    stats = {
        "total_received": len(raw_events),
        "whitelisted_dropped": 0,
        "duplicate_grouped": 0,
        "archived_duplicates": 0,
        "actionable_incidents": 0,
    }

    # ── Strategy 2: Fine-Tune Detection Rules — drop whitelisted sources outright ──
    filtered: list[dict] = []
    for raw in raw_events:
        if not isinstance(raw, dict):
            continue
        src = _pick(raw, "source_ip", "src_ip", "src", "client_ip", "remote_addr", "attacker_ip", "source")
        if src and src in ip_whitelist_set:
            stats["whitelisted_dropped"] += 1
            continue
        filtered.append(raw)

    # ── Strategy 3: Group Alerts Intelligently — collapse near-identical events ──
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for raw in filtered:
        groups[_signature(raw)].append(raw)

    actionable: list[dict] = []
    archive_only: list[dict] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for sig, members in groups.items():
        # ── Strategy 1: Unify Threat Monitoring — one correlation_id per related group ──
        correlation_id = f"corr-{abs(hash(sig)) % (10 ** 10)}"

        representative = dict(members[0])
        representative["correlation_id"] = correlation_id
        representative["occurrence_count"] = len(members)
        representative["storm_guard_grouped_at"] = now_iso

        if len(members) > threshold:
            # ── Strategy 5: Automate Repetitive Tasks — auto-triage the noisy remainder ──
            representative["storm_guard_note"] = (
                f"Auto-grouped: {len(members)} near-identical events from this source "
                f"collapsed into 1 incident (threshold={threshold})."
            )
            actionable.append(representative)
            stats["duplicate_grouped"] += len(members) - 1

            # ── Strategy 4: Alert Hygiene — extras kept for audit, kept off the live feed ──
            for extra in members[1:]:
                extra = dict(extra)
                extra["correlation_id"] = correlation_id
                extra["storm_guard_note"] = "Archived duplicate — suppressed from live feed to prevent alert storm."
                archive_only.append(extra)
        else:
            # Under threshold — no storm risk, pass everything through as normal, just correlated
            for m in members:
                m = dict(m)
                m["correlation_id"] = correlation_id
                actionable.append(m)

    stats["actionable_incidents"] = len(actionable)
    stats["archived_duplicates"] = len(archive_only)

    log.info(
        "Alert Storm Guard (upload): received=%d whitelisted=%d grouped_dupes=%d "
        "actionable=%d archived=%d",
        stats["total_received"], stats["whitelisted_dropped"], stats["duplicate_grouped"],
        stats["actionable_incidents"], stats["archived_duplicates"],
    )
    return actionable, archive_only, stats
