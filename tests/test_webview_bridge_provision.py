from routes.workspace_routes import _upsert_webview_bridge_tag


def test_webview_bridge_provision_replaces_an_old_localhost_script_url():
    old = (
        '<html><head><script src="http://127.0.0.1:7860/static/js/editor/webview-bridge.js" '
        'data-astercaeser-webview-bridge="1"></script></head><body></body></html>'
    )
    tag = '<script src="http://100.125.58.23:7860/static/js/editor/webview-bridge.js" data-astercaeser-webview-bridge="1"></script>'

    updated, changed = _upsert_webview_bridge_tag(old, tag)

    assert changed is True
    assert tag in updated
    assert "127.0.0.1:7860" not in updated


def test_webview_bridge_provision_inserts_the_bridge_when_missing():
    tag = '<script src="http://100.125.58.23:7860/static/js/editor/webview-bridge.js" data-astercaeser-webview-bridge="1"></script>'

    updated, changed = _upsert_webview_bridge_tag("<html><head></head><body></body></html>", tag)

    assert changed is True
    assert updated == f"<html><head>    {tag}\n</head><body></body></html>"
