"""The Main Ratchet Audit must measure every gate, and describe only main.

The audit's concurrency group is keyed on the SHA, so audits for DIFFERENT
commits run concurrently and finish in whatever order their runners take. The
per-commit verdict is exactly what that buys, and it stays sound. The single
tracking issue is not per-commit though -- it is shared mutable state -- so a
run that finishes after a newer push must not write its verdict there:

* A slow **green** run would close the drift record a newer push just opened,
  turning a live ratchet failure on main into no record at all. That is the same
  false all-clear the whole workflow exists to close, arriving through the
  reporter instead of through an empty diff scope.
* A slow **drifting** run would open or refresh a record against a tree that has
  since been fixed, so main reads as dirty when it is clean.

Two further ways the lane could report a verdict that means less than it looks
are pinned at the bottom of this module: a gate ADDED to ``ci.yml`` and not
mirrored here would never be measured on the integrated tree, and a gate step
left on the default ``success()`` condition would skip every later gate as soon
as one drifted.

These are behavioural properties of a shell step, not of its prose, so they are
pinned by running the step itself against a stubbed ``gh``. The alternative --
grepping the workflow for a comparison -- passes on a step that compares the two
SHAs and then closes the issue anyway.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

_REPO_ROOT = Path(__file__).resolve().parents[1]
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "main-ratchet-audit.yml"

_CURRENT = "a" * 40
_NEWER = "b" * 40

# `gh issue list --json number,body` shape: one open issue this workflow owns,
# recognised by the same hidden marker the step filters on.
_MARKER = "<!-- main-ratchet-audit-tracking-issue -->"
_OPEN_ONE = json.dumps([{"number": 4242, "body": f"{_MARKER}\ndrift"}])

_STUB_GH = """#!/usr/bin/env bash
# Records every invocation on ONE line -- an issue body is multi-line, and a
# raw dump would split one call across several log entries -- then answers the
# reads the step performs.
printf '%s\\n' "${*//$'\\n'/<NL>}" >> "$GH_LOG"
case "$1" in
  api)
    if [ "$STUB_HEAD_SHA" = "UNREADABLE" ]; then
      echo "stub: head unreadable" >&2
      exit 1
    fi
    printf '%s\\n' "$STUB_HEAD_SHA"
    ;;
  label) ;;
  issue)
    case "$2" in
      list) printf '%s' "$STUB_OPEN_JSON" ;;
      create) printf 'https://github.example/o/r/issues/4243\\n' ;;
    esac
    ;;
esac
exit 0
"""


def _report_script() -> str:
    """The reporter step's own shell, read out of the workflow."""
    workflow = yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))
    steps = workflow["jobs"]["report"]["steps"]
    runs = [step["run"] for step in steps if "run" in step]
    assert len(runs) == 1, f"expected one run block in the report job, got {len(runs)}"
    return runs[0]


