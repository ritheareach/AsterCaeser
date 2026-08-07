from src.builtin_mcp import builtin_browser_launch_args


def test_builtin_browser_uses_playwright_managed_chromium(monkeypatch, tmp_path):
    """Browser MCP must not depend on an app-installed Google Chrome."""
    monkeypatch.setattr("src.settings.get_setting", lambda key, default=None: (
        True if key == "browser_headless" else str(tmp_path / "profile") if key == "browser_user_data_dir" else default
    ))

    args = builtin_browser_launch_args()

    assert args[:4] == ["-y", "@playwright/mcp@latest", "--browser", "chromium"]
    assert "--headless" in args
    assert args[args.index("--user-data-dir") + 1] == str(tmp_path / "profile")
