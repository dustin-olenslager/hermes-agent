"""Terminal-history retention: one job's traffic can never erase another job's evidence.

The ledger used to keep the newest N terminal rows across the whole fleet (N = 1000). The fleet
writes thousands of rows a day, so a quiet job's last failure fell out of the table in under eight
hours and every "failures in 24 h / 7 d" question answered zero by construction - the row carrying
the answer had already been evicted by a five-minute watcher.

The replacement has two halves and these tests pin both: a time window for ordinary churn, and a
per-job floor that no other job's traffic can push out. The acceptance test is the burst one: a
high-frequency job must not remove a low-frequency job's last failure.
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta


def _point_ledger(monkeypatch, tmp_path):
    from cron import executions

    monkeypatch.setattr(executions, "EXECUTIONS_FILE", tmp_path / "cron" / "executions.db")
    return executions


class _Clock:
    """A hand-cranked clock so retention is tested as data, never by sleeping."""

    def __init__(self, start: datetime) -> None:
        self.current = start

    def now(self) -> datetime:
        return self.current

    def advance(self, **delta) -> None:
        self.current += timedelta(**delta)


def _install_clock(monkeypatch, executions, start: datetime) -> _Clock:
    clock = _Clock(start)
    monkeypatch.setattr(executions, "_hermes_now", clock.now)
    return clock


def _finish(executions, job_id: str, *, success: bool, error=None) -> dict:
    """Finish one attempt through the real write path - and so run the real prune."""
    record = executions.create_execution(job_id, source="builtin")
    executions.mark_execution_running(record["id"])
    finished = executions.finish_execution(record["id"], success=success, error=error)
    assert finished is not None
    return finished


def _seed_finished_rows(executions, job_id: str, *, count: int, first: datetime, step: timedelta):
    """Seed history in one transaction: this test is about retention, and 1,200 fsynced finishes
    would measure the disk, not the rule."""
    rows = []
    stamp = first
    for _ in range(count):
        rows.append(
            (
                uuid.uuid4().hex,
                job_id,
                "builtin",
                "seed-process",
                os.getpid(),
                "completed",
                stamp.isoformat(),
                stamp.isoformat(),
            )
        )
        stamp += step
    with executions._transaction() as conn:
        conn.executemany(
            "INSERT INTO executions"
            " (id, job_id, source, process_id, pid, status, claimed_at, finished_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            rows,
        )
    return [row[0] for row in rows]


def test_high_frequency_job_burst_cannot_evict_a_quiet_jobs_last_failure(monkeypatch, tmp_path):
    executions = _point_ledger(monkeypatch, tmp_path)
    clock = _install_clock(
        monkeypatch, executions, datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
    )

    clock.advance(days=-3)
    failure = _finish(executions, "nightly-backup", success=False, error="disk quota exceeded")

    # Four figures of churn from one busy job - past the old global cap of 1000 on its own.
    burst_start = clock.now() + timedelta(minutes=1)
    _seed_finished_rows(
        executions,
        "watcher-every-5m",
        count=1200,
        first=burst_start,
        step=timedelta(minutes=1),
    )
    clock.current = burst_start + timedelta(minutes=1200)

    # One more finish through the real path runs the prune the burst would have triggered.
    _finish(executions, "watcher-every-5m", success=True)

    kept = executions.get_execution(failure["id"])
    assert kept is not None, "a busy job's churn evicted another job's last failure"
    assert kept["status"] == "failed"
    assert kept["error"] == "disk quota exceeded"


def test_the_per_job_floor_keeps_the_last_failure_past_the_window(monkeypatch, tmp_path):
    executions = _point_ledger(monkeypatch, tmp_path)
    clock = _install_clock(
        monkeypatch, executions, datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
    )

    clock.advance(days=-90)
    failure = _finish(executions, "weekly-report", success=False, error="SMTP 535 auth failed")

    # Ninety days on, other jobs keep finishing - and keep running the prune that would take it.
    clock.advance(days=90)
    _finish(executions, "watcher-every-5m", success=True)

    kept = executions.get_execution(failure["id"])
    assert kept is not None
    assert kept["error"] == "SMTP 535 auth failed"


def test_rows_past_the_window_and_below_the_floor_are_pruned(monkeypatch, tmp_path):
    executions = _point_ledger(monkeypatch, tmp_path)
    clock = _install_clock(
        monkeypatch, executions, datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
    )
    monkeypatch.setattr(executions, "TERMINAL_RETENTION_PER_JOB", 50)

    anchor = clock.now()
    seeded = _seed_finished_rows(
        executions,
        "hourly-digest",
        count=60,
        first=anchor - timedelta(days=40),
        step=timedelta(minutes=1),
    )
    clock.current = anchor
    fresh = _finish(executions, "hourly-digest", success=True)["id"]

    kept = [row["id"] for row in executions.list_executions(job_id="hourly-digest", limit=500)]
    # The floor is the newest TERMINAL_RETENTION_PER_JOB rows past the window, so all 60 old rows
    # compete for 50 slots and the fresh finish is kept by the window on its own: 51 rows, the
    # oldest 10 of the seeded history gone.
    assert len(kept) == executions.TERMINAL_RETENTION_PER_JOB + 1, len(kept)
    assert fresh in kept
    for pruned in seeded[:10]:
        assert pruned not in kept
    for retained in seeded[-20:]:
        assert retained in kept


def test_a_cold_table_drains_in_bounded_bites(monkeypatch, tmp_path):
    """First prune after an upgrade can owe tens of thousands of deletions; one statement must not
    hold the write lock for them. Each pass deletes at most TERMINAL_PRUNE_BATCH_ROWS and the next
    pass continues, so the backlog drains instead of stalling the ledger."""
    executions = _point_ledger(monkeypatch, tmp_path)
    clock = _install_clock(
        monkeypatch, executions, datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
    )
    monkeypatch.setattr(executions, "TERMINAL_RETENTION_PER_JOB", 10)
    monkeypatch.setattr(executions, "TERMINAL_PRUNE_BATCH_ROWS", 5)

    anchor = clock.now()
    seeded = _seed_finished_rows(
        executions,
        "hourly-digest",
        count=40,
        first=anchor - timedelta(days=40),
        step=timedelta(minutes=1),
    )

    _finish(executions, "hourly-digest", success=True)
    after_one = {row["id"] for row in executions.list_executions(job_id="hourly-digest", limit=500)}
    deleted_one = [row_id for row_id in seeded if row_id not in after_one]
    assert len(deleted_one) == 5, len(deleted_one)

    for _ in range(5):
        _finish(executions, "hourly-digest", success=True)
    remaining = {row["id"] for row in executions.list_executions(job_id="hourly-digest", limit=500)}
    assert len([row_id for row_id in seeded if row_id in remaining]) == 10


def test_a_row_with_no_finish_time_is_kept(monkeypatch, tmp_path):
    executions = _point_ledger(monkeypatch, tmp_path)
    _install_clock(monkeypatch, executions, datetime(2026, 11, 1, 12, 0, tzinfo=UTC))

    record = executions.create_execution("mystery", source="builtin")
    executions.finish_execution(record["id"], success=True)
    with executions._transaction() as conn:
        conn.execute("UPDATE executions SET finished_at=NULL WHERE id=?", (record["id"],))

    _finish(executions, "watcher-every-5m", success=True)

    # An unparseable timestamp is a defect to look at, not a row to delete.
    assert executions.get_execution(record["id"]) is not None