def _run(
    tmp_path: Path,
    *,
    head_sha: str,
    ratchet: str,
    frontend: str = "success",
    open_json: str = _OPEN_ONE,
) -> tuple[int, str, list[str]]:
    """Execute the reporter step with a stubbed ``gh``; return rc, output, calls."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    stub = bin_dir / "gh"
    stub.write_text(_STUB_GH, encoding="utf-8")
    stub.chmod(0o755)
    log = tmp_path / "gh.log"
    log.write_text("", encoding="utf-8")

    env = dict(os.environ)
    env.update(
        {
            "PATH": f"{bin_dir}{os.pathsep}{env['PATH']}",
            "GH_LOG": str(log),
            "STUB_HEAD_SHA": head_sha,
            "STUB_OPEN_JSON": open_json,
            "GH_TOKEN": "stub",
            "REPO": "o/r",
            "SERVER_URL": "https://github.example",
            "RUN_ID": "1",
            "COMMIT_SHA": _CURRENT,
            "RATCHET_RESULT": ratchet,
            "FRONTEND_RESULT": frontend,
        }
    )
    proc = subprocess.run(
        ["bash", "-s"],
        input=_report_script(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=tmp_path,
        env=env,
    )
    calls = [line for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]
    return proc.returncode, proc.stdout + proc.stderr, calls


def _closed_issues(calls: list[str]) -> list[str]:
    return [c for c in calls if c.startswith("issue close")]


def _commented_issues(calls: list[str]) -> list[str]:
    return [c for c in calls if c.startswith("issue comment")]


pytestmark = pytest.mark.skipif(
    shutil.which("jq") is None or shutil.which("bash") is None,
    reason="the reporter step is shell and needs bash + jq, as its runner has",
)


class TestSupersededReporter:
    """A reporter whose commit is no longer main's head leaves the issue alone."""

    def test_a_green_run_at_main_head_closes_the_tracking_issue(self, tmp_path: Path) -> None:
        # The baseline the guard must not break: the self-heal still fires when
        # this commit really is the tree the green verdict describes.
        rc, out, calls = _run(tmp_path, head_sha=_CURRENT, ratchet="success")

        assert rc == 0, out
        assert _closed_issues(calls) == ["issue close 4242 --repo o/r --reason completed"], out

    def test_a_superseded_green_run_does_not_close_newer_drift(self, tmp_path: Path) -> None:
        # The finding itself: a slow green audit for an older commit must not
        # erase the drift record a newer push opened. Losing it means a live
        # ratchet failure on main has no durable artifact at all.
        rc, out, calls = _run(tmp_path, head_sha=_NEWER, ratchet="success")

        assert rc == 0, out
        assert _closed_issues(calls) == [], out
        assert _commented_issues(calls) == [], out

    def test_a_superseded_drifting_run_does_not_touch_the_issue(self, tmp_path: Path) -> None:
        # The other direction of the same class: a stale drift verdict must not
        # refresh a record against a tree that has since been fixed. The run
        # still fails, so the verdict stays visible on its own commit.
        rc, out, calls = _run(tmp_path, head_sha=_NEWER, ratchet="failure")

        assert rc == 1, out
        assert _closed_issues(calls) == [], out
        assert _commented_issues(calls) == [], out
        assert [c for c in calls if c.startswith("issue create")] == [], out

    def test_a_drifting_run_at_main_head_still_refreshes_the_issue(self, tmp_path: Path) -> None:
        # The baseline for the drift branch: the guard must not have disarmed
        # the lane's actual job of recording drift on the current head.
        rc, out, calls = _run(tmp_path, head_sha=_CURRENT, ratchet="failure")

        assert rc == 1, out
        assert len(_commented_issues(calls)) == 1, out
        assert "Still drifting" in _commented_issues(calls)[0], out


class TestUnreadableHead:
    """An unknown head resolves toward keeping drift VISIBLE, in both branches."""

    def test_an_unreadable_head_still_records_drift(self, tmp_path: Path) -> None:
        # Failing the other way would let one transient API error swallow a
        # drift record entirely -- a likelier loss than the race being guarded.
        rc, out, calls = _run(tmp_path, head_sha="UNREADABLE", ratchet="failure")

        assert rc == 1, out
        assert len(_commented_issues(calls)) == 1, out

    def test_an_unreadable_head_declines_to_close_on_green(self, tmp_path: Path) -> None:
        # The opposite default, for the opposite risk: an unconfirmed head must
        # not authorise closing a record, because that loss is not recoverable
        # by the next run, whereas a record left open closes on the next green
        # push. The two branches disagree deliberately.
        rc, out, calls = _run(tmp_path, head_sha="UNREADABLE", ratchet="success")

        assert rc == 0, out
        assert _closed_issues(calls) == [], out


