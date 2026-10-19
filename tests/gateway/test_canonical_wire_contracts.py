"""Canonical RPC validation must not reuse the independently shipped serve wire."""
from dataclasses import asdict
from types import SimpleNamespace

import pytest

from gateway.session_authority import LiveSession, SessionAuthority
from gateway.session_contract import Submission
from gateway.session_controls import AuthorityConnection
from hermes_state import SessionDB
from hermes_state_runtime import begin_runtime_epoch
from tests.gateway.test_session_authority_cancel_settlement import ACTOR, REF, _authority
from tui_gateway.contracts.canonical_sessions import CanonicalPendingAdmission
from tui_gateway.contracts.registry import CANONICAL_METHODS, METHODS, ContractViolation, validate_params


@pytest.mark.asyncio
async def test_canonical_resume_rejects_unknown_keys_and_validates_real_snapshot(tmp_path):
    db = SessionDB(db_path=tmp_path / 'state.db')
    viewer = None
    try:
        db.create_session('s', source='test')
        epoch = begin_runtime_epoch(db, instance_id='test')
        authority = SessionAuthority(SimpleNamespace(), profile_id='test', instance_id='test', db=db, epoch=epoch)
        authority.sessions['s'] = LiveSession(None, 'route')
        viewer = AuthorityConnection(authority, object(), {'user_id': 'human'})
        from gateway.session_group_controls import GROUP_METHODS
        assert set(viewer.handlers()) | set(GROUP_METHODS) | {'profiles.list'} <= set(METHODS) | set(CANONICAL_METHODS)
        refused = await viewer.dispatch({'id': 1, 'method': 'session.resume', 'params': {
            'session_id': 's', 'execution_generaton': 100}})
        assert refused['error']['data']['reason'] == 'invalid_params'
        malformed = await viewer.dispatch({'id': 1, 'method': 'session.resume', 'params': {'session_id': ['s']}})
        assert malformed['error']['data']['reason'] == 'invalid_params'
        assert viewer.subscriptions == {}
        result = await viewer.dispatch({'id': 2, 'method': 'session.resume', 'params': {'session_id': 's'}})
        snapshot = CANONICAL_METHODS['session.resume'].result.model_validate(result['result'])
        assert snapshot.subscription_id == viewer.subscriptions['s']
        assert snapshot.revision == 0 and snapshot.pending == []
        assert snapshot.info.desktop_protocol == 'hermes-gateway-v1'
    finally:
        if viewer is not None:
            await viewer.close()
        db.close()


def test_canonical_admission_and_creation_models_leave_legacy_wire_unchanged():
    canonical = CANONICAL_METHODS['prompt.submit']
    params = {'session_id': 's', 'input_id': 'input', 'text': 'hello', 'finite': True}
    assert validate_params(canonical, params)[1] is None
    assert validate_params(METHODS['prompt.submit'], params)[1] is not None
    legacy_edit = {'session_id': 's', 'text': 'edit', 'truncate_before_row_id': 3, 'confirm_truncate': True}
    assert validate_params(METHODS['prompt.submit'], legacy_edit)[1] is None
    assert validate_params(canonical, legacy_edit)[1] is not None
    assert 'execution_generation' in CANONICAL_METHODS['approval.respond'].params.model_fields
    assert 'execution_generation' not in METHODS['approval.respond'].params.model_fields
    assert CANONICAL_METHODS['session.create'].params.model_validate({'ignore_rules': True}).ignore_rules


@pytest.mark.asyncio
async def test_canonical_result_validation_catches_a_handler_contract_violation(tmp_path, monkeypatch):
    from tui_gateway.contracts import registry
    monkeypatch.setattr(registry, 'STRICT', True)
    db = SessionDB(db_path=tmp_path / 'state.db')
    try:
        authority = SessionAuthority(SimpleNamespace(), profile_id='test', instance_id='test', db=db,
                                     epoch=begin_runtime_epoch(db, instance_id='test'))
        viewer = AuthorityConnection(authority, object(), {'user_id': 'human'})

        async def broken_ping(ref, params):
            return {'not_pong': True}

        monkeypatch.setattr(viewer, 'ping', broken_ping)
        with pytest.raises(ContractViolation, match='ping'):
            await viewer.dispatch({'id': 1, 'method': 'ping', 'params': {}})
    finally:
        db.close()


def _snapshot_with(pending):
    return {'session_id': 's', 'stored_session_id': 's', 'messages': [], 'message_count': 0,
            'running': False, 'authority_epoch': 1, 'replay_epoch': 'epoch', 'last_sequence': 0,
            'subscription_id': 'attached', 'revision': 0, 'execution_generation': 0,
            'pending': pending, 'prompts': [], 'info': {'desktop_protocol': 'hermes-gateway-v1'}}


@pytest.mark.asyncio
async def test_pending_admission_projects_the_bot_author_its_payload_persisted(tmp_path, monkeypatch):
    """A bot's queued message names its author on the queue row, so a viewer need not render it as its own."""
    db, authority = _authority(tmp_path, monkeypatch)
    monkeypatch.setattr(authority, '_schedule', lambda ref: None)
    try:
        with db:
            await authority.submit(ACTOR, Submission(
                request_id='quill', ref=REF, intent='queue',
                payload={'text': 'ping', 'turn_author': {'id': 'bot:quill', 'name': 'Quill', 'is_bot': True}}))
            row = asdict(authority._pending_receipt(authority._pending_rows(REF)[0]))
        assert row['author'] == {'id': 'bot:quill', 'name': 'Quill', 'is_bot': True}
        snapshot = CANONICAL_METHODS['session.resume'].result.model_validate(_snapshot_with([row]))
        assert snapshot.pending[0].author.is_bot is True
        assert snapshot.pending[0].author.name == 'Quill'
    finally:
        db.close()


@pytest.mark.asyncio
async def test_pending_admission_without_a_persisted_author_projects_none(tmp_path, monkeypatch):
    """The viewer's own queued message carries no author stamp and keeps rendering as theirs."""
    db, authority = _authority(tmp_path, monkeypatch)
    monkeypatch.setattr(authority, '_schedule', lambda ref: None)
    try:
        with db:
            await authority.submit(ACTOR, Submission(request_id='human', ref=REF, intent='queue',
                                                     payload={'text': 'plain'}))
            row = asdict(authority._pending_receipt(authority._pending_rows(REF)[0]))
        assert row['author'] is None
        assert CanonicalPendingAdmission.model_validate(row).author is None
    finally:
        db.close()


def test_malformed_pending_payload_projects_no_author(tmp_path, monkeypatch):
    """An unreadable payload, or a non-object author stamp, never drops or raises the queued row."""
    db, authority = _authority(tmp_path, monkeypatch)
    try:
        row = {'admission_id': 'a', 'target_session_id': 's', 'seq': 1, 'status': 'queued',
               'outcome': None, 'owner_epoch': 1, 'generation': None, 'request_id': 'r',
               'payload': '{not json'}
        receipt = authority._pending_receipt(row)
        assert receipt.text == ''
        assert asdict(receipt)['author'] is None
        stamped = authority._pending_receipt(
            {**row, 'payload': {'text': 'x', 'cli_turn_v1': {'turn_author': 'not-an-object'}}})
        assert asdict(stamped)['author'] is None
    finally:
        db.close()
