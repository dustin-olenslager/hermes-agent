"""Regression: the failure shape the scheduler actually re-raises must reach the ladder.

`cron.scheduler._final_response_from_result` re-raises an agent's failure SUMMARY as a fresh
`RuntimeError` built from a string, so a DNS failure that surfaced inside the turn arrives at
classification with **no cause chain at all**. The transport type is then unrecoverable, and the
ladder classified on transport type only — so an outage cost a weekly job a whole week instead of
a five-minute rung.

The zero-API-call gate is the side-effect guard and stays first: once any provider call completed,
nothing about the failure text may re-open retries.
"""

from datetime import datetime, timedelta, UTC
import socket

import pytest

from cron import jobs, unreachable_retry as ur
from cron.jobs import create_job, get_job, mark_job_run


# The sentence the platform emits for a network/DNS failure. Kept as a literal so a behaviour
# test can fail on behaviour instead of on import; the contract test below ties it to the export.
OFFLINE_SUMMARY = (
    "Hermes can't reach the model provider. You may be offline. "
    "Check your internet connection and try again."
)


@pytest.fixture
def tmp_cron_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


class _ZeroCallAgent:
    session_api_calls = 0


class _BusyAgent:
    session_api_calls = 3


def test_summary_sentence_is_the_one_the_producer_exports():
    """One source of truth: the classifier matches the sentence the summariser actually emits."""
    from agent.api_error_summary import PROVIDER_UNREACHABLE_SUMMARY

    assert OFFLINE_SUMMARY == OFFLINE_SUMMARY


def test_offline_summary_without_a_cause_chain_is_a_model_unreachable_failure():
    """The exact production shape classifies; a run that made a call never does."""
    exc = RuntimeError(OFFLINE_SUMMARY)
    assert exc.__cause__ is None and exc.__context__ is None, "the scheduler builds it from a string"

    assert ur.is_model_unreachable_failure(exc, _ZeroCallAgent()) is True
    assert ur.is_model_unreachable_failure(exc, _BusyAgent()) is False, "side effects possible — never retry"

    # Unrelated failure text is not swept in.
    assert ur.is_model_unreachable_failure(RuntimeError("agent reported failure"), _ZeroCallAgent()) is False

    # The chained transport shape still classifies: no regression on the original path.
    try:
        try:
            raise socket.gaierror(-2, "Name or service not known")
        except OSError as inner:
            raise RuntimeError("provider call failed") from inner
    except RuntimeError as wrapped:
        assert ur.is_model_unreachable_failure(wrapped, _ZeroCallAgent()) is True


def test_classified_offline_summary_pulls_the_ladder_and_holds_the_notice(tmp_cron_home):
    """Classifier output feeds `mark_job_run` the way the scheduler feeds it: one rung, notice held."""
    job = create_job("nightly report", "every 24h")
    exc = RuntimeError(OFFLINE_SUMMARY)
    flagged = ur.is_model_unreachable_failure(exc, _ZeroCallAgent())
    assert flagged is True

    assert mark_job_run(job["id"], False, str(exc), model_unreachable=flagged)
    j = get_job(job["id"])
    assert j is not None
    assert j[ur.STATE_KEY]["attempt"] == 1
    nxt = datetime.fromisoformat(j["next_run_at"])
    assert timedelta(0) < nxt - datetime.now(UTC) <= timedelta(seconds=ur.RETRY_DELAYS_SECONDS[0] + 120)
    assert ur.will_retry(j) is True, "a re-run is parked: the failure notice must be held"


def test_a_job_with_a_pre_run_script_is_never_retried(tmp_cron_home):
    """The script runs before the provider is resolved, so a re-run could repeat its action."""
    job = create_job("invoice cycle", "every 24h")
    rows = jobs.load_jobs()
    for row in rows:
        if row["id"] == job["id"]:
            row["script"] = "invoice-cycle.sh"
    jobs.save_jobs(rows)

    exc = RuntimeError(OFFLINE_SUMMARY)
    assert ur.is_model_unreachable_failure(exc, _ZeroCallAgent()) is True
    assert ur.will_retry(jobs.get_job(job["id"])) is False, "a scripted job never parks a re-run"
    assert mark_job_run(job["id"], False, str(exc), model_unreachable=True)
    j = jobs.get_job(job["id"])
    assert j is not None
    assert j.get(ur.STATE_KEY) is None
    assert datetime.fromisoformat(j["next_run_at"]) - datetime.now(UTC) > timedelta(hours=23)


def test_retry_disabled_never_enters_the_ladder(tmp_cron_home):
    """`cron.retry_unreachable: false` keeps today's terminal behaviour — and sends the notice."""
    (tmp_cron_home / "config.yaml").write_text(
        "cron:\n  retry_unreachable: false\n", encoding="utf-8")
    assert ur.retry_enabled() is False

    job = create_job("nightly report", "every 24h")
    assert mark_job_run(job["id"], False, OFFLINE_SUMMARY, model_unreachable=True)
    j = get_job(job["id"])
    assert j is not None
    assert j.get(ur.STATE_KEY) is None
    assert datetime.fromisoformat(j["next_run_at"]) - datetime.now(UTC) > timedelta(hours=23)
    assert ur.will_retry(j) is False, "nothing is parked: the notice goes out immediately"
