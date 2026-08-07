from pathlib import Path


def test_webview_bridge_trusts_the_exact_origin_that_served_it():
    source = Path("static/js/editor/webview-bridge.js").read_text(encoding="utf-8")

    assert "const bridgeOrigin" in source
    assert "document.currentScript?.src" in source
    assert "url.origin === bridgeOrigin" in source


def test_webview_bridge_sends_structured_visible_page_context():
    source = Path("static/js/editor/webview-bridge.js").read_text(encoding="utf-8")

    assert "function semanticSnapshot()" in source
    assert "headings" in source
    assert "landmarks" in source
    assert "tables" in source
    assert "semantic: semanticSnapshot()" in source
