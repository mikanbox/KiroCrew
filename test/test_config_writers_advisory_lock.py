"""Converted config writers share the advisory lock, so neither side is lost (#8032).

``update_config_locked`` holds an advisory lock on a ``<path>.lock`` sidecar for
the whole read-modify-write. A writer that instead reads with a bare
``read_config_for_update`` / ``json.loads`` and writes with
``write_config_atomically`` under the in-process asyncio ``_get_config_lock()``
is serialized against same-loop callers ONLY -- not against a holder of the
sidecar, not against a worker thread, and not against another process. Such a
writer and a locked read-modify-write can therefore interleave, and whichever
renames second publishes a document that never saw the other's change.

Each test here drives one converted writer against a locked writer in the
interleave that used to lose data, and asserts BOTH changes survive. They fail on
the pre-conversion shape and pass after it, which is the property that matters:
"holds a lock" is not observable, "did not lose the other writer's setting" is.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from kiro_crew.config import loader as cfg_loader

#: Bounded so a regression fails the test instead of hanging the suite.
_TIMEOUT = 30.0


@pytest.fixture()
def cfg_file(tmp_path: Path) -> Path:
    """A ``config.json`` carrying settings BOTH writers must preserve.

    ``model`` belongs to neither writer, so it is the canary for a whole-document
    clobber; ``session.timeout_secs`` proves a nested section survives.
    """
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            {
                "model": "sonnet",
                "session": {"timeout_secs": 7200},
                "agent": {"apps_trusted": ["zibble-app"], "model": "sonnet"},
            }
        ),
        encoding="utf-8",
    )
    return path


class TestAppsManagerTrustRevoke:
    """``apps.manager._drop_trust_grant`` -- the CLI-side uninstall writer.

    It runs synchronously in the ``kirocrew`` CLI process and in the dashboard's
    ``subprocess_executor()`` worker thread. Neither can take the loop's asyncio
    lock, so the sidecar is the only thing that can serialize it against a
    settings write.
    """

    def test_a_locked_writer_landing_mid_revoke_is_not_lost(
        self, cfg_file: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Two writers, deterministically interleaved: neither may lose the other.

        Writer A is an ordinary locked config write (the shape ``kirocrew config
        set`` and the dashboard settings PATCH both use), suspended inside its
        mutate callback so it is holding the sidecar. Writer B is the trust
        revoke, started while A holds it.

        Before the conversion B took no advisory lock: it read straight away --
        observing the document as it was BEFORE A's write -- and renamed over the
        top, so exactly one of the two changes reached disk depending on who
        renamed last. After it, B waits for the sidecar and re-reads inside its
        own hold, so both land.
        """
        from kiro_crew.apps import manager as appmanager

        monkeypatch.setattr(appmanager, "config_path", lambda: cfg_file)
        monkeypatch.setattr(appmanager, "config_local_path", lambda: cfg_file.parent / "local.json")

        a_holding = threading.Event()
        a_may_finish = threading.Event()
        errors: list[BaseException] = []

        def _settings_write(data: dict) -> dict:
            a_holding.set()
            assert a_may_finish.wait(_TIMEOUT), "test bug: the settings write was never released"
            data.setdefault("session", {})["autocompact_pct"] = 42.0
            return data

        def _writer_a() -> None:
            try:
                cfg_loader.update_config_locked(cfg_file, mutate=_settings_write, stamp_meta=False)
            except BaseException as exc:  # pragma: no cover - surfaced below
                errors.append(exc)

        def _writer_b() -> None:
            try:
                appmanager._drop_trust_grant("zibble-app")
            except BaseException as exc:  # pragma: no cover - surfaced below
                errors.append(exc)

        thread_a = threading.Thread(target=_writer_a, daemon=True)
        thread_b = threading.Thread(target=_writer_b, daemon=True)
        # try/finally: an assertion below would otherwise exit with a writer
        # still parked on the event, leaking it into later tests.
        try:
            thread_a.start()
            assert a_holding.wait(_TIMEOUT), "the settings write never reached its mutate"

            thread_b.start()
            # Give B a chance to reach (or block on) its write before A resumes.
            # A short join, not a bare sleep: it returns as soon as B is done in
            # the unlocked case, and simply times out while B is blocked.
            thread_b.join(timeout=1.0)

            a_may_finish.set()
            thread_a.join(timeout=_TIMEOUT)
            thread_b.join(timeout=_TIMEOUT)
            assert not thread_a.is_alive(), "the settings write did not finish"
            assert not thread_b.is_alive(), "the trust revoke did not finish"
        finally:
            a_may_finish.set()
            for thread in (thread_a, thread_b):
                if thread.is_alive():
                    thread.join(timeout=_TIMEOUT)

        assert not errors, f"writer raised: {errors!r}"

        on_disk = json.loads(cfg_file.read_text(encoding="utf-8"))
        assert on_disk["agent"]["apps_trusted"] == [], (
            "the trust revoke was lost -- the app is still trusted after being "
            "uninstalled, which is the 'uninstalled but still trusted' state the "
            "withdrawal exists to prevent"
        )
        assert on_disk["session"]["autocompact_pct"] == 42.0, (
            "the settings write that landed while the revoke was in flight was "
            "lost -- the revoke does not share the advisory lock"
        )
        # Neither writer owns these, so a whole-document clobber shows up here.
        assert on_disk["model"] == "sonnet"
        assert on_disk["session"]["timeout_secs"] == 7200

    def test_the_revoke_takes_the_sidecar(
        self, cfg_file: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Structural companion: the lock is taken on the sidecar, not the file.

        ``write_config_atomically`` replaces the inode, so a lock on the config
        file's own fd would not serialize against the rename. Asserting the
        sidecar exists pins that the revoke reached the primitive at all, which
        the interleave test above can only show indirectly.
        """
        from kiro_crew.apps import manager as appmanager

        monkeypatch.setattr(appmanager, "config_path", lambda: cfg_file)
        monkeypatch.setattr(appmanager, "config_local_path", lambda: cfg_file.parent / "local.json")

        appmanager._drop_trust_grant("zibble-app")

        assert (cfg_file.parent / "config.json.lock").exists(), (
            "the trust revoke wrote config.json without taking the <config>.lock "
            "sidecar, so it is still unserialized against every other writer"
        )
        assert json.loads(cfg_file.read_text(encoding="utf-8"))["agent"]["apps_trusted"] == []

    def test_an_unreadable_config_refuses_instead_of_resetting(
        self, cfg_file: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Fail-closed is preserved: a corrupt config is refused, never replaced.

        The conversion must not quietly become ``on_corrupt="reset"``. A revoke
        that wrote a single-key document over a truncated config would destroy
        every setting the file holds -- the exact loss ``read_config_for_update``
        exists to prevent -- and the old code raised here for the same reason.
        """
        from kiro_crew.apps import manager as appmanager

        monkeypatch.setattr(appmanager, "config_path", lambda: cfg_file)
        monkeypatch.setattr(appmanager, "config_local_path", lambda: cfg_file.parent / "local.json")
        cfg_file.write_text('{"agent": {"apps_trus', encoding="utf-8")
        before = cfg_file.read_text(encoding="utf-8")

        with pytest.raises(RuntimeError, match="unreadable"):
            appmanager._drop_trust_grant("zibble-app")

        assert (
            cfg_file.read_text(encoding="utf-8") == before
        ), "the unreadable config was overwritten"


class TestSetupWizardWriters:
    """``cli_setup`` -- the widest read-to-write window in the tree.

    A wizard step reads the document to compute a prompt default, then blocks on
    the operator, then writes. Whatever lands during the prompt is inside that
    window, so this family is where a whole-document rewrite is most likely to
    revert a real setting.
    """

    def test_a_write_during_the_prompt_survives_the_slash_command_step(
        self, cfg_file: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The write applies to the document as it stands, not to the pre-prompt read.

        Driven through the prompt itself rather than with threads: the competing
        locked write runs from inside ``_input_or_skip``, i.e. strictly after the
        step's own read and strictly before its write. That is the interleave in
        its exact worst case, with no timing to be flaky about.
        """
        from kiro_crew import cli_setup

        monkeypatch.setattr(cli_setup, "config_path", lambda: cfg_file)

        def _answer_after_a_competing_write(_prompt: str) -> str:
            # Lands while the wizard is between its read and its write.
            cfg_loader.update_config_locked(
                cfg_file,
                mutate=lambda data: {**data, "timezone": "Asia/Shanghai"},
                stamp_meta=False,
            )
            return "zibble-cmd"

        monkeypatch.setattr(cli_setup, "_input_or_skip", _answer_after_a_competing_write)

        cli_setup._setup_slash_command()

        on_disk = json.loads(cfg_file.read_text(encoding="utf-8"))
        assert on_disk["slack"]["command"] == "zibble-cmd", "the wizard's own edit was lost"
        assert on_disk["timezone"] == "Asia/Shanghai", (
            "the config write that landed while the operator was answering was "
            "reverted -- the wizard wrote back its pre-prompt snapshot"
        )
        assert on_disk["model"] == "sonnet"
        assert on_disk["session"]["timeout_secs"] == 7200

    def test_a_write_during_the_prompt_survives_the_timezone_step(
        self, cfg_file: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Same window on the step with the most prompts, hence the widest one."""
        from kiro_crew import cli_setup

        monkeypatch.setattr(cli_setup, "config_path", lambda: cfg_file)

        def _answer_after_a_competing_write(_prompt: str) -> str:
            cfg_loader.update_config_locked(
                cfg_file,
                mutate=lambda data: {**data, "auto_update": True},
                stamp_meta=False,
            )
            return "America/Los_Angeles"

        monkeypatch.setattr(cli_setup, "_input_or_skip", _answer_after_a_competing_write)
        monkeypatch.setattr(cli_setup, "_detect_system_timezone", lambda: "")

        cli_setup._setup_timezone()

        on_disk = json.loads(cfg_file.read_text(encoding="utf-8"))
        assert on_disk["timezone"] == "America/Los_Angeles", "the wizard's own edit was lost"
        assert (
            on_disk["auto_update"] is True
        ), "the config write that landed while the operator was answering was reverted"
        assert on_disk["model"] == "sonnet"