class TestConvergenceStaysExempt:
    """Duplicate reconciliation is ordering-independent, so it is not guarded."""

    def test_a_superseded_run_still_collapses_a_split_record(self, tmp_path: Path) -> None:
        # Closing a redundant copy while keeping the lowest-numbered one can
        # never remove the last record, so a superseded run may still self-heal
        # the split that the per-SHA concurrency group makes possible.
        two_open = json.dumps(
            [
                {"number": 4242, "body": f"{_MARKER}\ndrift"},
                {"number": 4250, "body": f"{_MARKER}\ndrift"},
            ]
        )
        rc, out, calls = _run(tmp_path, head_sha=_NEWER, ratchet="success", open_json=two_open)

        assert rc == 0, out
        closed = _closed_issues(calls)
        assert closed == ["issue close 4250 --repo o/r --reason not planned"], out


class TestIssueBodyRendering:
    """The durable artifact is the most-read output, so its Markdown must render."""

    def test_the_created_body_carries_no_literal_backslashes(self, tmp_path: Path) -> None:
        # The body is built by a single-quoted printf, where a backslash-escaped
        # backtick is NOT unescaped by bash and reaches the issue verbatim.
        rc, out, calls = _run(tmp_path, head_sha=_CURRENT, ratchet="failure", open_json="[]")

        assert rc == 1, out
        created = [c for c in calls if c.startswith("issue create")]
        assert len(created) == 1, out
        assert "\\`" not in created[0], created[0]
        assert f"tree at `{_CURRENT}`" in created[0], created[0]


class TestGateParityWithCi:
    """A gate added to ci.yml must not go unmeasured on main's integrated tree."""

    # Gate scripts ci.yml's backend-lint runs that this lane deliberately does
    # NOT, each of which needs a reason recorded here. Empty: the audit mirrors
    # backend-lint's whole ratchet set. An entry is how a future author records
    # "measured on PRs only, on purpose" in a reviewed diff, instead of the
    # omission being invisible.
    _DELIBERATE_OMISSIONS: frozenset[str] = frozenset()

    @staticmethod
    def _gate_scripts(job: dict) -> set[str]:
        found = set()
        for step in job["steps"]:
            found.update(re.findall(r"scripts/(check_[A-Za-z0-9_]+\.py)", step.get("run") or ""))
        return found

    def test_the_audit_runs_every_backend_lint_gate(self) -> None:
        # The silent direction: a renamed script errors its step loudly, but a
        # gate ADDED to ci.yml and not mirrored here just never runs on main --
        # and its drift then surfaces on an unrelated PR, which is #7511's
        # failure mode reproduced for every future gate.
        ci = yaml.safe_load((_REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text("utf-8"))
        audit = yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))

        expected = self._gate_scripts(ci["jobs"]["backend-lint"]) - self._DELIBERATE_OMISSIONS
        actual = self._gate_scripts(audit["jobs"]["ratchet-gates"])

        assert expected <= actual, (
            "ci.yml backend-lint runs ratchet gate(s) the Main Ratchet Audit does not: "
            f"{sorted(expected - actual)}. Mirror the step into ratchet-gates, or record "
            "why main does not need it in _DELIBERATE_OMISSIONS. An unmirrored gate is "
            "never measured on main's integrated tree."
        )


class TestEveryGateReports:
    """One drifting gate must not skip the gates after it."""

    def test_gate_steps_do_not_stop_at_the_first_failure(self) -> None:
        # A step defaults to `if: success()`, so the first drifting gate would
        # skip the rest and the run would name only the gate that happens to be
        # listed first -- a partial verdict that looks like a full one, for as
        # long as that one drift stayed unfixed. The PR that adds this lane
        # already expects black to be the first drift on main, so the default
        # would leave the other gates unmeasured indefinitely.
        audit = yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))
        steps = audit["jobs"]["ratchet-gates"]["steps"]

        gate_steps = [s for s in steps if "scripts/check_" in (s.get("run") or "")]
        gate_steps += [s for s in steps if "pytest" in (s.get("run") or "")]
        assert gate_steps, "found no gate steps to check"

        for step in gate_steps:
            condition = str(step.get("if", "")).replace(" ", "")
            assert "!cancelled()" in condition, (
                f"gate step {step.get('name')!r} runs on the default success() "
                "condition, so an earlier drifting gate skips it and its own drift "
                "goes unmeasured"
            )
