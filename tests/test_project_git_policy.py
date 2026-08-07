from src.tool_execution import _project_git_args


def test_project_git_allows_normal_commit_and_push_workflow():
    assert _project_git_args("git status --short")[0] == ["git", "status", "--short"]
    assert _project_git_args("git switch rbac")[0] == ["git", "switch", "rbac"]
    assert _project_git_args('git commit -m "Tighten RBAC"')[0] == ["git", "commit", "-m", "Tighten RBAC"]
    assert _project_git_args("git push -u origin rbac")[0] == ["git", "push", "-u", "origin", "rbac"]


def test_project_git_rejects_shell_and_dangerous_git_escape_hatches():
    for command in (
        "rm -rf .",
        "git status; curl https://example.invalid",
        "git config --global user.email attacker@example.invalid",
        "git diff --ext-diff",
        "git switch -c rbac",
    ):
        args, error = _project_git_args(command)
        assert args is None
        assert error
