"""Render GUIDE.md into docs/guide.html (an HTML fragment the site injects into its Guide tab).

    pip install markdown && python scripts/build_guide.py
"""
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parents[1]
html = markdown.markdown((ROOT / "GUIDE.md").read_text(encoding="utf-8"), extensions=["tables", "sane_lists"])
html = html.replace("<table>", '<table class="tbl">')
(ROOT / "docs/guide.html").write_text(html, encoding="utf-8")
print(f"wrote docs/guide.html ({len(html) / 1024:.0f} KB)")
