"""
RADAR — Pydantic Models (Event Schemas)
Single source of truth for all data shapes flowing through the system.
"""
from __future__ import annotations
from datetime import datetime
from typing import Optional, Literal, List, Any
from pydantic import BaseModel, Field
import uuid


# ─── Severity / State Enums ───────────────────────────────────────────────────

SeverityLevel = Literal["critical", "warning", "info"]
TriageStatus = Literal["new", "investigating", "true_positive", "false_positive", "benign", "resolved"]
FeedState = Literal["LOADING_SYNTHETIC", "SYNTHETIC_FEED", "LIVE_FEED_ACTIVE", "SYSTEM_STANDBY"]
InputMode = Literal["synthetic", "upload", "stream"]
AIProvider = Literal["gemini", "claude", "mock"]
TileState = Literal["untested", "exploited", "mitigated"]
AgentLoopStage = Literal["SCAN", "ATTACK", "DETECT", "REMEDIATE", "RETEST", "IDLE"]


# ─── Core Event (normalized internal shape) ────────────────────────────────────

class SecurityEvent(BaseModel):
    """Normalized event — all sources (synthetic/upload/stream) converge here."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    source_ip: str
    destination_ip: Optional[str] = None
    event_type: str                        # e.g. BRUTE_FORCE, C2_BEACON, SQL_INJECT
    severity: SeverityLevel
    technique_id: Optional[str] = None    # MITRE ATT&CK technique, e.g. T1110
    tactic: Optional[str] = None          # e.g. Credential Access
    description: Optional[str] = None
    raw_payload: Optional[dict] = None
    playbook_generated: bool = False
    lat: Optional[float] = None
    lon: Optional[float] = None
    country: Optional[str] = None
    city: Optional[str] = None

    # ─── Triage / disposition (SOC analyst workflow) ──────────────────────────
    status: TriageStatus = "new"
    analyst_notes: Optional[str] = None
    triaged_at: Optional[datetime] = None
    resolution_seconds: Optional[float] = None


# ─── WebSocket Messages ────────────────────────────────────────────────────────

class WSMessage(BaseModel):
    """Envelope for all WebSocket messages pushed to clients."""
    type: Literal["alert", "alert_update", "status", "stats", "mitre_update", "loop_stage", "replay_tick"]
    payload: Any


class AlertPayload(BaseModel):
    event: SecurityEvent
    alert_id: int


class StatsPayload(BaseModel):
    total_alerts: int
    critical_count: int
    false_positive_count: int
    true_positive_count: int = 0
    new_count: int = 0
    investigating_count: int = 0
    avg_resolution_seconds: Optional[float] = None
    correlated_incidents: int
    events_per_sec: float


class TriageRequest(BaseModel):
    status: TriageStatus
    notes: Optional[str] = None


class MitreUpdatePayload(BaseModel):
    technique_id: str
    tactic: str
    state: TileState


class LoopStagePayload(BaseModel):
    stage: AgentLoopStage
    detail: Optional[str] = None


class StatusPayload(BaseModel):
    feed_state: FeedState
    monitoring_active: bool
    input_mode: InputMode
    uptime_seconds: float
    ws_clients: int


# ─── Log Archive ──────────────────────────────────────────────────────────────

class LogsQueryParams(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(50, ge=1, le=200)
    severity: Optional[SeverityLevel] = None
    technique_id: Optional[str] = None
    playbook_generated: Optional[bool] = None
    search: Optional[str] = None
    time_from: Optional[datetime] = None
    time_to: Optional[datetime] = None


class LogsResponse(BaseModel):
    events: List[SecurityEvent]
    total: int
    page: int
    page_size: int
    total_pages: int


# ─── Playbook ─────────────────────────────────────────────────────────────────

class PlaybookRequest(BaseModel):
    alert_id: str
    provider: Optional[AIProvider] = None   # override default if needed


class PlaybookStep(BaseModel):
    step: int
    action: str
    completed: bool = False


class Playbook(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    alert_id: str
    generated_at: datetime = Field(default_factory=datetime.utcnow)
    provider: AIProvider
    situation_summary: str
    likely_technique: str
    technique_id: Optional[str] = None
    containment_steps: List[str] = []
    remediation_commands: str = ""
    raw_response: Optional[str] = None


# ─── Settings ─────────────────────────────────────────────────────────────────

class DetectionThresholds(BaseModel):
    general_sensitivity: int = Field(74, ge=0, le=100)
    anomaly_detection: int = Field(88, ge=0, le=100)
    lateral_movement: int = Field(42, ge=0, le=100)


class SystemSettings(BaseModel):
    detection_thresholds: DetectionThresholds = Field(default_factory=DetectionThresholds)
    ip_whitelist: List[str] = Field(default_factory=list)
    monitored_ips: List[str] = Field(default_factory=list)
    synthetic_delay: float = Field(2.0, ge=0.5, le=10.0)
    input_mode: InputMode = "synthetic"
    ai_provider: AIProvider = "gemini"
    monitoring_active: bool = True


# ─── Replay ───────────────────────────────────────────────────────────────────

class ReplayStartRequest(BaseModel):
    speed_multiplier: float = Field(1.0, ge=0.5, le=500.0)
    incident_id: Optional[str] = None


class ReplayStatus(BaseModel):
    active: bool
    speed_multiplier: float
    current_index: int
    total_events: int
    elapsed_seconds: float
    buffer_percent: float
